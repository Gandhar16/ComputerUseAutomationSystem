import express from "express";
import fs from "node:fs";
import path from "node:path";
import type { Server } from "node:http";
import type { Page } from "playwright";
import { ControlGate } from "./control.js";
import type { RunLogger } from "../evidence/logger.js";

export interface InterventionRequest {
  capabilityId: string;
  goal: string;
  stepIndex: number;
  stepDescription: string;
  reason: string;
  screenshot: string;
}

const OPERATOR_PORT = 4600;

/**
 * Human-in-the-loop handoff.
 *
 * Mechanism: the automation and the human share the SAME live browser session
 * (the headed Playwright window). On escalation the ControlGate flips to
 * HUMAN — the Surface rejects any automated action while it is not in
 * AUTOMATION — and a minimal operator page (the mocked operator console)
 * presents the intervention context. The human works directly in the live
 * window; their clicks/inputs are captured and appended to evidence. When
 * they press "Hand control back", the gate flips through RESUMING back to
 * AUTOMATION and the replay engine re-verifies state before continuing.
 */
export class EscalationManager {
  constructor(
    private gate: ControlGate,
    private logger: RunLogger,
    private page: Page,
  ) {}

  async escalate(req: InterventionRequest): Promise<"completed_by_human" | "abandoned"> {
    this.logger.log("intervention.raised", { ...req });
    this.gate.escalate();
    await this.installHumanActionCapture();

    const server = await this.serveOperatorConsole(req);
    console.log(`\n🧑‍💼 HUMAN INTERVENTION REQUIRED`);
    console.log(`   Reason: ${req.reason}`);
    console.log(`   1. Review context at  http://localhost:${OPERATOR_PORT}/`);
    console.log(`   2. Complete the step manually in the automation browser window`);
    console.log(`   3. Click "Hand control back" on the operator page\n`);

    await this.gate.waitForHandBack();
    server.close();
    this.logger.log("intervention.handback", {});
    await this.page.waitForLoadState("domcontentloaded").catch(() => {});
    this.gate.resumed();
    this.logger.log("intervention.resumed", { url: this.page.url() });
    return "completed_by_human";
  }

  /** Record what the human does in the live session while they hold control. */
  private async installHumanActionCapture(): Promise<void> {
    const record = (data: unknown) => {
      if (this.gate.current === "HUMAN") this.logger.log("human.action", { data });
    };
    await this.page.exposeBinding("__reportHumanAction", (_src, data) => record(data)).catch(() => {});
    const capture = () => this.page.evaluate(() => {
      const w = window as unknown as { __reportHumanAction?: (d: unknown) => void; __capInstalled?: boolean };
      if (w.__capInstalled || !w.__reportHumanAction) return;
      w.__capInstalled = true;
      const describe = (e: Element) => ({
        tag: e.tagName.toLowerCase(),
        id: (e as HTMLElement).id || undefined,
        name: e.getAttribute("name") || undefined,
        text: (e.textContent || (e as HTMLInputElement).value || "").trim().slice(0, 60) || undefined,
      });
      // mousedown, not click: it fires before a form submit starts navigating,
      // so the report reaches the host before the page is torn down
      document.addEventListener("mousedown", (ev) => {
        const t = ev.target as Element | null;
        if (t) w.__reportHumanAction!({ kind: "click", target: describe(t), url: location.href });
      }, true);
      document.addEventListener("change", (ev) => {
        const t = ev.target as HTMLInputElement | null;
        if (!t) return;
        const sensitive = t.type === "password";
        w.__reportHumanAction!({
          kind: "change", target: describe(t), url: location.href,
          value: sensitive ? "•••REDACTED•••" : String(t.value).slice(0, 60),
        });
      }, true);
    }).catch(() => {});
    await capture();
    this.page.on("domcontentloaded", () => { void capture(); }); // re-arm across navigations
    // host-side navigation trail — cannot be lost to page teardown races
    this.page.on("framenavigated", (frame) => {
      if (frame === this.page.mainFrame() && this.gate.current === "HUMAN") {
        this.logger.log("human.navigation", { url: frame.url() });
      }
    });
  }

  /** Minimal operator console (deliberately bare — the mechanism, not the UI, is the point). */
  private serveOperatorConsole(req: InterventionRequest): Promise<Server> {
    const app = express();
    app.get("/", (_q, res) => {
      res.send(`<!DOCTYPE html><html><head><title>Operator Console — Intervention</title>
<style>body{font-family:system-ui;margin:2rem;max-width:760px}dt{font-weight:600}dd{margin:0 0 .6rem}
img{max-width:100%;border:1px solid #ccc}button{font-size:1rem;padding:.5rem 1.2rem;background:#0a6;color:#fff;border:0;border-radius:4px;cursor:pointer}</style></head>
<body><h2>⚠ Intervention request</h2>
<dl>
<dt>Capability</dt><dd>${esc(req.capabilityId)} — ${esc(req.goal)}</dd>
<dt>Stopped at step</dt><dd>#${req.stepIndex}: ${esc(req.stepDescription)}</dd>
<dt>Why it stopped</dt><dd>${esc(req.reason)}</dd>
<dt>Control state</dt><dd>HUMAN — you own the live session. Automation is locked out until you hand back.</dd>
</dl>
<p>Complete the step in the automation browser window, then:</p>
<form method="post" action="/handback"><button>✅ Hand control back to automation</button></form>
<h3>Screen at escalation</h3><img src="/screenshot" alt="screenshot at escalation">
</body></html>`);
    });
    app.get("/screenshot", (_q, res) => {
      const p = path.resolve(req.screenshot);
      if (fs.existsSync(p)) res.sendFile(p); else res.status(404).end();
    });
    app.post("/handback", (_q, res) => {
      res.send(`<body style="font-family:system-ui;margin:2rem"><h3>Control returned to automation. You can close this tab.</h3></body>`);
      this.gate.handBack();
    });
    return new Promise((resolve) => {
      const server = app.listen(OPERATOR_PORT, () => resolve(server));
    });
  }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}
