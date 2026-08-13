/**
 * Surface abstraction — the seam between "how we perceive/act on a surface"
 * and "the recorded flow". Artifacts and the replay engine only speak these
 * types; PlaywrightWebSurface is one implementation (a desktop/accessibility
 * implementation would slot in behind the same interface).
 */

export type ActionVerb = "navigate" | "click" | "type" | "select" | "extract" | "dismiss";

export type LocatorStrategy =
  | "role"     // accessible role + name, e.g. "button::Sign On"  (most portable)
  | "tdlabel"  // legacy pattern: form control anchored to the text of its row label cell
  | "text"     // exact visible text (links/buttons)
  | "attr"     // attribute selector, e.g. "#ctl00_main_txt1" or "[name=txtUser]"
  | "css";     // structural path — last-resort fallback

export interface LocatorCandidate {
  strategy: LocatorStrategy;
  value: string;
  /** recorded reasoning about why/when this candidate is trustworthy */
  note?: string;
}

export interface TargetDescriptor {
  /** ephemeral element ref within a single observation (discovery only) */
  ref?: string;
  /** human-readable description for reviewers ("'Search' button in Member Inquiry") */
  description: string;
  /** ranked, most-trusted first */
  candidates: LocatorCandidate[];
}

export interface AgentAction {
  verb: ActionVerb;
  target?: TargetDescriptor;
  /** for type/select: the value; for navigate: the URL */
  value?: string;
  /** value is sensitive — never persist or log it in the clear */
  redact?: boolean;
}

export interface ObservedElement {
  ref: string;
  role: string;
  name: string;
  tag: string;
  enabled: boolean;
  candidates: LocatorCandidate[];
}

export interface Observation {
  url: string;
  title: string;
  /** salient page text, truncated — enough for the model to read state */
  text: string;
  elements: ObservedElement[];
}

/** Predicates used by outcome/interstitial detection — deliberately tiny. */
export interface DetectPredicate {
  kind: "text" | "selector" | "urlPath";
  value: string;
}

export interface Surface {
  goto(url: string): Promise<void>;
  observe(): Promise<Observation>;
  /** Perform one action. `target.ref` (fresh observation) or candidates are used to find the control. */
  act(action: AgentAction): Promise<void>;
  /** Read text content from a target (for `extract`). */
  read(target: TargetDescriptor): Promise<string | null>;
  matches(predicate: DetectPredicate): Promise<boolean>;
  screenshot(filePath: string): Promise<void>;
  currentUrl(): string;
  close(): Promise<void>;
}
