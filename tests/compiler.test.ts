import { test } from "node:test";
import assert from "node:assert/strict";
import { compileArtifact, type TraceStep } from "../src/artifact/compiler.js";
import { CapabilityArtifactSchema } from "../src/artifact/schema.js";
import type { TargetDescriptor } from "../src/surface/types.js";

const target = (desc: string): TargetDescriptor => ({
  description: desc,
  candidates: [{ strategy: "attr", value: "#x" }],
});

const BASE = "http://localhost:4173";

function sampleTrace(): TraceStep[] {
  return [
    { action: { verb: "navigate", value: `${BASE}/login` }, urlBefore: "about:blank", urlAfter: `${BASE}/login`, titleAfter: "Sign On" },
    { action: { verb: "type", target: target("member field"), value: "12345" }, urlBefore: `${BASE}/members`, urlAfter: `${BASE}/members`, titleAfter: "Search" },
    { action: { verb: "click", target: target("View link") }, urlBefore: `${BASE}/members`, urlAfter: `${BASE}/member/12345`, titleAfter: "Detail" },
    { action: { verb: "extract", target: target("balance cell") }, urlBefore: `${BASE}/member/12345`, urlAfter: `${BASE}/member/12345`, titleAfter: "Detail" },
    // post-goal wandering that must be truncated:
    { action: { verb: "click", target: target("Sign Off") }, urlBefore: `${BASE}/member/12345`, urlAfter: `${BASE}/login`, titleAfter: "Sign On" },
  ];
}

function compile(trace = sampleTrace()) {
  return compileArtifact({
    id: "test-cap", name: "Test", description: "test capability", appId: "legacycu",
    runId: "run-1", entryUrl: `${BASE}/login`, params: { memberId: "12345" },
    trace,
    extracts: [{ name: "balance", description: "the balance", target: target("balance cell") }],
  });
}

test("compiled artifacts validate against the schema", () => {
  CapabilityArtifactSchema.parse(compile());
});

test("literal param values are lifted to placeholders in values and checkpoints", () => {
  const a = compile();
  const typeStep = a.steps.find((s) => s.verb === "type")!;
  assert.equal(typeStep.value, "{{memberId}}");
  const navClick = a.steps.find((s) => s.verb === "click")!;
  assert.equal(navClick.checkpoint!.predicates[0]!.value, "/member/{{memberId}}");
});

test("steps after the last extract are truncated (post-goal wandering)", () => {
  const a = compile();
  assert.ok(!a.steps.some((s) => s.description.includes("Sign Off")));
  assert.equal(a.successCondition.predicates[0]!.value, "/member/{{memberId}}");
});

test("extract actions become outputs, not steps", () => {
  const a = compile();
  assert.equal(a.outputs.length, 1);
  assert.equal(a.outputs[0]!.name, "balance");
  assert.ok(!a.steps.some((s) => (s.verb as string) === "extract"));
});

test("checkpoints only appear on steps that navigated", () => {
  const a = compile();
  const typeStep = a.steps.find((s) => s.verb === "type")!;
  assert.equal(typeStep.checkpoint, undefined);
});

test("risky trace steps are flagged and artifacts start as draft", () => {
  const trace = sampleTrace();
  trace[2]!.riskyRuleId = "confirm-page-submit";
  const a = compile(trace);
  assert.equal(a.steps.find((s) => s.verb === "click")!.risky, true);
  assert.equal(a.capability.reviewStatus, "draft");
});

test("app-profile knowledge (outcomes, interstitials) is merged in", () => {
  const a = compile();
  assert.ok(a.expectedOutcomes.some((o) => o.code === "MEMBER_NOT_FOUND"));
  assert.ok(a.knownInterstitials.length > 0);
});
