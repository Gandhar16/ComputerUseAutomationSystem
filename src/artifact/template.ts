import { isCredentialRef, resolveCredential } from "../safety/redact.js";

/** Replace {{param}} placeholders with values; resolve {{credential:x}} from env. */
export function render(template: string, params: Record<string, string>): string {
  if (isCredentialRef(template)) return resolveCredential(template);
  return template.replace(/\{\{(\w+)\}\}/g, (m, name: string) => params[name] ?? m);
}

/** Lift literal values into {{param}} placeholders (compile-time inverse of render). */
export function lift(literal: string, params: Record<string, string>): string {
  let out = literal;
  for (const [name, value] of Object.entries(params)) {
    if (value && out.includes(value)) out = out.split(value).join(`{{${name}}}`);
  }
  return out;
}
