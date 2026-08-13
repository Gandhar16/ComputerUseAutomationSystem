/**
 * Offline test of the escalation handoff. A scripted "human" stands in for the
 * operator: once control flips to HUMAN, it performs the risky step directly
 * on the live page (exactly what a person would do in the headed window) and
 * then posts the operator console's hand-back endpoint.
 */
import "dotenv/config";
import { PolicyEngine } from "../src/safety/policy.js";
import { ControlGate } from "../src/escalation/control.js";
import { PlaywrightWebSurface } from "../src/surface/playwright.js";
import { RunLogger } from "../src/evidence/logger.js";
import { loadArtifact } from "../src/artifact/store.js";
import { replay } from "../src/replay/engine.js";
import { EscalationManager } from "../src/escalation/handoff.js";

async function main() {
  const a = loadArtifact("open-subaccount");
  a.capability.reviewStatus = "draft"; // force the risky step to need a human
  const policy = PolicyEngine.load();
  const gate = new ControlGate();
  const logger = new RunLogger("replay");
  const surface = new PlaywrightWebSurface(policy, gate, { headed: false });
  await surface.start();
  const escalation = new EscalationManager(gate, logger, surface.page);

  // scripted human operator
  const human = (async () => {
    while (gate.current !== "HUMAN") await new Promise((r) => setTimeout(r, 300));
    console.log("  [scripted-human] taking over the live session…");
    await new Promise((r) => setTimeout(r, 1000));
    await surface.page.getByRole("button", { name: "Create Account" }).click();
    await surface.page.waitForLoadState("domcontentloaded");
    console.log("  [scripted-human] risky step performed; handing control back");
    await fetch("http://localhost:4600/handback", { method: "POST" });
  })();

  const result = await replay({
    artifact: a,
    params: { memberId: "34567", accountType: "Money Market", nickname: "Emergency Fund", deposit: "100" },
    surface, logger, policy, escalation,
  });
  await human;
  console.log("\n=== REPLAY RESULT ===");
  console.log(JSON.stringify(result, null, 2));
  console.log(`Evidence: ${logger.dir}`);
  logger.close();
  await surface.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
