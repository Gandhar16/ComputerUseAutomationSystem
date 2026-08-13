import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AgentAction } from "../surface/types.js";

const PolicyConfig = z.object({
  allowedOrigins: z.array(z.string()),
  allowedActions: z.array(z.string()),
  riskyRules: z.array(z.object({
    id: z.string(),
    description: z.string(),
    match: z.object({
      action: z.string().optional(),
      urlPathPattern: z.string().optional(),
    }),
  })),
  sensitiveParamNames: z.array(z.string()),
  redactInputTypes: z.array(z.string()),
});
export type PolicyConfig = z.infer<typeof PolicyConfig>;

export class PolicyViolationError extends Error {
  constructor(msg: string) { super(`Policy violation: ${msg}`); }
}

export class RiskyActionError extends Error {
  constructor(public ruleId: string, public description: string) {
    super(`Risky action blocked by rule '${ruleId}': ${description}`);
  }
}

/**
 * Single choke point for allowlist enforcement. The Surface calls
 * checkAction() before every act, for BOTH discovery and replay —
 * neither the model nor the replay engine can bypass it.
 */
export class PolicyEngine {
  /** one-shot permits for risky rules (set after human confirmation / approved-artifact check) */
  private oneShotPermits = new Set<string>();

  constructor(private cfg: PolicyConfig) {}

  /** Allow the next action matching this risky rule to proceed (consumed on use). */
  permitOnce(ruleId: string): void { this.oneShotPermits.add(ruleId); }

  static load(file = path.resolve("config/policy.json")): PolicyEngine {
    return new PolicyEngine(PolicyConfig.parse(JSON.parse(fs.readFileSync(file, "utf8"))));
  }

  get config(): PolicyConfig { return this.cfg; }

  checkAction(action: Pick<AgentAction, "verb" | "value">, currentUrl: string): void {
    if (!this.cfg.allowedActions.includes(action.verb)) {
      throw new PolicyViolationError(`action type '${action.verb}' is not in the allowlist`);
    }
    const urlToCheck = action.verb === "navigate" ? action.value ?? "" : currentUrl;
    if (urlToCheck && urlToCheck !== "about:blank") {
      const origin = safeOrigin(urlToCheck);
      if (!origin || !this.cfg.allowedOrigins.includes(origin)) {
        throw new PolicyViolationError(`origin '${origin ?? urlToCheck}' is not in the allowlist`);
      }
    }
    const risky = this.classifyRisky(action, currentUrl);
    if (risky) {
      if (this.oneShotPermits.has(risky.id)) {
        this.oneShotPermits.delete(risky.id);
      } else {
        throw new RiskyActionError(risky.id, risky.description);
      }
    }
  }

  classifyRisky(action: Pick<AgentAction, "verb" | "value">, currentUrl: string):
    { id: string; description: string } | null {
    for (const rule of this.cfg.riskyRules) {
      const m = rule.match;
      if (m.action && m.action !== action.verb) continue;
      if (m.urlPathPattern) {
        const p = safePath(currentUrl);
        if (!p || !p.includes(m.urlPathPattern)) continue;
      }
      return { id: rule.id, description: rule.description };
    }
    return null;
  }

  isSensitiveParam(name: string): boolean {
    const n = name.toLowerCase();
    return this.cfg.sensitiveParamNames.some((s) => n.includes(s));
  }
}

function safeOrigin(url: string): string | null {
  try { return new URL(url).origin; } catch { return null; }
}
function safePath(url: string): string | null {
  try { return new URL(url).pathname; } catch { return null; }
}
