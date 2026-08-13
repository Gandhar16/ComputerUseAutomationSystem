/**
 * Redaction utilities. Two rules:
 *  1. Values marked sensitive (credential refs, sensitive param names,
 *     password inputs) are NEVER written in the clear — not to artifacts,
 *     not to logs, not into LLM-visible observations where avoidable.
 *  2. Credentials are stored as indirections ({{credential:username}})
 *     resolved from the environment at run time.
 */

export const MASK = "•••REDACTED•••";

const CREDENTIAL_RE = /^\{\{credential:(\w+)\}\}$/;

export function isCredentialRef(v: string | undefined): boolean {
  return !!v && CREDENTIAL_RE.test(v);
}

/** Resolve {{credential:x}} from env (TARGET_X). Throws if missing. */
export function resolveCredential(ref: string): string {
  const m = CREDENTIAL_RE.exec(ref);
  if (!m) return ref;
  const key = `TARGET_${m[1]!.toUpperCase()}`;
  const val = process.env[key];
  if (!val) throw new Error(`Credential env var ${key} is not set (needed for ${ref})`);
  return val;
}

/** Mask known secret values anywhere they might appear in a string. */
export function scrubKnownSecrets(text: string): string {
  let out = text;
  for (const key of Object.keys(process.env)) {
    if (!/^(TARGET_(PASSWORD|PIN|TOKEN)|NVIDIA_API_KEY)$/.test(key)) continue;
    const v = process.env[key];
    if (v && v.length >= 4) out = out.split(v).join(MASK);
  }
  return out;
}
