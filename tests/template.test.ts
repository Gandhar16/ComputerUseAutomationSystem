import { test } from "node:test";
import assert from "node:assert/strict";
import { render, lift } from "../src/artifact/template.js";

test("render substitutes {{param}} placeholders", () => {
  assert.equal(render("/member/{{memberId}}", { memberId: "12345" }), "/member/12345");
  assert.equal(render("{{a}}-{{b}}", { a: "x", b: "y" }), "x-y");
});

test("render leaves unknown placeholders intact", () => {
  assert.equal(render("/member/{{unknown}}", {}), "/member/{{unknown}}");
});

test("render resolves {{credential:x}} from env, never from params", () => {
  process.env.TARGET_USERNAME = "demo";
  assert.equal(render("{{credential:username}}", { username: "attacker" }), "demo");
});

test("render throws when a credential env var is missing", () => {
  delete process.env.TARGET_NOPE;
  assert.throws(() => render("{{credential:nope}}", {}), /TARGET_NOPE/);
});

test("lift replaces literal param values with placeholders", () => {
  assert.equal(lift("/member/12345", { memberId: "12345" }), "/member/{{memberId}}");
  assert.equal(lift("Vacation Fund", { nickname: "Vacation Fund" }), "{{nickname}}");
});

test("lift leaves non-matching literals alone", () => {
  assert.equal(lift("/members", { memberId: "12345" }), "/members");
});
