/**
 * Integration: the deterministic replay engine against the live target app.
 * Hosts LegacyCU in-process (or reuses one already listening on :4173) and
 * drives a real Chromium via the same code paths as `npm run replay`.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { startTargetApp } from "../target-app/server.js";
import { loadArtifact } from "../src/artifact/store.js";
import { PolicyEngine } from "../src/safety/policy.js";
import { ControlGate } from "../src/escalation/control.js";
import { PlaywrightWebSurface } from "../src/surface/playwright.js";
import { RunLogger } from "../src/evidence/logger.js";
import { replay } from "../src/replay/engine.js";

process.env.TARGET_USERNAME = "demo";
process.env.TARGET_PASSWORD = "demo123";

let server: Server | undefined;
const EVIDENCE_TMP = path.join(os.tmpdir(), "cap-automation-test-evidence");

before(async () => {
  try {
    server = await startTargetApp();
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    // a dev instance is already serving :4173 — use it
  }
});

after(() => { server?.close(); });

async function run(params: Record<string, string>, artifactId = "lookup-member-balance") {
  const policy = PolicyEngine.load();
  const surface = new PlaywrightWebSurface(policy, new ControlGate(), { headed: false });
  const logger = new RunLogger("replay", EVIDENCE_TMP);
  try {
    await surface.start();
    const result = await replay({
      artifact: loadArtifact(artifactId),
      params, surface, logger, policy,
    });
    return { result, logDir: logger.dir };
  } finally {
    logger.close();
    await surface.close();
  }
}

test("replays the discovered artifact with a different param and extracts the output", async () => {
  const { result } = await run({ memberId: "34567" });
  assert.equal(result.status, "success");
  assert.equal((result as { outputs: Record<string, string> }).outputs.savingsBalance, "$18,204.66");
});

test("reports a missing member as a business outcome, not a failure", async () => {
  const { result } = await run({ memberId: "99999" });
  assert.equal(result.status, "business_outcome");
  assert.equal((result as { code: string }).code, "MEMBER_NOT_FOUND");
});

test("rejects invocations missing required params before touching the UI", async () => {
  const { result } = await run({});
  assert.equal(result.status, "failure");
  assert.match((result as { expected: string }).expected, /memberId/);
});

test("stale primary locator: replay succeeds via fallback AND logs the drift signal", async () => {
  const { result, logDir } = await run({ memberId: "34567" }, "tests/fixtures/lookup-member-balance-drifted.json");
  assert.equal(result.status, "success");
  assert.equal((result as { outputs: Record<string, string> }).outputs.savingsBalance, "$18,204.66");
  const log = fs.readFileSync(path.join(logDir, "run.jsonl"), "utf8");
  const drift = log.split("\n").filter((l) => l.includes("replay.locator_fallback"));
  assert.equal(drift.length, 1, "exactly one drift warning for the one stale primary");
  assert.match(drift[0]!, /"used":"attr"/);
});
