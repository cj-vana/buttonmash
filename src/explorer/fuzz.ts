/**
 * Safe input fuzzing. The corpus is chosen to surface bugs (boundary numbers,
 * very long strings, unicode/RTL/emoji, format-string tokens, empty/whitespace,
 * special chars for an encoding check) WITHOUT being an attack: there are no
 * executing payloads. Each value carries a unique, harmless canary so we can
 * later detect unsanitized reflection (a possible XSS sink) passively.
 */
import { fnv1a } from '../core/hash';
import type { Rng } from '../core/rng';

/** Build the deterministic corpus for a given canary. */
function corpusFor(canary: string): string[] {
  return [
    '',
    ' ',
    '\t\n',
    '0',
    '-1',
    '1',
    '2147483647',
    '2147483648',
    '-2147483648',
    '9999999999999999',
    '1e308',
    'NaN',
    'null',
    'undefined',
    'true',
    'A'.repeat(5000), // very long
    '\u{1F600}\u{1F4A9}\u{1F680}', // emoji
    '‮evil‭', // RTL override
    'éüñ中文', // accented + CJK
    '%s %d %x %n {0} {{7*7}} ${7*7}', // format-string-ish (inert here)
    `'"<>&`, // special chars for encoding check
    canary, // pure reflection probe
    `"'<>${canary}`, // reflection + unencoded-char probe
  ];
}

export interface FuzzValue {
  value: string;
  canary: string;
  /** Whether this value is a reflection probe worth tracking. */
  probe: boolean;
}

/** Pick a deterministic fuzz value (and canary) for a given run + step. */
export function fuzzValue(rng: Rng, runId: string, step: number): FuzzValue {
  const canary = `cnry${fnv1a(`${runId}:${step}`)}zz`;
  const corpus = corpusFor(canary);
  const value = rng.pick(corpus);
  return { value, canary, probe: value.includes(canary) };
}

/** Boundary numbers for `<input type=number>`, which rejects any non-numeric
 *  text before the app sees it. */
const NUMERIC_CORPUS = [
  '0',
  '-1',
  '1',
  '0.1',
  '-0',
  '2147483647',
  '2147483648',
  '-2147483648',
  '9999999999999999',
  '1e308',
] as const;

export function numericFuzzValue(rng: Rng): string {
  return rng.pick(NUMERIC_CORPUS);
}

/** A small set of "interesting" keyboard keys to press at random. */
export const FUZZ_KEYS = [
  'Enter',
  'Escape',
  'Tab',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  ' ',
  'a',
  'z',
] as const;
