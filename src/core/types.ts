/**
 * Shared domain types for buttonmash. This module is the contract every other
 * module depends on; keep it dependency-free.
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export const SEVERITY_ORDER: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/** Every kind of action the monkey can perform on a control. */
export type ActionKind =
  | 'click'
  | 'dblclick'
  | 'type'
  | 'key'
  | 'hover'
  | 'scroll'
  | 'select'
  | 'check'
  | 'back'
  | 'forward'
  | 'resize'
  /** Fill a form's fields with valid data and submit it (a create-flow). */
  | 'submit-form';

/** A serializable description of a discovered interactive element. */
export interface ElementDescriptor {
  /** Stable, run-independent fingerprint of this logical control. */
  fp: string;
  /** Like `fp` but excludes visible text/value — used for state hashing so
   *  live counters/timestamps don't mint a new state every step. */
  structuralFp: string;
  tag: string;
  type: string | null;
  role: string | null;
  /** Trimmed accessible name (text + aria-label), capped. */
  name: string;
  editable: boolean;
  /** Structural DOM path used as part of the fingerprint. */
  path: string;
  /** A Playwright-friendly selector to (re-)locate the element this step.
   *  Light-DOM elements use an nth-child CSS path; shadow-DOM elements use an
   *  ephemeral [data-bm-id] tag (Playwright's CSS engine pierces open shadow). */
  selector: string;
  /** URL of the same-origin iframe this element lives in (undefined = main frame).
   *  Relocation resolves the Frame and queries within it. */
  frameUrl?: string;
  /** Anchor href, when present — used by the destructive-control classifier. */
  href?: string;
  /** Owning form's action target. */
  formAction?: string;
  /** Owning form's HTTP method (uppercased). */
  formMethod?: string;
  /** True when discovery saw the element as disabled. */
  disabled?: boolean;
  // --- form-field constraints (present for inputs/selects/textareas) ---
  required?: boolean;
  pattern?: string;
  min?: string;
  max?: string;
  step?: string;
  minLength?: number;
  maxLength?: number;
  autocomplete?: string;
  placeholder?: string;
  /** Resolved field label (label[for]/wrapping/aria-labelledby/aria-label). */
  label?: string;
  /** For <select>: option value/label/disabled. */
  options?: { value: string; label: string; disabled: boolean }[];
  /** Stable key of the owning form/dialog scope (or 'page'). */
  formKey?: string;
  /** True if this control submits its form. */
  isSubmit?: boolean;
}

/** The fillable subset of an input, used by the form completer. */
export interface FieldDescriptor {
  selector: string;
  fp: string;
  kind:
    | 'text'
    | 'email'
    | 'number'
    | 'date'
    | 'datetime-local'
    | 'month'
    | 'week'
    | 'time'
    | 'tel'
    | 'url'
    | 'password'
    | 'checkbox'
    | 'radio'
    | 'select'
    | 'textarea'
    | 'contenteditable'
    | 'color'
    | 'range'
    | 'file';
  name: string;
  label: string;
  placeholder: string;
  required: boolean;
  pattern?: string;
  min?: string;
  max?: string;
  step?: string;
  minLength?: number;
  maxLength?: number;
  autocomplete?: string;
  options?: { value: string; label: string; disabled: boolean }[];
  radioGroupName?: string;
  formKey: string;
  /** Owning same-origin iframe URL, if the field lives in one. */
  frameUrl?: string;
}

/** A discovered create-surface: a cluster of fields + a submit control. */
export interface FormDescriptor {
  formKey: string;
  /** Stable fingerprint of the form (for coverage tracking). */
  fpKey: string;
  fields: FieldDescriptor[];
  submit?: ElementDescriptor;
  /** Next/Continue controls for multi-step wizards. */
  nextControls: ElementDescriptor[];
  /** A credit-card / payment field is present → never submit. */
  hasLivePaymentField: boolean;
  /** Looks like a signup/login/auth form → don't submit (would mutate session). */
  isAuthForm: boolean;
}

