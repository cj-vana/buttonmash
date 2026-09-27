/** Collects raw signals during a run, tagged with the current step + URL. */
import type { Severity, Signal, SignalKind } from '../core/types';

export interface AddOptions {
  severity?: Severity;
  url?: string;
  step?: number;
  meta?: Record<string, string | number | boolean>;
}

export class SignalRecorder {
  readonly signals: Signal[] = [];
  private step = 0;
  private url = '';

  /**
   * @param redact Applied to every detail, URL and string meta value before it
   *   is stored, so no call site can put a secret into a report. Must be safe
   *   to run on text a call site already redacted. Defaults to keeping text
   *   as given (for runs with `guardrails.secrets.redact: false`).
   */
  constructor(private readonly redact: (text: string) => string = (text) => text) {}

  /** Update the "current action" context so signals attribute correctly. */
  setContext(step: number, url: string): void {
    this.step = step;
    this.url = url;
  }

  add(kind: SignalKind, detail: string, opts: AddOptions = {}): void {
    this.signals.push({
      kind,
      detail: this.redact(detail),
      url: this.redact(opts.url ?? this.url),
      at: Date.now(),
      step: opts.step ?? this.step,
      severity: opts.severity,
      meta: opts.meta && this.redactMeta(opts.meta),
    });
  }

  count(): number {
    return this.signals.length;
  }

  /** Signals captured since index `from` (used to attribute per-action). */
  since(from: number): Signal[] {
    return this.signals.slice(from);
  }

  private redactMeta(meta: NonNullable<AddOptions['meta']>): NonNullable<AddOptions['meta']> {
    return Object.fromEntries(
      Object.entries(meta).map(([key, value]) => [
        key,
        typeof value === 'string' ? this.redact(value) : value,
      ]),
    );
  }
}
