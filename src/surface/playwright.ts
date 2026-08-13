import { chromium, type Browser, type Locator, type Page } from "playwright";
import type {
  AgentAction, DetectPredicate, LocatorCandidate, Observation, ObservedElement,
  Surface, TargetDescriptor,
} from "./types.js";
import type { PolicyEngine } from "../safety/policy.js";
import type { ControlGate } from "../escalation/control.js";
import { isCredentialRef, resolveCredential } from "../safety/redact.js";

/** Raw element facts collected in-page; candidates are derived from these. */
interface RawElement {
  ref: string;
  tag: string;
  type: string;
  role: string;
  name: string;
  text: string;
  id: string;
  nameAttr: string;
  tdLabel: string;
  cssPath: string;
  enabled: boolean;
}

const GENERATED_ID = /^(ctl\d+|.*_(txt|btn|ddl|lbl|chk)\w*\d*|id\d+|__.+)$/i;

export function candidatesFor(el: RawElement): LocatorCandidate[] {
  const out: LocatorCandidate[] = [];
  if (el.role === "text") {
    // non-interactive data cell (extraction target): anchor to its label cell
    // first — that survives id churn — then id, then structure.
    if (el.tdLabel && el.tag === "td") {
      out.push({
        strategy: "css", value: `td:text-is(${JSON.stringify(el.tdLabel)}) + td`,
        note: "Value cell anchored to its row label text — survives id churn; breaks only if the label wording changes.",
      });
    }
    if (el.id) {
      out.push({
        strategy: "attr", value: `#${CSS_escape(el.id)}`,
        note: GENERATED_ID.test(el.id)
          ? "Control id looks framework-generated — low trust."
          : "Stable-looking element id.",
      });
    }
    if (el.cssPath) {
      out.push({ strategy: "css", value: el.cssPath, note: "Structural path — brittle last resort." });
    }
    return out;
  }
  // Only emit a role+name candidate when the name is a REAL accessible name.
  // Legacy form fields get their display name from the row label cell, which
  // the accessibility engine cannot see — a role candidate built from it would
  // never resolve and would just burn a fallback on every replay.
  const nameIsAccessible = !(["input", "select", "textarea"].includes(el.tag) && el.name === el.tdLabel);
  if (el.role && el.name && nameIsAccessible) {
    out.push({
      strategy: "role", value: `${el.role}::${el.name}`,
      note: "Accessible role+name — most stable across markup changes and reskins; also portable to a desktop accessibility surface.",
    });
  }
  if (el.tdLabel && ["input", "select", "textarea"].includes(el.tag)) {
    out.push({
      strategy: "tdlabel", value: el.tdLabel,
      note: "Legacy table-form pattern: control anchored to its row's label-cell text. Survives id churn; breaks only if the label wording changes.",
    });
  }
  if (el.text && (el.tag === "a" || el.tag === "button")) {
    out.push({ strategy: "text", value: el.text, note: "Exact visible text — stable while copy is stable." });
  }
  if (el.nameAttr) {
    out.push({
      strategy: "attr", value: `[name="${el.nameAttr}"]`,
      note: "Form field name — server-side apps rarely rename these (they are the POST contract).",
    });
  }
  if (el.id) {
    const generated = GENERATED_ID.test(el.id);
    out.push({
      strategy: "attr", value: `#${CSS_escape(el.id)}`,
      note: generated
        ? "Control id looks framework-generated (ASP.NET-style) — can shift when the page structure changes; low trust."
        : "Stable-looking element id.",
    });
  }
  if (el.cssPath) {
    out.push({ strategy: "css", value: el.cssPath, note: "Structural path — brittle last resort; used only if everything above fails." });
  }
  return out;
}

function CSS_escape(s: string): string {
  return s.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
}

export class PlaywrightWebSurface implements Surface {
  private browser!: Browser;
  page!: Page;

  constructor(
    private policy: PolicyEngine,
    private gate: ControlGate,
    private opts: { headed?: boolean } = {},
  ) {}

  async start(): Promise<void> {
    this.browser = await chromium.launch({ headless: !this.opts.headed });
    this.page = await this.browser.newPage({ viewport: { width: 1180, height: 800 } });
    this.page.setDefaultTimeout(5000);
  }

  currentUrl(): string {
    return this.page.url();
  }

  async goto(url: string): Promise<void> {
    this.policy.checkAction({ verb: "navigate", value: url }, url);
    this.gate.assertAutomationMayAct();
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
  }

