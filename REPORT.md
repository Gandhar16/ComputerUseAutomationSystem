# Design Report

## 1. Architecture

Single Node/TypeScript process, four layers with hard seams:

- **Surface** (`src/surface`) — the only code that touches a UI. Interface: `observe() -> Observation`, `act(AgentAction)`, `read(target)`, `matches(predicate)`. One implementation (Playwright/Chromium). Everything above it speaks surface-agnostic verbs (`click`, `type`, `select`, `navigate`) and abstract `TargetDescriptor`s. This is the seam that keeps artifacts portable to other surface types (§4).
- **Discovery** (`src/agent`) — an observe→decide→act loop. The observation is a compact accessibility-style snapshot (interactive elements with roles, names, and ephemeral refs) plus page text; the model returns one JSON action per turn. Stop conditions: goal met (`done`), `stuck`, max steps, invalid refs. The successful trace is compiled into an artifact; the raw transcript stays in evidence only.
- **Replay** (`src/replay`) — executes an artifact with no LLM. Locator fallback chains, explicit checkpoints, outcome/interstitial detection, and a typed result contract.
- **Cross-cutting**: the **policy engine** is enforced inside the Surface's `act`, so neither the model nor the replay engine can bypass the allowlist — one choke point for both modes. The **control gate** (§5) is asserted in the same place. All evidence flows through one logger that scrubs known secrets before disk.

Trade-offs: a single process (no queues/services) is enough to prove the seams and keeps the system inspectable; JSON-in-content instead of native tool-calling for the LLM because it is the lowest common denominator across NVIDIA-hosted models (schema-validated with one retry). Target app is a purpose-built hostile legacy mock (nested tables, no test IDs, generated ids, injectable runtime errors) so every error path in §3 is demonstrable on demand.

## 2. Artifact schema

A capability is a **contract, not a step list** (`src/artifact/schema.ts`, examples in `capabilities/`):

- `capability` — id, semantic version, description, target `appId`, provenance (`createdFromRun` links to the discovery evidence), and `reviewStatus` (`draft`/`approved`) which gates unattended risky steps.
- `inputs` / `outputs` — typed, described parameters and extractions. This is what a calling agent sees; invocation is `replay(id, params) -> result`.
- `steps[]` — verb + `TargetDescriptor` with a **ranked list of locator candidates**, each carrying a recorded robustness note (why role+name is trusted, why a `ctl00_*` id is not). Values are parameterized: discovery literals matching declared params are lifted to `{{memberId}}`; credentials are stored only as `{{credential:...}}` indirections resolved from the environment at act time.
- `checkpoint` per navigation step and a final `successCondition` — asserted state, not assumed clicks.
- `expectedOutcomes[]` — the app's legitimate non-success results (`MEMBER_NOT_FOUND`, `PERMISSION_DENIED`, `VALIDATION_ERROR`) with detection predicates; `knownInterstitials[]` (detect + dismiss recipe) and `recoverables[]` (e.g. session expiry → restart). These are merged from a per-app profile (`config/app-profiles/`) so knowledge about the app accumulates independently of any one recording.

Shaped this way because the reviewable unit must answer: what does it do, what does it need, what does it return, what else can happen, and what is it allowed to do unattended.

## 3. Determinism & error handling

Replay is deterministic because nothing decides: steps execute in order, each target resolves by trying its candidate chain top-down (role+name → legacy label-cell anchor → form-field `name` → id → structural CSS), waits are explicit (DOM-loaded + checkpoint polling up to a per-artifact timeout), and each navigation step asserts its checkpoint (exact URL path with params substituted, or required text) before proceeding.

The result contract separates three kinds of non-success:

- **Expected business outcomes** — after every action the engine evaluates `expectedOutcomes`; a hit returns `{status: "business_outcome", code}` to the caller. "No such member" is an answer, not a crash.
- **Recoverable conditions** — known interstitials are detected and dismissed inline (logged, screenshotted); transient checkpoint/locator misses get a bounded retry; session expiry triggers one restart of the flow (login steps re-authenticate).
- **Hard failures** — everything else returns `{status: "failure", stepIndex, expected, observed, screenshot}` — enough to debug without rerunning.

UI drift (secondary here, per the brief): resolving via a non-primary locator candidate is logged as a `locator_fallback` drift signal, flagging the artifact for review before the primary breaks silently.

## 4. Heterogeneity & multi-tenant

