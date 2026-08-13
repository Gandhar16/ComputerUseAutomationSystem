import type { CapabilityArtifact, Checkpoint, Step } from "../artifact/schema.js";
import { render } from "../artifact/template.js";
import type { Surface } from "../surface/types.js";
import { PlaywrightWebSurface, TargetNotFoundError } from "../surface/playwright.js";
import type { RunLogger } from "../evidence/logger.js";
import { PolicyEngine, RiskyActionError } from "../safety/policy.js";
import type { EscalationManager } from "../escalation/handoff.js";

/**
 * Result contract for a replay. The three-way split is deliberate:
 *  - success:          the capability did its job; outputs attached.
 *  - business_outcome: a legitimate result of the business flow the CALLER
 *                      must branch on ("no such member" is an answer, not a crash).
 *  - failure:          the automation itself broke — with step, expected vs.
 *                      observed, and a screenshot for debugging.
 *  - escalated:        a human was brought in; their resolution is recorded.
 * Recoverable conditions (known interstitials, transient slowness, session
 * expiry) are handled inside the run and logged, not surfaced as results.
 */
export type ReplayResult =
  | { status: "success"; runId: string; outputs: Record<string, string> }
  | { status: "business_outcome"; runId: string; code: string; description: string }
  | { status: "failure"; runId: string; stepIndex: number; stepDescription: string; expected: string; observed: string; screenshot: string }
  | { status: "escalated"; runId: string; stepIndex: number; reason: string; resolution: "completed_by_human" | "abandoned"; outputs?: Record<string, string> };

