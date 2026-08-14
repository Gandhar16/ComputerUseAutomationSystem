/**
 * Discovery loop stop conditions, tested with a scripted decision-maker and a
 * fake surface — no API key, no browser. The LLM itself is nondeterministic
 * and deliberately untested; its CONTRACT (the decision schema and the loop's
 * reaction to each decision) is what these pin down.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { runDiscovery, type DecisionMaker } from "../src/agent/loop.js";
import type { Decision } from "../src/agent/llm.js";
import type { Observation, Surface } from "../src/surface/types.js";
import { PolicyEngine } from "../src/safety/policy.js";
import { RunLogger } from "../src/evidence/logger.js";

const CFG = {
  allowedOrigins: ["http://fake.test"],
  allowedActions: ["navigate", "click", "type", "select", "extract", "dismiss"],
  riskyRules: [], sensitiveParamNames: [], redactInputTypes: [],
};

function fakeSurface(): Surface {
  const obs: Observation = {
    url: "http://fake.test/page", title: "Fake",
    text: "a page",
    elements: [{ ref: "e1", role: "button", name: "Go", tag: "button", enabled: true, candidates: [{ strategy: "css", value: "#go" }] }],
  };
  return {
    goto: async () => {}, observe: async () => obs, act: async () => {},
    read: async () => "value", resolveWithInfo: async () => null,
    matches: async () => false, screenshot: async () => {}, currentUrl: () => obs.url,
    close: async () => {},
  };
}

function scripted(decisions: Decision["action"][]): DecisionMaker {
  let i = 0;
  return {
    model: "scripted-fake",
    decide: async () => ({
      decision: { thought: "", action: decisions[Math.min(i++, decisions.length - 1)]! },
      raw: "",
    }),
  };
}

function harness(decisions: Decision["action"][]) {
  return runDiscovery({
    goal: "test goal", entryUrl: "http://fake.test/page", params: {}, outputs: {},
    surface: fakeSurface(),
    logger: new RunLogger("discovery", path.join(os.tmpdir(), "cap-automation-test-evidence")),
    policy: new PolicyEngine(CFG),
    llm: scripted(decisions),
  });
}

test("'done' ends discovery successfully with the summary", async () => {
  const r = await harness([{ verb: "done", summary: "all good" }]);
  assert.equal(r.success, true);
  assert.equal(r.summary, "all good");
});

test("'stuck' ends discovery unsuccessfully — the escalation trigger", async () => {
  const r = await harness([{ verb: "stuck", summary: "cannot find the form" }]);
  assert.equal(r.success, false);
  assert.match(r.summary, /cannot find the form/);
});

test("actions on nonexistent refs are rejected and the loop hits max steps, not an infinite run", async () => {
  const r = await harness([{ verb: "click", ref: "e999" }]);
  assert.equal(r.success, false);
  assert.match(r.summary, /40 steps/);
});

test("extract reads the target and records a deduplicated output", async () => {
  const r = await harness([
    { verb: "extract", ref: "e1", name: "field" },
    { verb: "extract", ref: "e1", name: "field" }, // duplicate name — must not double
    { verb: "done", summary: "finished" },
  ]);
  assert.equal(r.success, true);
  assert.equal(r.extracts.length, 1);
  assert.equal(r.extracts[0]!.value, "value");
});
