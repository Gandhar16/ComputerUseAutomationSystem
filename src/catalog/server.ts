import express from "express";
import { listArtifacts, loadArtifact } from "../artifact/store.js";
import type { CapabilityArtifact } from "../artifact/schema.js";
import { PolicyEngine } from "../safety/policy.js";
import { ControlGate } from "../escalation/control.js";
import { PlaywrightWebSurface } from "../surface/playwright.js";
import { RunLogger } from "../evidence/logger.js";
import { replay } from "../replay/engine.js";

const DEFAULT_PORT = 4700;

/**
 * Agent-facing capability catalog (stretch goal).
 *
 * Saved artifacts exposed as a catalog of callable capabilities: an AI agent
 * discovers them by name with typed contracts (GET /capabilities) and invokes
 * one with typed args (POST /capabilities/:id/invoke) — the invocation IS a
 * deterministic replay; no LLM runs anywhere in this path. The `describe`
 * shape is deliberately tool-call-like (name / description / parameters as
 * JSON-Schema) so a calling agent can mount capabilities directly as tools.
 */

function describe(a: CapabilityArtifact) {
  return {
    name: a.capability.id,
    description: a.capability.description,
    version: a.capability.version,
    reviewStatus: a.capability.reviewStatus,
    app: a.capability.appId,
    parameters: {
      type: "object",
      properties: Object.fromEntries(a.inputs.map((i) => [i.name, {
        type: i.type, description: i.description,
      }])),
      required: a.inputs.filter((i) => i.required).map((i) => i.name),
    },
    returns: {
      type: "object",
      properties: Object.fromEntries(a.outputs.map((o) => [o.name, {
        type: o.type, description: o.description,
      }])),
      possibleOutcomes: ["success", ...a.expectedOutcomes.map((o) => o.code)],
    },
  };
}

export function startCatalog(port = DEFAULT_PORT): Promise<import("node:http").Server> {
  const app = express();
  app.use(express.json());

  app.get("/capabilities", (_req, res) => {
    res.json({ capabilities: listArtifacts().map(describe) });
  });

  app.get("/capabilities/:id", (req, res) => {
    try {
      res.json(describe(loadArtifact(req.params.id!)));
    } catch {
      res.status(404).json({ error: `unknown capability '${req.params.id}'` });
    }
  });

  app.post("/capabilities/:id/invoke", async (req, res) => {
    let artifact: CapabilityArtifact;
    try {
      artifact = loadArtifact(req.params.id!);
    } catch {
      res.status(404).json({ error: `unknown capability '${req.params.id}'` });
      return;
    }
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.body?.params ?? {})) params[k] = String(v);
    const missing = artifact.inputs.filter((i) => i.required && params[i.name] === undefined);
    if (missing.length) {
      res.status(400).json({ error: `missing required params: ${missing.map((m) => m.name).join(", ")}` });
      return;
    }
    // Unattended invocation: risky steps require an approved artifact — the
    // replay engine enforces this; there is no escalation seat over HTTP.
    const policy = PolicyEngine.load();
    const gate = new ControlGate();
    const logger = new RunLogger("replay");
    const surface = new PlaywrightWebSurface(policy, gate, { headed: false });
    try {
      await surface.start();
      const result = await replay({ artifact, params, surface, logger, policy });
      res.json({ ...result, evidence: logger.dir });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    } finally {
      logger.close();
      await surface.close().catch(() => {});
    }
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      console.log(`Capability catalog listening on http://localhost:${port}`);
      console.log(`  GET  /capabilities                — discover callable capabilities (typed contracts)`);
      console.log(`  POST /capabilities/:id/invoke     — invoke with {"params": {...}} (deterministic replay)`);
      resolve(server);
    });
    server.on("error", reject);
  });
}