  async observe(): Promise<Observation> {
    await this.page.waitForLoadState("domcontentloaded");
    const raw = await this.page.evaluate(snapshotScript) as { title: string; text: string; elements: RawElement[] };
    const elements: ObservedElement[] = raw.elements.map((el) => ({
      ref: el.ref, role: el.role, name: el.name || el.text || el.tdLabel, tag: el.tag,
      enabled: el.enabled, candidates: candidatesFor(el),
    }));
    return { url: this.page.url(), title: raw.title, text: raw.text, elements };
  }

  async act(action: AgentAction): Promise<void> {
    this.policy.checkAction(action, this.page.url());
    this.gate.assertAutomationMayAct();
    const verb = action.verb;
    if (verb === "navigate") {
      await this.page.goto(action.value!, { waitUntil: "domcontentloaded" });
      return;
    }
    if (!action.target) throw new Error(`Action '${verb}' requires a target`);
    const loc = await this.resolve(action.target);
    if (!loc) throw new TargetNotFoundError(action.target);
    switch (verb) {
      case "click":
      case "dismiss": {
        // Legacy pages navigate on click; wait for either navigation or settle.
        await Promise.all([
          this.page.waitForLoadState("domcontentloaded").catch(() => {}),
          loc.click(),
        ]);
        await this.page.waitForLoadState("domcontentloaded").catch(() => {});
        break;
      }
      case "type": {
        // credential refs ({{credential:x}}) resolve from env only here, at act
        // time — the real value never enters prompts, artifacts, or logs.
        const v = action.value ?? "";
        await loc.fill(isCredentialRef(v) ? resolveCredential(v) : v);
        break;
      }
      case "select":
        // accept either the option value or its visible label
        try {
          await loc.selectOption({ label: action.value ?? "" });
        } catch {
          await loc.selectOption(action.value ?? "");
        }
        break;
      case "extract":
        break; // reads are done via read()
    }
  }

  async read(target: TargetDescriptor): Promise<string | null> {
    const loc = await this.resolve(target);
    if (!loc) return null;
    const txt = await loc.textContent().catch(() => null);
    return txt?.trim() ?? null;
  }

  async matches(p: DetectPredicate): Promise<boolean> {
    switch (p.kind) {
      case "text": {
        const body = await this.page.textContent("body").catch(() => "");
        return (body ?? "").includes(p.value);
      }
      case "selector":
        return (await this.page.locator(p.value).count().catch(() => 0)) > 0;
      case "urlPath":
        // exact match: substring matching would make shallow paths ("/") vacuous
        return new URL(this.page.url()).pathname === p.value;
    }
  }

  async screenshot(filePath: string): Promise<void> {
    await this.page.screenshot({ path: filePath, fullPage: true }).catch(() => {});
  }

  /**
   * Resolve a TargetDescriptor to a live element by trying locator candidates
   * in ranked order. Returns the first candidate that yields a visible match.
   */
  async resolve(target: TargetDescriptor): Promise<Locator | null> {
    for (const c of target.candidates) {
      const loc = this.candidateToLocator(c);
      if (!loc) continue;
      try {
        const first = loc.first();
        await first.waitFor({ state: "visible", timeout: 1500 });
        return first;
      } catch {
        // try next candidate
      }
    }
    return null;
  }

  /** Which candidate actually resolved (for evidence/drift logging). */
  async resolveWithInfo(target: TargetDescriptor): Promise<{ loc: Locator; used: LocatorCandidate } | null> {
    for (const c of target.candidates) {
      const loc = this.candidateToLocator(c);
      if (!loc) continue;
      try {
        const first = loc.first();
        await first.waitFor({ state: "visible", timeout: 1500 });
        return { loc: first, used: c };
      } catch { /* next */ }
    }
    return null;
  }

  private candidateToLocator(c: LocatorCandidate): Locator | null {
    switch (c.strategy) {
      case "role": {
        const idx = c.value.indexOf("::");
        if (idx < 0) return null;
        const role = c.value.slice(0, idx) as Parameters<Page["getByRole"]>[0];
        const name = c.value.slice(idx + 2);
        return this.page.getByRole(role, { name, exact: false });
      }
      case "tdlabel":
        // control in the cell adjacent to the label cell. (`tr:has(...)` would
        // also match ancestor layout rows in nested-table markup and resolve
        // the wrong control — sibling anchoring keeps it to the actual row.)
        return this.page.locator(
          `td:text-is(${JSON.stringify(c.value)}) + td :is(input:not([type=hidden]), select, textarea)`,
        );
      case "text":
        return this.page.getByText(c.value, { exact: true });
      case "attr":
      case "css":
        return this.page.locator(c.value);
    }
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => {});
  }
}