export async function replay(opts: {
  artifact: CapabilityArtifact;
  params: Record<string, string>;
  surface: PlaywrightWebSurface;
  logger: RunLogger;
  policy: PolicyEngine;
  escalation?: EscalationManager; // present => escalation path enabled (headed browser)
}): Promise<ReplayResult> {
  const { artifact: a, params, surface, logger, policy } = opts;
  const runId = logger.runId;

  // ---- validate inputs against the declared contract ----
  for (const p of a.inputs) {
    if (p.required && params[p.name] === undefined) {
      return fail(0, "input validation", `required param '${p.name}'`, "missing", "");
    }
    if (p.type === "number" && params[p.name] !== undefined && !/^\d+(\.\d+)?$/.test(params[p.name]!)) {
      return fail(0, "input validation", `param '${p.name}' of type number`, `'${params[p.name]}'`, "");
    }
  }
  logger.log("replay.start", { capability: a.capability.id, version: a.capability.version, params: redactParams(a, params) });

  let restartsLeft = Math.max(0, ...a.recoverables.map((r) => r.maxAttempts));

  restart: while (true) {
    await surface.goto(render(a.entry.url, params));

    for (const step of a.steps) {
      const res = await runStep(step);
      if (res === "ok") continue;
      if (res === "restart") {
        if (restartsLeft-- > 0) { logger.log("replay.restart", { atStep: step.index }); continue restart; }
        return fail(step.index, step.description, "recoverable condition within retry budget", "restart budget exhausted", await shot("restart-exhausted"));
      }
      return res; // terminal ReplayResult
    }

    // ---- success condition + outputs ----
    const okFinal = await checkpointHolds(a.successCondition);
    if (!okFinal) {
      const outcome = await detectOutcome();
      if (outcome) return outcome;
      return fail(a.steps.length, "success condition", describeCheckpoint(a.successCondition), `url=${surface.currentUrl()}`, await shot("success-cond-failed"));
    }
    const outputs: Record<string, string> = {};
    for (const out of a.outputs) {
      const v = await surface.read(out.source);
      if (v === null) {
        return fail(a.steps.length, `extract output '${out.name}'`, `readable value at ${out.source.description}`, "target not found", await shot(`output-${out.name}-missing`));
      }
      outputs[out.name] = v;
    }
    await shot("final");
    logger.log("replay.success", { outputs });
    return { status: "success", runId, outputs };
  }

  // ---------- helpers ----------

  async function runStep(step: Step): Promise<"ok" | "restart" | ReplayResult> {
    await sweepInterstitials(step.index);

    if (step.risky) {
      if (a.capability.reviewStatus !== "approved") {
        if (opts.escalation) return escalate(step.index, `Risky step requires human approval (artifact is '${a.capability.reviewStatus}', not 'approved'): ${step.description}`);
        return fail(step.index, step.description, "artifact reviewStatus=approved for unattended risky step", a.capability.reviewStatus, await shot(`step${step.index}-risky-blocked`));
      }
      const risky = policy.classifyRisky({ verb: step.verb, value: step.value }, surface.currentUrl());
      if (risky) {
        policy.permitOnce(risky.id);
        logger.log("policy.risky_permitted", { stepIndex: step.index, ruleId: risky.id, basis: "artifact approved by review" });
      }
    }

    for (let attempt = 0; attempt <= a.limits.transientRetries; attempt++) {
      try {
        await performAction(step);
      } catch (err) {
        if (err instanceof RiskyActionError) {
          return fail(step.index, step.description, "action within policy", `blocked by rule '${err.ruleId}'`, await shot(`step${step.index}-policy`));
        }
        if (err instanceof TargetNotFoundError) {
          // Maybe an error/outcome screen replaced the expected one — check before calling it drift.
          const outcome = await detectOutcome();
          if (outcome) return outcome;
          if (await handleRecoverable()) return "restart";
          if (attempt < a.limits.transientRetries) { logger.log("replay.retry", { stepIndex: step.index, reason: "target not found" }); continue; }
          if (opts.escalation) return escalate(step.index, `Target not found: ${step.target?.description}`);
          return fail(step.index, step.description, `locatable target: ${step.target?.description}`, "no locator candidate resolved", await shot(`step${step.index}-notfound`));
        }
        throw err;
      }

      await sweepInterstitials(step.index);

      // Business outcomes can legitimately appear after any action.
      const outcome = await detectOutcome();
      if (outcome) { await shot(`step${step.index}-outcome`); return outcome; }
      if (await handleRecoverable()) return "restart";

      if (!step.checkpoint) { logStep(step, "ok (no checkpoint)"); return "ok"; }
      if (await checkpointHolds(step.checkpoint)) { logStep(step, "checkpoint ok"); return "ok"; }

      if (attempt < a.limits.transientRetries) {
        logger.log("replay.retry", { stepIndex: step.index, reason: "checkpoint not met" });
        continue;
      }
      if (opts.escalation) return escalate(step.index, `Checkpoint failed: ${describeCheckpoint(step.checkpoint)}`);
      return fail(step.index, step.description, describeCheckpoint(step.checkpoint), `url=${surface.currentUrl()}`, await shot(`step${step.index}-checkpoint`));
    }
    return "ok"; // unreachable
  }

  async function performAction(step: Step): Promise<void> {
    const value = step.value !== undefined ? render(step.value, params) : undefined;
    if (step.verb === "navigate") {
      await surface.goto(value!);
      return;
    }
    // Log which locator candidate resolves — a non-primary hit is a drift signal.
    if (step.target) {
      const info = await surface.resolveWithInfo(step.target);
      if (info && info.used !== step.target.candidates[0]) {
        logger.log("replay.locator_fallback", {
          stepIndex: step.index, target: step.target.description,
          used: info.used.strategy, primary: step.target.candidates[0]?.strategy,
          note: "primary locator did not resolve — possible UI drift; review artifact",
        });
      }
    }
    await surface.act({
      verb: step.verb,
      target: step.target,
      value: step.sensitive ? step.value : value, // credential refs resolve inside the surface
      redact: step.sensitive,
    });
  }

  async function checkpointHolds(cp: Checkpoint): Promise<boolean> {
    const deadline = Date.now() + a.limits.stepTimeoutMs;
    while (Date.now() < deadline) {
      let all = true;
      for (const p of cp.predicates) {
        if (!(await surface.matches({ ...p, value: render(p.value, params) }))) { all = false; break; }
      }
      if (all) return true;
      await sleep(250);
    }
    return false;
  }

  async function detectOutcome(): Promise<ReplayResult | null> {
    for (const o of a.expectedOutcomes) {
      if (await surface.matches(o.detect)) {
        logger.log("replay.business_outcome", { code: o.code, description: o.description });
        await shot(`outcome-${o.code}`);
        return { status: "business_outcome", runId, code: o.code, description: o.description };
      }
    }
    return null;
  }

  async function handleRecoverable(): Promise<boolean> {
    for (const r of a.recoverables) {
      if (await surface.matches(r.detect)) {
        logger.log("replay.recoverable", { id: r.id, strategy: r.strategy, description: r.description });
        return r.strategy === "restart";
      }
    }
    return false;
  }

  async function sweepInterstitials(stepIndex: number): Promise<void> {
    for (const i of a.knownInterstitials) {
      if (await surface.matches(i.detect)) {
        logger.log("replay.interstitial_dismissed", { id: i.id, stepIndex, description: i.description });
        await shot(`interstitial-${i.id}`);
        await surface.act({
          verb: "dismiss",
          target: { description: `dismiss control for interstitial '${i.id}'`, candidates: [{ strategy: "css", value: i.dismiss.selector }] },
        });
      }
    }
  }

  async function escalate(stepIndex: number, reason: string): Promise<ReplayResult> {
    const screenshot = await shot(`step${stepIndex}-escalate`);
    const resolution = await opts.escalation!.escalate({
      capabilityId: a.capability.id,
      goal: a.capability.description,
      stepIndex,
      stepDescription: a.steps[stepIndex]?.description ?? "(final)",
      reason,
      screenshot,
    });
    if (resolution === "completed_by_human") {
      // Human may have completed the remaining flow; verify and extract.
      if (await checkpointHolds(a.successCondition)) {
        const outputs: Record<string, string> = {};
        for (const out of a.outputs) {
          const v = await surface.read(out.source);
          if (v !== null) outputs[out.name] = v;
        }
        logger.log("replay.resumed_success_after_human", { outputs });
        return { status: "escalated", runId, stepIndex, reason, resolution, outputs };
      }
    }
    return { status: "escalated", runId, stepIndex, reason, resolution };
  }

  function logStep(step: Step, note: string) {
    logger.log("replay.step", { stepIndex: step.index, verb: step.verb, description: step.description, note });
  }

  async function shot(label: string): Promise<string> {
    return logger.screenshot(surface, label);
  }

  function fail(stepIndex: number, stepDescription: string, expected: string, observed: string, screenshot: string): ReplayResult {
    logger.log("replay.failure", { stepIndex, stepDescription, expected, observed, screenshot });
    return { status: "failure", runId, stepIndex, stepDescription, expected, observed, screenshot };
  }
}

function redactParams(a: CapabilityArtifact, params: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    out[k] = a.inputs.find((i) => i.name === k)?.sensitive ? "•••REDACTED•••" : v;
  }
  return out;
}

function describeCheckpoint(cp: Checkpoint): string {
  return `${cp.description} [${cp.predicates.map((p) => `${p.kind}:${p.value}`).join(" AND ")}]`;
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
