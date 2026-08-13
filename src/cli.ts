import "dotenv/config";
import { PolicyEngine } from "./safety/policy.js";
import { ControlGate } from "./escalation/control.js";
import { PlaywrightWebSurface } from "./surface/playwright.js";
import { RunLogger } from "./evidence/logger.js";
import { runDiscovery } from "./agent/loop.js";
import { compileArtifact } from "./artifact/compiler.js";
import { saveArtifact, loadArtifact, listArtifacts } from "./artifact/store.js";
import { replay } from "./replay/engine.js";
import { EscalationManager } from "./escalation/handoff.js";

/** Tiny arg parser: --key value / --key=value; repeated --param k=v collect into maps. */
function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const params: Record<string, string> = {};
  const outputs: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    arg = arg.slice(2);
    let val: string | boolean = true;
    const eq = arg.indexOf("=");
    if (eq >= 0) { val = arg.slice(eq + 1); arg = arg.slice(0, eq); }
    else if (argv[i + 1] && !argv[i + 1]!.startsWith("--")) { val = argv[++i]!; }
    if (arg === "param" || arg === "output") {
      const kv = String(val); const k = kv.indexOf("=");
      if (k < 0) throw new Error(`--${arg} expects name=value, got '${kv}'`);
      (arg === "param" ? params : outputs)[kv.slice(0, k)] = kv.slice(k + 1);
    } else {
      flags[arg] = val;
    }
  }
  return { flags, params, outputs };
}

function req(flags: Record<string, string | boolean>, name: string): string {
  const v = flags[name];
  if (typeof v !== "string" || !v) { console.error(`Missing required flag --${name}`); process.exit(2); }
  return v;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, params, outputs } = parseArgs(rest);

  if (cmd === "list") {
    for (const a of listArtifacts()) {
      console.log(`${a.capability.id} v${a.capability.version} [${a.capability.reviewStatus}] — ${a.capability.description}`);
      console.log(`  inputs:  ${a.inputs.map((i) => `${i.name}:${i.type}`).join(", ") || "(none)"}`);
      console.log(`  outputs: ${a.outputs.map((o) => `${o.name}:${o.type}`).join(", ") || "(none)"}`);
    }
    return;
  }

  if (cmd === "approve") {
    const a = loadArtifact(req(flags, "capability"));
    a.capability.reviewStatus = "approved";
    const file = saveArtifact(a);
    console.log(`Approved: ${file}`);
    return;
  }

  if (cmd === "discover") {
    const goal = req(flags, "goal");
    const url = req(flags, "url");
    const id = req(flags, "id");
    const policy = PolicyEngine.load();
    const gate = new ControlGate();
    const logger = new RunLogger("discovery");
    const surface = new PlaywrightWebSurface(policy, gate, { headed: !!flags.headed });
    await surface.start();
    try {
      const result = await runDiscovery({
        goal, entryUrl: url, params, outputs, surface, logger, policy,
        interactive: !flags["yes-risky"] ? true : true,
      });
      if (!result.success) {
        console.error(`\nDiscovery did not complete the goal: ${result.summary}`);
        console.error(`Evidence: ${logger.dir}`);
        process.exitCode = 1;
        return;
      }
      const artifact = compileArtifact({
        id,
        name: (flags.name as string) ?? id,
        description: goal,
        appId: (flags.app as string) ?? "legacycu",
        runId: logger.runId,
        entryUrl: url,
        params,
        trace: result.trace,
        extracts: result.extracts.map(({ name, description, target }) => ({ name, description, target })),
      });
      const file = saveArtifact(artifact);
      logger.writeFile("artifact.json", JSON.stringify(artifact, null, 2));
      logger.log("artifact.compiled", { file });
      console.log(`\n✅ Discovery succeeded: ${result.summary}`);
      for (const e of result.extracts) console.log(`   extracted ${e.name} = ${e.value}`);
      console.log(`   Capability saved: ${file}`);
      console.log(`   Evidence: ${logger.dir}`);
    } finally {
      logger.close();
      await surface.close();
    }
    return;
  }

  if (cmd === "replay") {
    const a = loadArtifact(req(flags, "capability"));
    // Demo/testing knob: append a chaos-injection query param to the entry URL
    // (the target app uses it to simulate interstitials, slowness, expiry).
    if (typeof flags.inject === "string") {
      a.entry.url += (a.entry.url.includes("?") ? "&" : "?") + "inject=" + flags.inject;
    }
    const escalate = !!flags.escalate;
    const policy = PolicyEngine.load();
    const gate = new ControlGate();
    const logger = new RunLogger("replay");
    const surface = new PlaywrightWebSurface(policy, gate, { headed: escalate || !!flags.headed });
    await surface.start();
    try {
      const escalation = escalate ? new EscalationManager(gate, logger, surface.page) : undefined;
      const result = await replay({ artifact: a, params, surface, logger, policy, escalation });
      console.log("\n=== REPLAY RESULT ===");
      console.log(JSON.stringify(result, null, 2));
      console.log(`Evidence: ${logger.dir}`);
      if (result.status === "failure") process.exitCode = 1;
    } finally {
      logger.close();
      await surface.close();
    }
    return;
  }

  console.log(`Usage:
  npm run discover -- --goal "<goal>" --url <entryUrl> --id <capability-id> [--name "<Name>"] [--param k=v ...] [--output name="description" ...] [--headed]
  npm run replay   -- --capability <id> [--param k=v ...] [--headed] [--escalate]
  npm run list
  tsx src/cli.ts approve --capability <id>`);
  process.exit(cmd ? 2 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