export class TargetNotFoundError extends Error {
  constructor(public target: TargetDescriptor) {
    super(`No locator candidate resolved for target: ${target.description}`);
  }
}

/**
 * In-page snapshot: collects interactive elements with the raw facts needed
 * to build ranked locator candidates. Shipped as a source STRING (not a
 * function) because tsx/esbuild injects `__name` helper calls into compiled
 * functions, which do not exist inside the browser page.
 */
const snapshotScript = `(() => {
  const visible = (e) => {
    const r = e.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const st = getComputedStyle(e);
    return st.visibility !== "hidden" && st.display !== "none";
  };
  const roleOf = (e) => {
    const tag = e.tagName.toLowerCase();
    const type = (e.type || "").toLowerCase();
    if (e.getAttribute("role")) return e.getAttribute("role");
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      if (["submit", "button", "image", "reset"].includes(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      return "textbox";
    }
    return "";
  };
  const tdLabelOf = (e) => {
    const td = e.closest("td");
    const tr = e.closest("tr");
    if (!td || !tr) return "";
    let prev = td.previousElementSibling;
    while (prev) {
      const t = (prev.textContent || "").trim();
      if (t) return t;
      prev = prev.previousElementSibling;
    }
    return "";
  };
  const accessibleName = (e) => {
    const aria = e.getAttribute("aria-label");
    if (aria) return aria.trim();
    const id = e.id;
    if (id) {
      const lab = document.querySelector('label[for="' + id + '"]');
      if (lab && lab.textContent) return lab.textContent.trim();
    }
    const tag = e.tagName.toLowerCase();
    const type = (e.type || "").toLowerCase();
    if (tag === "input" && ["submit", "button", "reset"].includes(type)) {
      return (e.value || "").trim();
    }
    if (tag === "a" || tag === "button") return (e.textContent || "").trim();
    const ph = e.getAttribute("placeholder");
    if (ph) return ph.trim();
    return tdLabelOf(e); // legacy fallback: row label text as the name
  };
  const cssPath = (e) => {
    const parts = [];
    let cur = e;
    while (cur && cur.tagName.toLowerCase() !== "body" && parts.length < 8) {
      const tag = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (!parent) break;
      const sibs = Array.from(parent.children).filter((s) => s.tagName === cur.tagName);
      const idx = sibs.indexOf(cur) + 1;
      parts.unshift(sibs.length > 1 ? tag + ":nth-of-type(" + idx + ")" : tag);
      cur = parent;
    }
    return "body > " + parts.join(" > ");
  };

  const sel = "a[href], button, input:not([type=hidden]), select, textarea";
  const els = Array.from(document.querySelectorAll(sel)).filter(visible);
  const elements = els.slice(0, 60).map((e, i) => ({
    ref: "e" + (i + 1),
    tag: e.tagName.toLowerCase(),
    type: (e.type || "").toLowerCase(),
    role: roleOf(e),
    name: accessibleName(e),
    text: (e.tagName.toLowerCase() === "a" || e.tagName.toLowerCase() === "button")
      ? (e.textContent || "").trim() : "",
    id: e.id || "",
    nameAttr: e.getAttribute("name") || "",
    tdLabel: tdLabelOf(e),
    cssPath: cssPath(e),
    enabled: !e.disabled,
  }));
  // Non-interactive data-bearing cells (extraction targets): leaf td/span/b
  // with short text — either labeled by the preceding cell or carrying an id.
  const isInteractive = (e) => e.closest && (e.matches(sel) || e.querySelector(sel));
  const dataEls = Array.from(document.querySelectorAll("td, span, b"))
    .filter(visible)
    .filter((e) => !isInteractive(e))
    .filter((e) => e.children.length === 0)
    .map((e) => ({ e, text: (e.textContent || "").trim(), label: tdLabelOf(e) }))
    .filter((d) => d.text && d.text.length <= 120 && (d.label || d.e.id))
    .slice(0, 30);
  dataEls.forEach((d, i) => {
    elements.push({
      ref: "e" + (els.length + i + 1),
      tag: d.e.tagName.toLowerCase(),
      type: "",
      role: "text",
      name: (d.label ? d.label + " " : "") + d.text,
      text: d.text,
      id: d.e.id || "",
      nameAttr: "",
      tdLabel: d.label,
      cssPath: cssPath(d.e),
      enabled: true,
    });
  });
  const text = (document.body.innerText || "").replace(/\\n{3,}/g, "\\n\\n").slice(0, 2000);
  return { title: document.title, text, elements };
})()`;
