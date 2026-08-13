import type OpenAI from "openai";
import readline from "node:readline/promises";
import { LlmClient } from "./llm.js";
import type { Observation, ObservedElement, Surface, TargetDescriptor } from "../surface/types.js";
import type { RunLogger } from "../evidence/logger.js";
import { PolicyEngine, RiskyActionError } from "../safety/policy.js";
import { isCredentialRef } from "../safety/redact.js";
import type { TraceStep } from "../artifact/compiler.js";

export interface DiscoveryResult {
  success: boolean;
  summary: string;
  trace: TraceStep[];
  extracts: { name: string; description: string; target: TargetDescriptor; value: string | null }[];
}

const MAX_STEPS = 25;

const SYSTEM_PROMPT = `You are a computer-use agent operating a legacy bank back-office web application on behalf of a credit union. You see a snapshot of the current screen (its text and its interactive elements, each with a ref like e3) and you decide ONE next action at a time.

Rules:
- Work strictly toward the stated goal. Do not explore unrelated screens.
- If credentials are needed, type the literal placeholder strings given to you (e.g. {{credential:username}}, {{credential:password}}). The system substitutes real values; you never see them.
- Use the provided input parameter values where the flow needs them.
- When the goal asks you to read/extract data, use the "extract" verb with the element ref that contains the value and the output name you were given.
- When the goal is fully achieved, reply with verb "done" and a summary.
- If you cannot make progress (unexpected error screen, missing permissions, dead end), reply with verb "stuck" and explain why.

Reply with ONLY a JSON object, no prose, matching:
{"thought": "...", "action": {"verb": "click|type|select|navigate|extract|done|stuck", "ref": "eN", "value": "...", "name": "outputName", "summary": "..."}}
- click: needs ref. type: needs ref + value. select: needs ref + value (visible option label). navigate: needs value (URL). extract: needs ref + name. done/stuck: needs summary.`;

export async function runDiscovery(opts: {
  goal: string;
  entryUrl: string;
  params: Record<string, string>;
  outputs: Record<string, string>; // name -> description
  surface: Surface;
  logger: RunLogger;
  policy: PolicyEngine;
  interactive?: boolean;
}): Promise<DiscoveryResult> {
  const { goal, entryUrl, params, outputs, surface, logger, policy } = opts;
  const llm = new LlmClient();
  const trace: TraceStep[] = [];
  const extracts: DiscoveryResult["extracts"] = [];
  const history: string[] = [];

  logger.log("discovery.start", { goal, entryUrl, params, model: llm.model });
  await surface.goto(entryUrl);
  trace.push({
    action: { verb: "navigate", value: entryUrl },
    urlBefore: "about:blank", urlAfter: surface.currentUrl(), titleAfter: "",
  });

  for (let step = 1; step <= MAX_STEPS; step++) {
    const obs = await surface.observe();
    await logger.screenshot(surface, `step${step}-observe`);
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: renderTurn(goal, params, outputs, obs, history) },
    ];
    const { decision } = await llm.decide(messages);
    const a = decision.action;
    logger.log("agent.decision", { step, thought: decision.thought, action: a });

    if (a.verb === "done") {
      logger.log("discovery.done", { summary: a.summary ?? "" });
      await logger.screenshot(surface, `step${step}-final`);
      return { success: true, summary: a.summary ?? "goal achieved", trace, extracts };
    }
    if (a.verb === "stuck") {
      logger.log("discovery.stuck", { reason: a.summary ?? "" });
      await logger.screenshot(surface, `step${step}-stuck`);
      return { success: false, summary: a.summary ?? "agent reported stuck", trace, extracts };
    }

    const el = a.ref ? obs.elements.find((e) => e.ref === a.ref) : undefined;
    if (a.verb !== "navigate" && !el) {
      history.push(`step ${step}: INVALID — ref ${a.ref} does not exist on the current screen`);
      continue;
    }

    if (a.verb === "extract") {
      const target = toTarget(el!);
      const value = await surface.read(target);
      const name = a.name ?? `output${extracts.length + 1}`;
      extracts.push({ name, description: outputs[name] ?? name, target, value });
      logger.log("agent.extract", { name, value });
      history.push(`step ${step}: extracted ${name} = "${value}"`);
      continue;
    }

    const sensitive = isCredentialRef(a.value) || el?.tag === "input" && /password/i.test(el.name);
    const action = {
      verb: a.verb,
      target: el ? toTarget(el) : undefined,
      value: a.value,
      redact: sensitive,
    } as const;

    const urlBefore = surface.currentUrl();
    try {
      await surface.act(action);
    } catch (err) {
      if (err instanceof RiskyActionError) {
        const ok = await confirmRisky(err, opts.interactive ?? true, logger);
        if (ok) {
          policy.permitOnce(err.ruleId);
          await surface.act(action);
        } else {
          logger.log("discovery.stuck", { reason: `risky action not approved: ${err.ruleId}` });
          return { success: false, summary: `risky action '${err.ruleId}' was not approved`, trace, extracts };
        }
      } else {
        logger.log("agent.action_error", { step, error: String(err) });
        await logger.screenshot(surface, `step${step}-error`);
        history.push(`step ${step}: ACTION FAILED (${a.verb} on ${a.ref}): ${String(err)}`);
        continue;
      }
    }
    const obsAfter = await surface.observe();
    trace.push({
      action, urlBefore, urlAfter: obsAfter.url, titleAfter: obsAfter.title,
      riskyRuleId: policy.classifyRisky(action, urlBefore)?.id,
    });
    history.push(`step ${step}: ${a.verb}${el ? ` on "${el.name}"` : ""}${a.value && !sensitive ? ` value="${a.value}"` : ""} -> now at ${obsAfter.url}`);
    logger.log("agent.acted", { step, verb: a.verb, target: el?.name, urlAfter: obsAfter.url });
  }

  logger.log("discovery.max_steps", { maxSteps: MAX_STEPS });
  return { success: false, summary: `did not reach goal within ${MAX_STEPS} steps`, trace, extracts };
}

