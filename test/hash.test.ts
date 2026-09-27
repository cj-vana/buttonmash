import { describe, it, expect } from 'vitest';
import {
  fnv1a,
  normalizeUrl,
  elementFingerprint,
  structuralFingerprint,
  stateFingerprint,
  findingDedupKey,
} from '../src/core/hash';
import { Rng } from '../src/core/rng';
import { fuzzValue } from '../src/explorer/fuzz';

describe('hash', () => {
  it('fnv1a is stable and 8 hex chars', () => {
    expect(fnv1a('hello')).toBe(fnv1a('hello'));
    expect(fnv1a('hello')).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1a('a')).not.toBe(fnv1a('b'));
  });

  it('normalizeUrl strips volatile params + hash, sorts the rest', () => {
    const n = normalizeUrl('https://x.test/p?b=2&utm_source=ad&a=1&session=zzz#frag');
    expect(n).toBe('https://x.test/p?a=1&b=2');
  });

  it('normalizeUrl returns invalid urls unchanged', () => {
    expect(normalizeUrl('not a url')).toBe('not a url');
  });

  it('elementFingerprint is stable across identical descriptors', () => {
    const d = { tag: 'button', type: null, role: null, name: 'Save', path: 'body:0>button:1' };
    expect(elementFingerprint(d)).toBe(elementFingerprint({ ...d }));
  });

  it('structuralFingerprint ignores text so live counters/clocks do not churn state', () => {
    const a = { tag: 'span', type: null, role: null, path: 'body:0>span:2' };
    // same structure, different visible text → same structural fp (no churn)
    expect(structuralFingerprint({ ...a })).toBe(structuralFingerprint({ ...a }));
    // but a different position is still a different control
    expect(structuralFingerprint(a)).not.toBe(
      structuralFingerprint({ ...a, path: 'body:0>span:3' }),
    );
    // and elementFingerprint (which DOES include name) differs on text
    expect(elementFingerprint({ ...a, name: '3 minutes ago' })).not.toBe(
      elementFingerprint({ ...a, name: '4 minutes ago' }),
    );
  });

  it('stateFingerprint is order-independent over elements', () => {
    const url = 'https://x.test/a';
    expect(stateFingerprint(url, ['a', 'b', 'c'])).toBe(stateFingerprint(url, ['c', 'b', 'a']));
    expect(stateFingerprint(url, ['a', 'b'])).not.toBe(stateFingerprint(url, ['a', 'b', 'c']));
  });

  it('findingDedupKey collapses volatile numbers and line:col', () => {
    const a = findingDedupKey('js-error', 'https://x.test/p', 'Error at app.js:100:5');
    const b = findingDedupKey('js-error', 'https://x.test/p', 'Error at app.js:288:91');
    expect(a).toBe(b);
  });

  it('findingDedupKey collapses stack URLs that differ only by SPA hash state', () => {
    const stack = (frag: string) =>
      `intentional error\nError: intentional error\n    at boom (https://x.test/${frag}:110:15)`;
    const a = findingDedupKey('js-error', 'https://x.test/', stack(''));
    const b = findingDedupKey(
      'js-error',
      'https://x.test/#shadow-clicked',
      stack('#shadow-clicked'),
    );
    expect(a).toBe(b);
  });

  it('findingDedupKey collapses stack URLs that differ only by cache-buster query', () => {
    const a = findingDedupKey(
      'js-error',
      'https://x.test/',
      'at fn (https://cdn.test/app.js?v=111:1:2)',
    );
    const b = findingDedupKey(
      'js-error',
      'https://x.test/',
      'at fn (https://cdn.test/app.js?v=222:3:4)',
    );
    expect(a).toBe(b);
  });

  it('findingDedupKey ignores which reflected-input canary was typed', () => {
    // Canaries come from fuzz.ts and field-values.ts: cnry + 8 hex (fnv1a) + zz.
    // Each seed and step types a different one, so the same bug reached through
    // typed input must not get a new key per canary.
    const [c1, c2] = ['cnry1a2b3c4dzz', 'cnry9f8e7d6czz'];
    const http500 = (c: string) => `500 https://x.test/api/search?q=${c}&page=2`;
    expect(findingDedupKey('http-5xx:500', '', http500(c1))).toBe(
      findingDedupKey('http-5xx:500', '', http500(c2)),
    );
    const probe = (c: string) => `500 https://x.test/api/items?name=%22'%3C%3E${c}`;
    expect(findingDedupKey('http-5xx:500', '', probe(c1))).toBe(
      findingDedupKey('http-5xx:500', '', probe(c2)),
    );
    const thrown = (c: string) => `TypeError: cannot parse "seed ${c}" as a date`;
    expect(findingDedupKey('js-error', 'https://x.test/', thrown(c1))).toBe(
      findingDedupKey('js-error', 'https://x.test/', thrown(c2)),
    );
    // The page URL can carry the canary too (a search results page).
    expect(findingDedupKey('js-error', `https://x.test/search?q=${c1}`, 'boom')).toBe(
      findingDedupKey('js-error', `https://x.test/search?q=${c2}`, 'boom'),
    );
  });

  it('findingDedupKey collapses canaries from the real fuzz builder', () => {
    const canary = (runId: string, step: number) => fuzzValue(new Rng('s'), runId, step).canary;
    const [a, b] = [canary('seed-a', 3), canary('seed-b', 40)];
    expect(a).not.toBe(b);
    expect(findingDedupKey('js-error', 'https://x.test/', `bad input ${a}`)).toBe(
      findingDedupKey('js-error', 'https://x.test/', `bad input ${b}`),
    );
  });

  it('findingDedupKey leaves text that is not a canary alone', () => {
    const key = (sig: string) => findingDedupKey('js-error', 'https://x.test/', sig);
    expect(key('cannot read "name"')).not.toBe(key('cannot read "nome"'));
    // Wrong length or alphabet: not a canary, so still distinct.
    expect(key('token cnry1a2b3czz')).not.toBe(key('token cnry9f8e7dzz'));
    expect(key('token cnry1a2b3c4gzz')).not.toBe(key('token cnry9f8e7d6gzz'));
  });

  it('findingDedupKey keeps genuinely different resources distinct', () => {
    const a = findingDedupKey('http-4xx', 'https://x.test/', '404 https://x.test/a.png');
    const b = findingDedupKey('http-4xx', 'https://x.test/', '404 https://x.test/b.png');
    expect(a).not.toBe(b);
  });
});

