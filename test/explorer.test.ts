import { describe, it, expect } from 'vitest';
import { Explorer } from '../src/explorer/explorer';
import { Rng } from '../src/core/rng';
import type { ElementDescriptor } from '../src/core/types';

function els(...fps: string[]): ElementDescriptor[] {
  return fps.map((fp) => ({
    fp,
    structuralFp: fp,
    tag: 'button',
    type: null,
    role: null,
    name: fp,
    editable: false,
    path: fp,
    selector: `#${fp}`,
  }));
}

describe('Explorer', () => {
  it('tracks new vs seen states', () => {
    const e = new Explorer(new Rng('s'), 0);
    expect(e.isNewState('a')).toBe(true);
    e.markState('a');
    expect(e.isNewState('a')).toBe(false);
    expect(e.statesDiscovered).toBe(1);
  });

  it('prefers unexercised elements when epsilon = 0', () => {
    const e = new Explorer(new Rng('s'), 0);
    const all = els('a', 'b', 'c');
    const first = e.choose('state', all)!;
    const second = e.choose('state', all)!;
    const third = e.choose('state', all)!;
    // Three distinct elements get exercised before any repeat.
    expect(new Set([first.fp, second.fp, third.fp]).size).toBe(3);
  });

  it('is deterministic for a given seed', () => {
    const run = () => {
      const e = new Explorer(new Rng('seed-42'), 0.2);
      const all = els('a', 'b', 'c', 'd', 'e');
      return Array.from({ length: 12 }, () => e.choose('state', all)!.fp);
    };
    expect(run()).toEqual(run());
  });

  it('returns undefined for an empty element set', () => {
    const e = new Explorer(new Rng('s'), 0);
    expect(e.choose('state', [])).toBeUndefined();
  });

  it('stops offering a control that timed out, on that page only', () => {
    const e = new Explorer(new Rng('s'), 0.5);
    e.markUnreachable('http://app.test/editor', 'a');
    expect(e.reachable('http://app.test/editor', els('a', 'b')).map((el) => el.fp)).toEqual(['b']);
    expect(e.reachable('http://app.test/other', els('a', 'b')).map((el) => el.fp)).toEqual([
      'a',
      'b',
    ]);
  });
});