function toTarget(el: ObservedElement): TargetDescriptor {
  return {
    description: `'${el.name}' (${el.role || el.tag})`,
    candidates: el.candidates,
  };
}

function renderTurn(
  goal: string,
  params: Record<string, string>,
  outputs: Record<string, string>,
  obs: Observation,
  history: string[],
): string {
  const els = obs.elements
    .map((e) => `  ${e.ref} [${e.role || e.tag}] ${JSON.stringify(e.name)}${e.enabled ? "" : " (disabled)"}`)
    .join("\n");
  const paramLines = Object.entries(params).map(([k, v]) => `  ${k} = ${JSON.stringify(v)}`).join("\n") || "  (none)";
  const outputLines = Object.entries(outputs).map(([k, v]) => `  ${k}: ${v}`).join("\n") || "  (none)";
  return `GOAL: ${goal}

INPUT PARAMETERS (use these values where the flow needs them):
${paramLines}

OUTPUTS TO EXTRACT (verb "extract", with the output name):
${outputLines}

CREDENTIALS (type these literal placeholders if a login is required):
  username field -> {{credential:username}}
  password field -> {{credential:password}}

PREVIOUS ACTIONS:
${history.length ? history.map((h) => "  " + h).join("\n") : "  (none yet)"}

CURRENT SCREEN:
  URL: ${obs.url}
  Title: ${obs.title}
  Interactive elements:
${els}

  Page text (truncated):
---
${obs.text}
---

Decide the single next action. Reply with ONLY the JSON object.`;
}

async function confirmRisky(err: RiskyActionError, interactive: boolean, logger: { log: (e: string, d?: Record<string, unknown>) => void }): Promise<boolean> {
  logger.log("policy.risky_detected", { ruleId: err.ruleId, description: err.description });
  if (!interactive) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = await rl.question(`\n⚠ RISKY ACTION: ${err.description}\n  Approve this action? [y/N] `);
  rl.close();
  const ok = ans.trim().toLowerCase().startsWith("y");
  logger.log("policy.risky_decision", { ruleId: err.ruleId, approved: ok });
  return ok;
}
