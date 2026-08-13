import { test } from "node:test";
import assert from "node:assert/strict";
import { isCredentialRef, resolveCredential, scrubKnownSecrets, MASK } from "../src/safety/redact.js";

test("isCredentialRef recognizes only exact credential refs", () => {
  assert.equal(isCredentialRef("{{credential:username}}"), true);
  assert.equal(isCredentialRef("{{memberId}}"), false);
  assert.equal(isCredentialRef("plain text"), false);
  assert.equal(isCredentialRef(undefined), false);
});

test("resolveCredential reads TARGET_* env vars", () => {
  process.env.TARGET_USERNAME = "demo";
  assert.equal(resolveCredential("{{credential:username}}"), "demo");
});

test("scrubKnownSecrets masks secret env values wherever they appear", () => {
  process.env.TARGET_PASSWORD = "demo123";
  const line = JSON.stringify({ note: "typed demo123 into field" });
  const scrubbed = scrubKnownSecrets(line);
  assert.ok(!scrubbed.includes("demo123"));
  assert.ok(scrubbed.includes(MASK));
});

test("scrubKnownSecrets does not mask the non-secret username", () => {
  process.env.TARGET_USERNAME = "demo";
  assert.ok(scrubKnownSecrets("operator demo signed on").includes("demo"));
});
