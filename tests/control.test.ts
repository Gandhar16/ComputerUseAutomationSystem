import { test } from "node:test";
import assert from "node:assert/strict";
import { ControlGate } from "../src/escalation/control.js";

test("full handoff cycle: AUTOMATION -> HUMAN -> RESUMING -> AUTOMATION", () => {
  const g = new ControlGate();
  assert.equal(g.current, "AUTOMATION");
  g.escalate();
  assert.equal(g.current, "HUMAN");
  g.handBack();
  assert.equal(g.current, "RESUMING");
  g.resumed();
  assert.equal(g.current, "AUTOMATION");
});

test("automation cannot act unless state is AUTOMATION", () => {
  const g = new ControlGate();
  g.assertAutomationMayAct(); // ok
  g.escalate();
  assert.throws(() => g.assertAutomationMayAct(), /HUMAN/);
  g.handBack();
  assert.throws(() => g.assertAutomationMayAct(), /RESUMING/);
});

test("invalid transitions are rejected", () => {
  const g = new ControlGate();
  assert.throws(() => g.handBack(), /Invalid control transition/);
  assert.throws(() => g.resumed(), /Invalid control transition/);
  g.escalate();
  assert.throws(() => g.escalate(), /Invalid control transition/);
});

test("waitForHandBack resolves when the human hands back", async () => {
  const g = new ControlGate();
  g.escalate();
  const wait = g.waitForHandBack();
  g.handBack();
  await wait; // must resolve
});
