import fs from "node:fs";
import path from "node:path";
import { CapabilityArtifactSchema, type CapabilityArtifact } from "./schema.js";

const DIR = path.resolve("capabilities");

export function saveArtifact(a: CapabilityArtifact): string {
  CapabilityArtifactSchema.parse(a);
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, `${a.capability.id}.json`);
  fs.writeFileSync(file, JSON.stringify(a, null, 2));
  return path.relative(process.cwd(), file);
}

export function loadArtifact(idOrPath: string): CapabilityArtifact {
  const file = fs.existsSync(idOrPath) ? idOrPath : path.join(DIR, `${idOrPath}.json`);
  if (!fs.existsSync(file)) throw new Error(`Capability not found: ${idOrPath}`);
  return CapabilityArtifactSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
}

export function listArtifacts(): CapabilityArtifact[] {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter((f) => f.endsWith(".json"))
    .map((f) => CapabilityArtifactSchema.parse(JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"))));
}
