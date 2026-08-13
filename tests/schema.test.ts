import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CapabilityArtifactSchema } from "../src/artifact/schema.js";

test("the committed capability artifacts validate against the schema", () => {
  for (const file of fs.readdirSync("capabilities").filter((f) => f.endsWith(".json"))) {
    const parsed = CapabilityArtifactSchema.safeParse(
      JSON.parse(fs.readFileSync(`capabilities/${file}`, "utf8")),
    );
    assert.ok(parsed.success, `${file}: ${parsed.success ? "" : parsed.error.message}`);
  }
});

test("artifacts without steps are rejected", () => {
  const a = JSON.parse(fs.readFileSync("capabilities/lookup-member-balance.json", "utf8"));
  a.steps = [];
  assert.equal(CapabilityArtifactSchema.safeParse(a).success, false);
});

test("unknown locator strategies are rejected", () => {
  const a = JSON.parse(fs.readFileSync("capabilities/lookup-member-balance.json", "utf8"));
  a.steps[1].target.candidates[0].strategy = "xpath9000";
  assert.equal(CapabilityArtifactSchema.safeParse(a).success, false);
});

test("capability ids are constrained to slug form", () => {
  const a = JSON.parse(fs.readFileSync("capabilities/lookup-member-balance.json", "utf8"));
  a.capability.id = "Not A Slug!";
  assert.equal(CapabilityArtifactSchema.safeParse(a).success, false);
});
