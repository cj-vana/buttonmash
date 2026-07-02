/**
 * Hashing and fingerprinting used for state coverage and dedup.
 *
 * - `fnv1a` is a fast, stable, non-cryptographic hash.
 * - element fingerprints identify the same logical control across runs.
 * - state fingerprints bucket near-duplicate UI states so the explorer can
 *   measure coverage and avoid looping forever on volatile content.
 */

import type { ElementDescriptor } from './types';

/** FNV-1a 32-bit hash → 8-char hex. */
export function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// utm_*/_* are prefix families; the rest must match the WHOLE param name —
// a bare prefix match ate `view`, `version`, `side`, `cbid`… so distinct pages
// normalized identically and were never crawled.
const VOLATILE_PARAM = /^(?:utm_|_)|^(?:sid|session|sess|token|ts|cb|nonce|csrf|xsrf|v|cache)$/i;

/** True when a fragment is a hash-router route (`#/…` or `#!…`), not a plain
 *  in-page anchor. */
const ROUTE_HASH_RE = /^#!?\//;

/**
 * Normalize a URL for state comparison: drop plain anchors, strip volatile
 * query params (session ids, cache-busters, csrf tokens), and sort the rest.
 * Hash-router routes (`#/items/3`) are KEPT — they are real pages; dropping
 * them collapsed a whole hash-routed SPA into one "page" that the crawler
 * marked visited after the first route. Invalid URLs are returned unchanged.
 */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    for (const k of [...u.searchParams.keys()]) {
      if (VOLATILE_PARAM.test(k)) u.searchParams.delete(k);
    }
    u.searchParams.sort();
    const hash = ROUTE_HASH_RE.test(u.hash) ? u.hash : '';
    u.hash = '';
    return u.origin + u.pathname + (u.search || '') + hash;
  } catch {
    return raw;
  }
}

/**
 * The path a URL routes to, for path-based guards (blocked/include/exclude,
 * login detection): the pathname plus a hash-router route, so `#/account/delete`
 * is guarded exactly like `/account/delete`.
 */
export function routePath(u: URL): string {
  return u.pathname + (ROUTE_HASH_RE.test(u.hash) ? u.hash.replace(/^#!?/, '') : '');
}

/**
 * A stable fingerprint for a logical control, identical across runs for the
 * same element. Derived from structural + semantic attributes, never from
 * volatile text alone.
 */
export function elementFingerprint(
  d: Pick<ElementDescriptor, 'tag' | 'type' | 'role' | 'name' | 'path'>,
): string {
  return fnv1a([d.tag, d.type ?? '', d.role ?? '', d.name, d.path].join('|'));
}

/**
 * Like {@link elementFingerprint} but text/value-free, so state hashing isn't
 * churned by live counters, clocks, or rotating copy. Position (path) + role
 * still distinguish distinct controls.
 */
export function structuralFingerprint(
  d: Pick<ElementDescriptor, 'tag' | 'type' | 'role' | 'path'>,
): string {
  return fnv1a([d.tag, d.type ?? '', d.role ?? '', d.path].join('|'));
}

/**
 * A fingerprint for the current UI state: normalized URL plus an
 * order-independent multiset of the interactive elements present.
 */
export function stateFingerprint(url: string, elementFps: readonly string[]): string {
  const structural = [...elementFps].sort().join(',');
  return fnv1a(normalizeUrl(url) + '#' + structural);
}

/**
 * Build a stable dedup key for a finding from its category, normalized
 * location, and a normalized detail signature (line numbers / addresses /
 * volatile ids stripped) so the "same bug" collapses across actions and runs.
 */
export function findingDedupKey(category: string, url: string, signature: string): string {
  const normSig = signature
    // URLs embedded in messages/stack frames carry volatile hash/query state
    // (SPA `#/routes`, cache-busters) — the same error thrown from
    // `app/:24:7` and `app/#detail:24:7` is one bug, not two. Peel the stack
    // frame's `:line:col` off before parsing (after a fragment it would vanish
    // with the hash, in a path it would survive — and the variants would
    // split), then drop the whole fragment: these reference scripts/resources,
    // where a fragment is never part of identity.
    .replace(/https?:\/\/[^\s)'"]+/gi, (u) =>
      normalizeUrl(u.replace(/:\d+:\d+$/, '').replace(/#.*$/, '')),
    )
    .replace(/0x[0-9a-f]+/gi, '0x_')
    .replace(/:\d+:\d+/g, ':_:_')
    .replace(/\b\d{3,}\b/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  return fnv1a([category, normalizeUrl(url), normSig].join('|'));
}
