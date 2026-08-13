import { z } from "zod";

/**
 * The capability artifact — the contract between discovery and replay, and
 * between the automation system and the AI agents that invoke capabilities.
 * Designed to be reviewable: a human should be able to read the JSON and
 * understand what the capability does, needs, and returns.
 */

export const DetectPredicateSchema = z.object({
  kind: z.enum(["text", "selector", "urlPath"]),
  /** may contain {{param}} templates, resolved at replay time */
  value: z.string(),
});

export const LocatorCandidateSchema = z.object({
  strategy: z.enum(["role", "tdlabel", "text", "attr", "css"]),
  value: z.string(),
  note: z.string().optional(),
});

export const TargetDescriptorSchema = z.object({
  description: z.string(),
  candidates: z.array(LocatorCandidateSchema).min(1),
});

export const ParamSchema = z.object({
  name: z.string(),
  type: z.enum(["string", "number"]),
  description: z.string(),
  required: z.boolean(),
  /** sensitive params are redacted everywhere and never persisted */
  sensitive: z.boolean().default(false),
});

export const OutputSchema = z.object({
  name: z.string(),
  type: z.enum(["string", "number"]),
  description: z.string(),
  /** where the value is read from on the final (or named) screen */
  source: TargetDescriptorSchema,
});

export const CheckpointSchema = z.object({
  description: z.string(),
  /** all predicates must hold */
  predicates: z.array(DetectPredicateSchema).min(1),
});

export const StepSchema = z.object({
  index: z.number().int(),
  verb: z.enum(["navigate", "click", "type", "select", "dismiss"]),
  description: z.string(),
  target: TargetDescriptorSchema.optional(),
  /** literal, "{{param}}", or "{{credential:name}}" — credentials resolve from env at act time */
  value: z.string().optional(),
  /** value must never be logged/persisted in the clear */
  sensitive: z.boolean().default(false),
  /** matched a risky-action policy rule during discovery; unattended replay requires reviewStatus=approved */
  risky: z.boolean().default(false),
  /** asserted after the action before proceeding */
  checkpoint: CheckpointSchema.optional(),
});

export const ExpectedOutcomeSchema = z.object({
  /** stable machine code the calling agent can branch on, e.g. MEMBER_NOT_FOUND */
  code: z.string(),
  description: z.string(),
  detect: DetectPredicateSchema,
});

export const InterstitialSchema = z.object({
  id: z.string(),
  description: z.string(),
  detect: DetectPredicateSchema,
  dismiss: z.object({ action: z.literal("click"), selector: z.string() }),
});

export const RecoverableSchema = z.object({
  id: z.string(),
  description: z.string(),
  detect: DetectPredicateSchema,
  /** restart = re-run the flow from step 0 (e.g. session expiry; login steps re-authenticate) */
  strategy: z.enum(["restart"]),
  maxAttempts: z.number().int().min(1).default(1),
});

export const CapabilityArtifactSchema = z.object({
  schemaVersion: z.literal("1.0"),
  capability: z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string(),
    version: z.number().int().min(1),
    description: z.string(),
    appId: z.string(),
    createdAt: z.string(),
    createdFromRun: z.string(),
    reviewStatus: z.enum(["draft", "approved"]),
  }),
  /** entry URL; may contain {{param}} templates */
  entry: z.object({ url: z.string() }),
  inputs: z.array(ParamSchema),
  outputs: z.array(OutputSchema),
  steps: z.array(StepSchema).min(1),
  successCondition: CheckpointSchema,
  expectedOutcomes: z.array(ExpectedOutcomeSchema),
  knownInterstitials: z.array(InterstitialSchema),
  recoverables: z.array(RecoverableSchema),
  limits: z.object({
    stepTimeoutMs: z.number().int().default(8000),
    transientRetries: z.number().int().default(1),
  }),
});

export type DetectPredicate = z.infer<typeof DetectPredicateSchema>;
export type Checkpoint = z.infer<typeof CheckpointSchema>;
export type Step = z.infer<typeof StepSchema>;
export type ExpectedOutcome = z.infer<typeof ExpectedOutcomeSchema>;
export type Interstitial = z.infer<typeof InterstitialSchema>;
export type Recoverable = z.infer<typeof RecoverableSchema>;
export type CapabilityArtifact = z.infer<typeof CapabilityArtifactSchema>;
export type Param = z.infer<typeof ParamSchema>;
export type Output = z.infer<typeof OutputSchema>;
