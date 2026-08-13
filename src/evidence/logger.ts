import fs from "node:fs";
import path from "node:path";
import { scrubKnownSecrets } from "../safety/redact.js";
import type { Surface } from "../surface/types.js";

export type RunKind = "discovery" | "replay";

/**
 * Evidence for a single run: a JSONL structured log plus screenshots,
 * written to /evidence/<runId>/. All strings pass through secret scrubbing
 * before hitting disk.
 */
export class RunLogger {
  readonly runId: string;
  readonly dir: string;
  private stream: fs.WriteStream;
  private shotCounter = 0;

  constructor(kind: RunKind, baseDir = path.resolve("evidence")) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    this.runId = `${kind}-${stamp}`;
    this.dir = path.join(baseDir, this.runId);
    fs.mkdirSync(this.dir, { recursive: true });
    this.stream = fs.createWriteStream(path.join(this.dir, "run.jsonl"), { flags: "a" });
  }

  log(event: string, data: Record<string, unknown> = {}): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...data });
    this.stream.write(scrubKnownSecrets(line) + "\n");
    const brief = data.summary ?? data.reason ?? data.action ?? data.outcome ?? "";
    console.log(`  [${event}] ${typeof brief === "string" ? scrubKnownSecrets(brief) : JSON.stringify(brief)}`);
  }

  async screenshot(surface: Surface, label: string): Promise<string> {
    const file = path.join(this.dir, `${String(++this.shotCounter).padStart(2, "0")}-${label}.png`);
    await surface.screenshot(file);
    return path.relative(process.cwd(), file);
  }

  writeFile(name: string, content: string): string {
    const file = path.join(this.dir, name);
    fs.writeFileSync(file, scrubKnownSecrets(content));
    return path.relative(process.cwd(), file);
  }

  close(): void { this.stream.end(); }
}
