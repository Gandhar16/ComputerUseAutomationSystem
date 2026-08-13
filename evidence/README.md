# Evidence index

Each directory is one run: `run.jsonl` (structured log of every observation, decision, action, and policy verdict) plus full-page screenshots at each step. All logs pass through secret scrubbing before disk; credential values never appear.

| Run | What it demonstrates |
|---|---|
| `discovery-2026-08-13T21-43-12` | **Real LLM discovery** (NVIDIA Nemotron): "look up member 12345 and read their savings balance" — 8 decisions, extracted `$4,382.19`, compiled to `capabilities/lookup-member-balance.json` |
| `discovery-2026-08-13T21-45-57` | **Real LLM discovery** of the sub-account creation flow, including an auto-approved risky step (`--yes-risky`); compiled to `capabilities/open-subaccount.json` |
| `replay-2026-08-13T21-47-28` | Deterministic replay, **different parameter** than discovery (member 34567) → `success`, `savingsBalance: $18,204.66` |
| `replay-2026-08-13T21-47-33` | Bad input (member 99999) → **business outcome `MEMBER_NOT_FOUND`**, not a failure |
| `replay-2026-08-13T21-47-37` | Restricted record (member 55555) → **business outcome `PERMISSION_DENIED`** |
| `replay-2026-08-13T21-47-50` | Injected maintenance dialog → **recoverable condition**: interstitial detected, dismissed, run still `success` |
| `replay-2026-08-13T21-47-57` | Deposit below minimum → **business outcome `VALIDATION_ERROR`** |
| `replay-2026-08-13T21-48-02` | Risky step on a `draft` artifact, unattended → **structured `failure`** (expected vs. observed + screenshot) |
| `replay-2026-08-13T21-48-15` | **Escalation & handoff**: intervention raised, control → HUMAN, step performed in the live session, hand-back, resumed → `escalated / completed_by_human` with outputs |
| `replay-2026-08-13T21-48-24` | Same risky step after review approval → unattended `success` |
