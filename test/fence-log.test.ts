import { describe, expect, it } from 'vitest';

import { FenceLog } from '../src/guardrails/fence';

describe('FenceLog', () => {
  it('remembers aborted URLs and forgets the oldest past capacity', () => {
    const log = new FenceLog(2);
    log.record('https://app.test/a.woff2');
    log.record('https://app.test/b.woff2');
    log.record('https://app.test/a.woff2'); // refreshed, so b is now oldest
    log.record('https://app.test/c.woff2');

    expect(log.has('https://app.test/a.woff2')).toBe(true);
    expect(log.has('https://app.test/b.woff2')).toBe(false);
    expect(log.has('https://app.test/c.woff2')).toBe(true);
  });
});
