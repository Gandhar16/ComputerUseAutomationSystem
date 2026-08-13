/**
 * Control-transfer model. Exactly one party controls the live session at a
 * time. The Surface asserts the gate before every automated action, so
 * automation physically cannot act while a human holds the session.
 *
 *   AUTOMATION --escalate()--> HUMAN --handBack()--> RESUMING --resumed()--> AUTOMATION
 */
export type ControlState = "AUTOMATION" | "HUMAN" | "RESUMING";

export class ControlGate {
  private state: ControlState = "AUTOMATION";
  private listeners: ((s: ControlState) => void)[] = [];

  get current(): ControlState { return this.state; }

  assertAutomationMayAct(): void {
    if (this.state !== "AUTOMATION") {
      throw new Error(`Automation attempted to act while control state is ${this.state}`);
    }
  }

  escalate(): void { this.transition("HUMAN"); }
  handBack(): void { this.transition("RESUMING"); }
  resumed(): void { this.transition("AUTOMATION"); }

  private transition(next: ControlState) {
    const valid: Record<ControlState, ControlState[]> = {
      AUTOMATION: ["HUMAN"],
      HUMAN: ["RESUMING"],
      RESUMING: ["AUTOMATION"],
    };
    if (!valid[this.state].includes(next)) {
      throw new Error(`Invalid control transition ${this.state} -> ${next}`);
    }
    this.state = next;
    this.listeners.forEach((l) => l(next));
  }

  onChange(fn: (s: ControlState) => void) { this.listeners.push(fn); }

  /** Resolves when control returns to RESUMING (human handed back). */
  waitForHandBack(): Promise<void> {
    if (this.state === "RESUMING") return Promise.resolve();
    return new Promise((res) => {
      this.onChange((s) => { if (s === "RESUMING") res(); });
    });
  }
}