**Surface abstraction.** Artifacts contain no Playwright types — only verbs, locator strategies, and predicates. A legacy web app is already exercised (the mock *is* one). A desktop surface would implement the same interface over an accessibility API (UIA/AX): `role`-strategy locators map directly to accessibility role+name — which is why role+name is ranked first — while DOM-only strategies (`css`, `attr`) simply don't populate. The observation snapshot is already accessibility-tree-shaped, so discovery transfers too. A screenshot+coordinates surface would slot in the same way for surfaces with no tree at all.

**Multi-tenant reuse.** The artifact's `appId` names the vendor product, not the tenant. The intended model (designed, not built): a **base artifact per vendor product + per-tenant overlay** — entry URL, credential names, and any candidate-list overrides for tenant-specific labels/branding. Locator candidate chains are the degradation mechanism: role+name and label-text anchors survive reskins and version drift far better than markup, and the recorded robustness notes tell a reviewer which overrides a variant needs. Drift is detected operationally via the `locator_fallback` signal and checkpoint failures aggregated per tenant/version; a tenant whose replays start falling back is queued for re-validation instead of silently breaking. Nothing in the schema assumes one tenant — that was the constraint; the fleet-management plumbing is deliberately not built (§7).

## 5. Escalation & handoff

**Detecting stuck:** discovery — the model declares `stuck`, exceeds max steps, or a risky action is not approved; replay — locator/checkpoint failure after retries, or a risky step on a non-approved artifact.

**Control transfer:** an explicit state machine `AUTOMATION → HUMAN → RESUMING → AUTOMATION` (`src/escalation/control.ts`). The gate is asserted inside `Surface.act`, so while a human holds the session automation *cannot* act — it's structural, not advisory. On escalation the system raises an **intervention request** (capability, step, reason, screenshot) served by a minimal operator console (localhost:4600); the human operates **the same live browser session** — the headed Playwright window, same cookies and server-side state — not a fresh one. Their actions are recorded into evidence (in-page listeners plus a host-side navigation trail that can't be lost to page teardown). Clicking "Hand control back" flips the gate; the engine re-verifies state against the artifact's checkpoints before continuing — if the human completed the remaining flow, it validates the success condition and extracts outputs, returning `{status: "escalated", resolution: "completed_by_human", outputs}`.

The operator console is deliberately bare (the brief allows a mocked UI); the handoff mechanism — pause, cede, observe, resume on the same session, with a single source of truth for who is in control — is real.

## 6. Safety

- **Allowlist** (`config/policy.json`): permitted origins and action verbs, enforced at the single act choke point for discovery and replay alike. The model physically cannot navigate off-allowlist or use a verb outside the list.
- **Risky/irreversible actions** are policy rules (e.g. any click on the confirmation route). During discovery they require interactive human confirmation; during replay they run unattended only if the artifact has been reviewed (`approved`) — otherwise the run blocks or escalates to a human. Rationale: the approval is of a *reviewed recording*, which is a stronger guarantee than a per-run yes/no.
- **Secrets & PII:** credentials exist only as `{{credential:...}}` env indirections — the model is instructed to type the placeholder and the substitution happens at act time, so real values never enter prompts, artifacts, or logs; the evidence logger additionally scrubs known secret values from every line it writes, and sensitive params/human-typed password fields are masked.
- **Limits:** the allowlist is origin/verb-granular, not data-aware — it can't tell a legitimate balance readout from over-extraction; PII redaction covers declared-sensitive fields and known secrets, not arbitrary PII appearing in page text or screenshots (screenshots are the richest evidence and the biggest residual leak surface — production would need masked capture or retention policy).

## 7. Cuts

Deliberate cuts, roughly in order of what I'd build next:

1. **Assisted fallback on replay failure** — a bounded, policy-checked single-step LLM recovery, recorded as evidence; the escalation seam is exactly where it plugs in.
2. **Capability catalog surface** — `list` exists; an HTTP/tool-calling endpoint so an agent can discover and invoke capabilities by name is a thin layer over `replay()`.
3. **Cross-tenant demo** — a second LegacyCU variant (relabeled/reskinned) replaying the base artifact with a per-variant overlay, proving §4 operationally.
4. **Confidence scoring / multi-run stability** — replay N times, track fallback-locator and retry rates per artifact, gate `approved` on it.
5. **Operator console fidelity** — live view/remote control (CDP screencast), operator queues, RBAC. The control-transfer model wouldn't change.
6. **Desktop surface implementation** — the interface is designed for it; not built.
7. Artifact **schema migrations** (only a `schemaVersion` field today), richer per-step wait strategies, and parallel-session replay workers.
