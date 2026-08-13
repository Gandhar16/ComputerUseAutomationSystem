import fs from "node:fs";
import path from "node:path";
import type { AgentAction, TargetDescriptor } from "../surface/types.js";
import { lift } from "./template.js";
import type { CapabilityArtifact, Param, Output, Step } from "./schema.js";

/** One executed action from a successful discovery run. */
export interface TraceStep {
  action: AgentAction;
  urlBefore: string;
  urlAfter: string;
  titleAfter: string;
  riskyRuleId?: string;
}

export interface AppProfile {
  appId: string;
  name: string;
  expectedOutcomes: { code: string; description: string; detect: { kind: "text" | "selector" | "urlPath"; value: string } }[];
  knownInterstitials: { id: string; description: string; detect: { kind: "text" | "selector" | "urlPath"; value: string }; dismiss: { action: "click"; selector: string } }[];
  recoverable?: Record<string, { detect: { kind: "text" | "selector" | "urlPath"; value: string }; strategy: string }>;
}

export function loadAppProfile(appId: string): AppProfile {
  const file = path.resolve("config", "app-profiles", `${appId}.json`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as AppProfile;
}

/**
 * Compile a successful discovery trace into a capability artifact:
 *  - lift literal param values into {{param}} placeholders,
 *  - derive per-step checkpoints from observed navigation,
 *  - merge app-profile knowledge (expected outcomes, interstitials, recoverables).
 * The raw model transcript stays in evidence; the artifact is decoupled from it.
 */
export function compileArtifact(opts: {
  id: string;
  name: string;
  description: string;
  appId: string;
  runId: string;
  entryUrl: string;
  params: Record<string, string>;
  paramDescriptions?: Record<string, string>;
  trace: TraceStep[];
  extracts: { name: string; description: string; target: TargetDescriptor }[];
}): CapabilityArtifact {
  const { params } = opts;
  const profile = loadAppProfile(opts.appId);

  const inputs: Param[] = Object.keys(params).map((name) => ({
    name,
    type: /^\d+(\.\d+)?$/.test(params[name]!) ? "number" as const : "string" as const,
    description: opts.paramDescriptions?.[name] ?? `Input parameter '${name}' observed during discovery.`,
    required: true,
    sensitive: false,
  }));

  const outputs: Output[] = opts.extracts.map((e) => ({
    name: e.name,
    type: "string",
    description: e.description,
    source: { description: e.target.description, candidates: e.target.candidates },
  }));

  // The capability ends where its outputs were read: drop trailing steps after
  // the last extract (post-goal wandering, e.g. "return to member record",
  // would navigate replay away from the screen the outputs live on).
  const lastExtract = opts.trace.map((t) => t.action.verb).lastIndexOf("extract");
  const trace = lastExtract >= 0 ? opts.trace.slice(0, lastExtract + 1) : opts.trace;

  const steps: Step[] = [];
  let idx = 0;
  for (const t of trace) {
    const a = t.action;
    if (a.verb === "extract") continue; // extraction is modeled as outputs, not steps
    const sensitive = !!a.redact;
    const value = a.value === undefined ? undefined
      : sensitive ? a.value            // credential refs stay as refs; never lift/expand
      : lift(a.value, params);
    const navigated = pathOf(t.urlAfter) !== pathOf(t.urlBefore);
    steps.push({
      index: idx++,
      verb: a.verb as Step["verb"],
      description: describe(a),
      target: a.target ? { description: a.target.description, candidates: a.target.candidates } : undefined,
      value,
      sensitive,
      risky: !!t.riskyRuleId,
      checkpoint: navigated ? {
        description: `Landed on ${lift(pathOf(t.urlAfter), params)} ("${t.titleAfter}")`,
        predicates: [{ kind: "urlPath", value: lift(pathOf(t.urlAfter), params) }],
      } : undefined,
    });
  }

  const last = trace[trace.length - 1];
  return {
    schemaVersion: "1.0",
    capability: {
      id: opts.id,
      name: opts.name,
      version: 1,
      description: opts.description,
      appId: opts.appId,
      createdAt: new Date().toISOString(),
      createdFromRun: opts.runId,
      reviewStatus: "draft",
    },
    entry: { url: lift(opts.entryUrl, params) },
    inputs,
    outputs,
    steps,
    successCondition: {
      description: `Reached final screen ${last ? lift(pathOf(last.urlAfter), params) : ""} and all declared outputs were extracted.`,
      predicates: [{ kind: "urlPath", value: last ? lift(pathOf(last.urlAfter), params) : "/" }],
    },
    expectedOutcomes: profile.expectedOutcomes,
    knownInterstitials: profile.knownInterstitials,
    recoverables: profile.recoverable?.sessionExpired ? [{
      id: "session-expired",
      description: "Session timed out mid-flow; restart from the beginning (login steps re-authenticate).",
      detect: profile.recoverable.sessionExpired.detect,
      strategy: "restart",
      maxAttempts: 1,
    }] : [],
    limits: { stepTimeoutMs: 8000, transientRetries: 1 },
  };
}

function pathOf(url: string): string {
  try { return new URL(url).pathname; } catch { return url; }
}

function describe(a: AgentAction): string {
  switch (a.verb) {
    case "navigate": return `Navigate to ${a.value}`;
    case "click": return `Click ${a.target?.description ?? "element"}`;
    case "dismiss": return `Dismiss ${a.target?.description ?? "dialog"}`;
    case "type": return `Type into ${a.target?.description ?? "field"}${a.redact ? " (sensitive)" : ""}`;
    case "select": return `Select "${a.value}" in ${a.target?.description ?? "dropdown"}`;
    default: return a.verb;
  }
}
