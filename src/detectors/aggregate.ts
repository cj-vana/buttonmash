/**
 * Collapse raw signals into deduplicated, reportable findings. The same bug
 * firing 500 times becomes one finding with `count: 500` and a minimal repro
 * trace — fixing gremlins.js's habit of over-counting and under-reporting.
 */
import { findingDedupKey } from '../core/hash';
import type { Finding, LoggedAction, Severity, Signal, SignalKind } from '../core/types';

interface KindMeta {
  category: string;
  defaultSeverity: Severity;
  label: string;
}

const KIND_META: Record<SignalKind, KindMeta> = {
  pageerror: { category: 'js-error', defaultSeverity: 'high', label: 'Uncaught JavaScript error' },
  'console.error': { category: 'console-error', defaultSeverity: 'high', label: 'console.error' },
  'console.warn': { category: 'console-warning', defaultSeverity: 'low', label: 'console.warn' },
  'http.5xx': { category: 'http-5xx', defaultSeverity: 'high', label: 'Server error (5xx)' },
  'http.4xx': { category: 'http-4xx', defaultSeverity: 'medium', label: 'Client error (4xx)' },
  requestfailed: {
    category: 'network',
    defaultSeverity: 'medium',
    label: 'Network request failed',
  },
  crash: { category: 'crash', defaultSeverity: 'critical', label: 'Renderer crash' },
  dialog: { category: 'dialog', defaultSeverity: 'low', label: 'Native dialog' },
  hang: { category: 'hang', defaultSeverity: 'high', label: 'Unresponsive / hang' },
  'blank-screen': { category: 'blank-screen', defaultSeverity: 'high', label: 'Blank screen' },
  'broken-image': { category: 'broken-image', defaultSeverity: 'low', label: 'Broken image' },
  'error-overlay': {
    category: 'error-overlay',
    defaultSeverity: 'high',
    label: 'Framework error overlay',
  },
  a11y: { category: 'a11y', defaultSeverity: 'medium', label: 'Accessibility violation' },
  'reflected-input': {
    category: 'reflected-input',
    defaultSeverity: 'medium',
    label: 'Reflected input (possible XSS sink)',
  },
  'secret-leak': {
    category: 'secret-leak',
    defaultSeverity: 'high',
    label: 'Client-exposed secret',
  },
  'billing-live': {
    category: 'billing-live',
    defaultSeverity: 'critical',
    label: 'Live billing mode',
  },
  'form-validation': {
    category: 'form-validation',
    defaultSeverity: 'low',
    label: 'Form not accepted',
  },
  'session-lost': {
    category: 'session-lost',
    defaultSeverity: 'high',
    label: 'Session lost (logged out mid-run)',
  },
  guardrail: { category: 'guardrail', defaultSeverity: 'info', label: 'Guardrail' },
  custom: { category: 'custom', defaultSeverity: 'medium', label: 'Custom rule' },
  driver: { category: 'driver-error', defaultSeverity: 'medium', label: 'Driver error' },
};

/** Network failures are resource-scoped, not page-scoped: the same broken
 *  asset/endpoint (its URL is in the detail) referenced from ten pages is one
 *  bug, not ten findings — so these kinds drop the page URL from their key. */
const RESOURCE_KINDS = new Set<SignalKind>([
  'http.4xx',
  'http.5xx',
  'requestfailed',
  'broken-image',
]);

function firstLine(s: string): string {
  const line = s.split('\n')[0]?.trim() ?? '';
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

function reproFor(actions: LoggedAction[], step: number, max = 12): LoggedAction[] {
  const upTo = actions.filter((a) => a.step <= step);
  return upTo.slice(-max);
}

/**
 * Attribute a signal to the action that most likely caused it. Async signals
 * (network/console/pageerror) often arrive a step or two after their trigger
 * and carry the wrong live `step`, so prefer timestamp ordering: the last
 * action whose ts <= the signal's timestamp. Actions are in ascending ts order.
 */
function attributeStep(sig: Signal, actions: LoggedAction[]): number {
  let best = sig.step ?? 0;
  for (const a of actions) {
    if (a.ts <= sig.at) best = a.step;
    else break;
  }
  return best;
}

export interface AggregateInput {
  signals: Signal[];
  actions: LoggedAction[];
  /** step → report-relative screenshot path. */
  screenshots: Map<number, string>;
}

export function aggregateFindings(input: AggregateInput): Finding[] {
  const { signals, actions, screenshots } = input;
  const byKey = new Map<string, Finding>();

  for (const sig of signals) {
    const meta = KIND_META[sig.kind];
    // Informational dialogs and benign customs below 'low' aren't findings.
    const severity = sig.severity ?? meta.defaultSeverity;
    // Fold the exact HTTP status into the key: the signature's digit-stripping
    // would otherwise merge a 401 and a 404 on the same route into one finding.
    const statusTag = typeof sig.meta?.status === 'number' ? `:${sig.meta.status}` : '';
    const keyUrl = RESOURCE_KINDS.has(sig.kind) ? '' : sig.url;
    const dedupKey = findingDedupKey(meta.category + statusTag, keyUrl, sig.detail);
    const step = attributeStep(sig, actions);
    const existing = byKey.get(dedupKey);

    if (existing) {
      existing.count += 1;
      if (step < existing.firstSeenStep) existing.firstSeenStep = step;
      continue;
    }

    const finding: Finding = {
      id: dedupKey,
      dedupKey,
      severity,
      category: meta.category,
      title: `${meta.label}: ${firstLine(sig.detail)}`.slice(0, 160),
      description: sig.detail,
      count: 1,
      location: {
        url: sig.url,
        selector: typeof sig.meta?.selector === 'string' ? sig.meta.selector : undefined,
      },
      reproSteps: reproFor(actions, step),
      firstSeenStep: step,
      artifacts: [],
    };
    byKey.set(dedupKey, finding);
  }

  // Attach screenshots by first-seen step.
  for (const finding of byKey.values()) {
    const shot = screenshots.get(finding.firstSeenStep);
    if (shot) {
      finding.artifacts.push({ type: 'screenshot', path: shot, mime: 'image/png' });
    }
  }

  const order: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  return [...byKey.values()].sort(
    (a, b) => order[a.severity] - order[b.severity] || b.count - a.count,
  );
}
