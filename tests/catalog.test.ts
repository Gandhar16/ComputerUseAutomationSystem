/**
 * Catalog API contract tests. Uses a non-default port; the invoke happy path
 * is covered by the integration replay test + committed evidence — here we
 * pin the contract shape and the error responses (which never touch a browser).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { startCatalog } from "../src/catalog/server.js";

const PORT = 4790;
const BASE = `http://localhost:${PORT}`;
let server: Server;

before(async () => { server = await startCatalog(PORT); });
after(() => { server.close(); });

test("GET /capabilities lists every saved artifact as a tool-shaped contract", async () => {
  const res = await fetch(`${BASE}/capabilities`);
  assert.equal(res.status, 200);
  const body = await res.json() as { capabilities: { name: string; parameters: { required: string[] }; returns: { possibleOutcomes: string[] } }[] };
  const names = body.capabilities.map((c) => c.name);
  assert.ok(names.includes("lookup-member-balance"));
  assert.ok(names.includes("open-subaccount"));
  const lookup = body.capabilities.find((c) => c.name === "lookup-member-balance")!;
  assert.deepEqual(lookup.parameters.required, ["memberId"]);
  assert.ok(lookup.returns.possibleOutcomes.includes("MEMBER_NOT_FOUND"));
});

test("GET /capabilities/:id returns 404 for an unknown capability", async () => {
  const res = await fetch(`${BASE}/capabilities/no-such-capability`);
  assert.equal(res.status, 404);
});

test("POST invoke returns 404 for an unknown capability", async () => {
  const res = await fetch(`${BASE}/capabilities/no-such-capability/invoke`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.equal(res.status, 404);
});

test("POST invoke rejects missing required params with 400 before touching a browser", async () => {
  const res = await fetch(`${BASE}/capabilities/lookup-member-balance/invoke`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ params: {} }),
  });
  assert.equal(res.status, 400);
  const body = await res.json() as { error: string };
  assert.match(body.error, /memberId/);
});