describe('normalizeUrl param precision', () => {
  it('keeps whole params that merely start with a volatile name', () => {
    expect(normalizeUrl('https://x.test/items?view=list')).toBe('https://x.test/items?view=list');
    expect(normalizeUrl('https://x.test/items?version=2')).toBe('https://x.test/items?version=2');
    expect(normalizeUrl('https://x.test/items?side=left')).toBe('https://x.test/items?side=left');
  });

  it('still strips exact volatile params and prefix families', () => {
    expect(normalizeUrl('https://x.test/p?v=123&utm_campaign=x&_t=9&a=1')).toBe(
      'https://x.test/p?a=1',
    );
    expect(normalizeUrl('https://x.test/p?session=abc&token=zzz')).toBe('https://x.test/p');
  });
});

describe('hash-router routes', () => {
  it('normalizeUrl keeps #/ and #!/ routes but drops plain anchors', () => {
    expect(normalizeUrl('https://x.test/app#/items/3')).toBe('https://x.test/app#/items/3');
    expect(normalizeUrl('https://x.test/app#!/items/3')).toBe('https://x.test/app#!/items/3');
    expect(normalizeUrl('https://x.test/app#section')).toBe('https://x.test/app');
  });

  it('distinct hash routes are distinct pages for state coverage', () => {
    expect(stateFingerprint('https://x.test/#/a', ['f'])).not.toBe(
      stateFingerprint('https://x.test/#/b', ['f']),
    );
  });

  it('routePath folds a hash route into the path for guards', async () => {
    const { routePath } = await import('../src/core/hash');
    expect(routePath(new URL('https://x.test/app#/account/delete'))).toBe('/app/account/delete');
    expect(routePath(new URL('https://x.test/app#top'))).toBe('/app');
    expect(routePath(new URL('https://x.test/login'))).toBe('/login');
  });

  it('stack URLs still dedup across hash-route state', () => {
    const stack = (frag: string) => `boom\n    at fn (https://x.test/${frag}:10:5)`;
    expect(findingDedupKey('js-error', 'https://x.test/', stack(''))).toBe(
      findingDedupKey('js-error', 'https://x.test/', stack('#/items/9')),
    );
  });
});