/** A single action the explorer took, forming a replayable trace. */
export interface LoggedAction {
  step: number;
  kind: ActionKind;
  stateHash: string;
  /** Element fingerprint, when the action targeted an element. */
  fp?: string;
  /** Human-readable target name, for reports. */
  target?: string;
  selector?: string;
  /** Value typed/selected, if any (already redacted before persistence). */
  value?: string;
  url: string;
  ts: number;
  navigated?: boolean;
  // --- set for 'submit-form' actions ---
  formKey?: string;
  fieldsFilled?: number;
  retries?: number;
  submitted?: boolean;
}

/** Raw kinds of signal the harness captures from the browser. */
export type SignalKind =
  | 'pageerror'
  | 'console.error'
  | 'console.warn'
  | 'http.4xx'
  | 'http.5xx'
  | 'requestfailed'
  | 'crash'
  | 'dialog'
  | 'hang'
  | 'blank-screen'
  | 'broken-image'
  | 'error-overlay'
  | 'a11y'
  | 'reflected-input'
  | 'secret-leak'
  | 'billing-live'
  | 'form-validation'
  | 'session-lost'
  | 'guardrail'
  | 'custom'
  | 'driver';

/** A raw observation captured during the run, tagged with where/when. */
export interface Signal {
  kind: SignalKind;
  detail: string;
  url: string;
  at: number;
  /** Step index of the action that most likely caused it. */
  step?: number;
  severity?: Severity;
  /** Extra structured context (status code, selector, etc.). */
  meta?: Record<string, string | number | boolean>;
}

export type ArtifactType =
  | 'screenshot'
  | 'thumbnail'
  | 'trace'
  | 'video'
  | 'dom'
  | 'console'
  | 'har';

export interface Artifact {
  type: ArtifactType;
  /** Path relative to the report root. */
  path: string;
  mime: string;
  /** Inlined data URI for small thumbnails embedded in the HTML report. */
  dataUri?: string;
}

/** A deduplicated, reportable problem. */
export interface Finding {
  id: string;
  /** Stable signature for cross-run dedup (SARIF fingerprint, HTML collapse). */
  dedupKey: string;
  severity: Severity;
  category: string;
  title: string;
  description: string;
  /** How many raw signals collapsed into this finding. */
  count: number;
  location: {
    url: string;
    selector?: string;
    fp?: string;
  };
  /** Minimal action trace to reproduce, newest-relevant first. */
  reproSteps: LoggedAction[];
  firstSeenStep: number;
  artifacts: Artifact[];
}

export interface RunStats {
  actionsTaken: number;
  pagesVisited: number;
  statesDiscovered: number;
  /** Records successfully created via completed forms. */
  recordsCreated: number;
  findingsBySeverity: Record<Severity, number>;
}

/** The canonical in-memory result; every report format derives from this. */
export interface RunResult {
  schemaVersion: 1;
  tool: { name: string; version: string };
  run: {
    id: string;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    target: string;
    browser: string;
    viewport: { width: number; height: number };
    exitCode: number;
    dryRun: boolean;
  };
  config: {
    seed: string;
    maxActions: number;
    maxDurationMs: number;
    failOn: Severity;
  };
  stats: RunStats;
  actions: LoggedAction[];
  findings: Finding[];
  /** Full resolved config used for this run (secrets redacted) — for faithful
   *  cross-machine replay. */
  resolvedConfig?: Record<string, unknown>;
}

/** Exit codes follow the pytest/ESLint convention. */
export const EXIT = {
  /** No findings at or above the fail threshold. */
  CLEAN: 0,
  /** Findings at or above the fail threshold — the build-failing signal. */
  FINDINGS: 1,
  /** The tool itself errored (bad config, usage, internal failure). */
  ERROR: 2,
} as const;
