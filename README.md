# Computer-Use Automation System

An LLM **discovers** how to accomplish a natural-language goal by driving a real (deliberately legacy-style) web UI, records the successful run as a **typed capability artifact**, and the artifact is then **replayed deterministically** — no LLM in the loop — with typed inputs/outputs, an explicit error taxonomy, safety guardrails, and a human-in-the-loop escalation path over the same live session.

> The model discovers. The artifact becomes a reusable capability. Deterministic replay is how the AI agent invokes it in production.

Design rationale and trade-offs are in [REPORT.md](REPORT.md). Example artifacts + run evidence are in [/evidence/](evidence/) and [/capabilities/](capabilities/).

## Setup

Requirements: Node.js ≥ 20.

```bash
npm install
npx playwright install chromium
copy .env.example .env     # then edit .env
```

`.env` keys:

| Key | Needed for | Notes |
|---|---|---|
| `NVIDIA_API_KEY` | **discovery runs only** | From https://build.nvidia.com (`nvapi-...`). Replay never needs it. |
| `NVIDIA_MODEL` | discovery | defaults to `nvidia/llama-3.3-nemotron-super-49b-v1` |
| `TARGET_USERNAME` / `TARGET_PASSWORD` | both | Demo credentials for the mock app: `demo` / `demo123`. Artifacts reference them as `{{credential:...}}`; real values never persist anywhere. |

**Running without live services:** replay is fully offline — it needs only the local target app and a saved artifact, no LLM key.

## The target app

`npm run target-app` serves **LegacyCU** (http://localhost:4173), a mock legacy credit-union back office: server-rendered, table-based layout, no test IDs, ASP.NET-style generated ids. It has injectable runtime conditions used by the demos below (member `99999` → not found, member `55555` → permission denied, deposit `< 25` → validation error, `--inject=interstitial|slow|expire` → dialog/slowness/session expiry).

## Demo path

Terminal 1 — keep the target app running:

```bash
npm run target-app
```

Terminal 2:

```bash
# 1. DISCOVERY — LLM-driven run (needs NVIDIA_API_KEY); saves the capability artifact
npm run discover -- --goal "Sign on, look up member 12345 and read their current savings balance" ^
  --url http://localhost:4173/login --id lookup-member-balance ^
  --param memberId=12345 --output savingsBalance="The member's current savings balance"

# 1b. DISCOVERY of the sub-account flow (has a risky/irreversible step; --yes-risky
#     auto-approves it for non-interactive demos — omit to be prompted)
npm run discover -- --goal "Sign on, look up member 23456, open a new Holiday Club sub-account with nickname 'Vacation Fund' and initial deposit 50, confirm it, and read the new account number" ^
  --url http://localhost:4173/login --id open-subaccount ^
  --param memberId=23456 --param accountType="Holiday Club" --param nickname="Vacation Fund" --param deposit=50 ^
  --output newAccountNumber="The account number assigned to the newly created sub-account" --yes-risky

# 2. REPLAY — deterministic, no LLM; returns typed outputs
npm run replay -- --capability lookup-member-balance --param memberId=12345

# 3. REPLAY hitting a business outcome (a legitimate result, not a crash)
npm run replay -- --capability lookup-member-balance --param memberId=99999   # -> MEMBER_NOT_FOUND
npm run replay -- --capability lookup-member-balance --param memberId=55555   # -> PERMISSION_DENIED

# 4. REPLAY through a recoverable condition (interstitial dialog auto-dismissed, logged)
npm run replay -- --capability lookup-member-balance --param memberId=12345 --inject=interstitial

# 5. RISKY/IRREVERSIBLE step handling (draft artifact -> blocked; approve -> unattended)
npm run replay -- --capability open-subaccount --param memberId=23456 --param accountType="Holiday Club" --param nickname="Vacation Fund" --param deposit=50
npx tsx src/cli.ts approve --capability open-subaccount
npm run replay -- --capability open-subaccount --param memberId=23456 --param accountType="Holiday Club" --param nickname="Vacation Fund" --param deposit=50

# 6. HUMAN-IN-THE-LOOP escalation over the live session (headed browser + operator console)
npm run replay -- --capability open-subaccount --escalate --param memberId=34567 --param accountType="Money Market" --param nickname="Emergency Fund" --param deposit=100
#    -> browser window opens; on escalation visit http://localhost:4600/, complete the step
#       in the automation window, then click "Hand control back".
#    (no human handy? scripted stand-in: npx tsx scripts/simulate-escalation.ts)

npm run list   # catalog of saved capabilities with their typed contracts
```

Every run writes evidence to `evidence/<runId>/` — a structured `run.jsonl` (decisions, actions, policy verdicts) plus screenshots at each step and on failure.

## Layout

```
target-app/          LegacyCU mock legacy bank app
config/policy.json   allowlist + risky-action rules (enforced for discovery AND replay)
config/app-profiles/ per-app knowledge: expected business outcomes, known interstitials
src/surface/         Surface abstraction (perceive/act seam) + Playwright implementation
src/agent/           LLM discovery loop (observe -> decide -> act)
src/artifact/        capability schema (Zod), param lifting, store
src/replay/          deterministic replay engine + result contract
src/safety/          policy engine, redaction, credential indirection
src/escalation/      control gate (AUTOMATION/HUMAN/RESUMING) + operator console
src/evidence/        structured run logger + screenshots
capabilities/        saved capability artifacts (JSON)
evidence/            per-run logs and screenshots
```
