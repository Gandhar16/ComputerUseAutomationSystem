import { test } from "node:test";
import assert from "node:assert/strict";
import { PolicyEngine, PolicyViolationError, RiskyActionError } from "../src/safety/policy.js";

const CFG = {
  allowedOrigins: ["http://localhost:4173"],
  allowedActions: ["navigate", "click", "type"],
  riskyRules: [{
    id: "confirm-submit",
    description: "submit on confirm page",
    match: { action: "click", urlPathPattern: "/confirm" },
  }],
  sensitiveParamNames: ["password", "ssn"],
  redactInputTypes: ["password"],
};

test("allows in-policy actions", () => {
  const p = new PolicyEngine(CFG);
  p.checkAction({ verb: "click" }, "http://localhost:4173/members");
  p.checkAction({ verb: "navigate", value: "http://localhost:4173/login" }, "about:blank");
});

test("blocks action verbs outside the allowlist", () => {
  const p = new PolicyEngine(CFG);
  assert.throws(() => p.checkAction({ verb: "select" }, "http://localhost:4173/"), PolicyViolationError);
});

test("blocks navigation to a non-allowlisted origin", () => {
  const p = new PolicyEngine(CFG);
  assert.throws(
    () => p.checkAction({ verb: "navigate", value: "https://evil.example.com/x" }, "http://localhost:4173/"),
    PolicyViolationError,
  );
});

test("blocks any action while ON a non-allowlisted origin", () => {
  const p = new PolicyEngine(CFG);
  assert.throws(() => p.checkAction({ verb: "click" }, "https://elsewhere.example.com/"), PolicyViolationError);
});

test("risky rule blocks by default; permitOnce allows exactly one action", () => {
  const p = new PolicyEngine(CFG);
  const url = "http://localhost:4173/member/1/subaccount/confirm";
  assert.throws(() => p.checkAction({ verb: "click" }, url), RiskyActionError);
  p.permitOnce("confirm-submit");
  p.checkAction({ verb: "click" }, url); // consumed
  assert.throws(() => p.checkAction({ verb: "click" }, url), RiskyActionError);
});

test("risky rule matches only its action verb and path", () => {
  const p = new PolicyEngine(CFG);
  p.checkAction({ verb: "type" }, "http://localhost:4173/member/1/subaccount/confirm");
  p.checkAction({ verb: "click" }, "http://localhost:4173/members");
});

test("sensitive param name detection is substring, case-insensitive", () => {
  const p = new PolicyEngine(CFG);
  assert.equal(p.isSensitiveParam("userPassword"), true);
  assert.equal(p.isSensitiveParam("SSN"), true);
  assert.equal(p.isSensitiveParam("memberId"), false);
});
