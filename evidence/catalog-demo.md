# Capability catalog invocation demo (stretch goal)

Catalog server: `npm run serve` (http://localhost:4700). The invocation path is a
deterministic replay — no LLM anywhere. Transcript from a live session (2026-08-13):

## 1. An agent discovers the callable capabilities

`GET /capabilities` → tool-call-shaped contracts (abbreviated):

```json
{
  "capabilities": [
    {
      "name": "lookup-member-balance",
      "description": "Sign on, look up member 12345 and read their current savings balance",
      "version": 1,
      "reviewStatus": "draft",
      "parameters": {
        "type": "object",
        "properties": { "memberId": { "type": "number" } },
        "required": ["memberId"]
      },
      "returns": {
        "type": "object",
        "properties": { "savingsBalance": { "type": "string" } },
        "possibleOutcomes": ["success", "MEMBER_NOT_FOUND", "PERMISSION_DENIED", "VALIDATION_ERROR"]
      }
    },
    { "name": "open-subaccount", "reviewStatus": "approved", "...": "..." }
  ]
}
```

## 2. It invokes one by name with typed args

`POST /capabilities/lookup-member-balance/invoke` with `{"params": {"memberId": "34567"}}`:

```json
{
  "status": "success",
  "runId": "replay-2026-08-13T22-12-21",
  "outputs": { "savingsBalance": "$18,204.66" },
  "evidence": "evidence/replay-2026-08-13T22-12-21"
}
```

## 3. Business outcomes propagate to the caller as answers, not errors

Same call with `{"params": {"memberId": "99999"}}`:

```json
{
  "status": "business_outcome",
  "runId": "replay-2026-08-13T22-12-24",
  "code": "MEMBER_NOT_FOUND",
  "description": "The searched member number does not exist. Legitimate business result, not a failure.",
  "evidence": "evidence/replay-2026-08-13T22-12-24"
}
```

Both invocations have full run logs + screenshots in the referenced evidence directories.
Unattended invocations of capabilities with risky steps are gated on `reviewStatus: "approved"`
by the replay engine — the catalog adds no bypass.
