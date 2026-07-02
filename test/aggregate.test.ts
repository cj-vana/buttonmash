import { describe, it, expect } from 'vitest';
import { aggregateFindings } from '../src/detectors/aggregate';
import type { LoggedAction, Signal } from '../src/core/types';

function sig(over: Partial<Signal>): Signal {
  return {
    kind: 'pageerror',
    detail: 'boom',
    url: 'http://localhost:3000/',
    at: 0,
    step: 0,
    ...over,
  };
}

describe('aggregateFindings', () => {
  it('collapses repeated signals into one finding with a count', () => {
    const signals: Signal[] = [
      sig({ detail: 'Error at app.js:100:5', step: 1 }),
      sig({ detail: 'Error at app.js:233:9', step: 4 }),
      sig({ detail: 'Error at app.js:512:1', step: 9 }),
    ];
    const findings = aggregateFindings({ signals, actions: [], screenshots: new Map() });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.count).toBe(3);
    expect(findings[0]!.firstSeenStep).toBe(1);
  });

  it('keeps distinct categories separate and sorts by severity', () => {
    const signals: Signal[] = [
      sig({ kind: 'broken-image', detail: '/a.png', severity: 'low' }),
      sig({ kind: 'pageerror', detail: 'kaboom', severity: 'high' }),
      sig({ kind: 'crash', detail: 'renderer crashed', severity: 'critical' }),
    ];
    const findings = aggregateFindings({ signals, actions: [], screenshots: new Map() });
    expect(findings.map((f) => f.severity)).toEqual(['critical', 'high', 'low']);
  });

  it('attaches a screenshot by first-seen step and a minimal repro trace', () => {
    const actions: LoggedAction[] = [
      { step: 0, kind: 'click', stateHash: 's', url: 'u', ts: 0 },
      { step: 1, kind: 'type', stateHash: 's', url: 'u', ts: 0, value: 'x' },
      { step: 2, kind: 'click', stateHash: 's', url: 'u', ts: 0 },
    ];
    const screenshots = new Map<number, string>([[2, 'artifacts/step-2.png']]);
    const findings = aggregateFindings({
      signals: [sig({ detail: 'late error', step: 2 })],
      actions,
      screenshots,
    });
    expect(findings[0]!.artifacts[0]?.path).toBe('artifacts/step-2.png');
    expect(findings[0]!.reproSteps.length).toBe(3);
  });
});

describe('http status dedup', () => {
  it('keeps a 401 and a 404 on the same route as distinct findings', () => {
    const signals: Signal[] = [
      sig({ kind: 'http.4xx', detail: '401 http://x.test/api/a', meta: { status: 401 } }),
      sig({ kind: 'http.4xx', detail: '404 http://x.test/api/a', meta: { status: 404 } }),
    ];
    const findings = aggregateFindings({ signals, actions: [], screenshots: new Map() });
    expect(findings).toHaveLength(2);
  });
});

describe('resource-scoped network dedup', () => {
  it('merges the same failing resource seen from different pages', () => {
    const signals: Signal[] = [
      sig({ kind: 'http.4xx', detail: '404 http://x.test/api/boom', url: 'http://x.test/#/a', meta: { status: 404 } }),
      sig({ kind: 'http.4xx', detail: '404 http://x.test/api/boom', url: 'http://x.test/#/b', meta: { status: 404 } }),
    ];
    const findings = aggregateFindings({ signals, actions: [], screenshots: new Map() });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.count).toBe(2);
  });

  it('keeps the same JS error on different pages distinct', () => {
    const signals: Signal[] = [
      sig({ kind: 'pageerror', detail: 'boom', url: 'http://x.test/#/a' }),
      sig({ kind: 'pageerror', detail: 'boom', url: 'http://x.test/#/b' }),
    ];
    expect(aggregateFindings({ signals, actions: [], screenshots: new Map() })).toHaveLength(2);
  });
});
