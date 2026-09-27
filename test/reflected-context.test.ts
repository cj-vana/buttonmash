import { describe, it, expect } from 'vitest';
import { findTextReflection, isSafeReflectionContext } from '../src/detectors/page-checks';

describe('findTextReflection', () => {
  const find = (html: string) => findTextReflection(html, html.toLowerCase(), 'canary');

  it('skips safe echoes and returns the first echo in page text', () => {
    const html = '<input value="canary"><title>canary</title><p>canary</p>';
    expect(find(html)).toBe(html.lastIndexOf('canary'));
  });

  it('returns -1 when every echo is in a safe context', () => {
    expect(find('<input value="canary"><textarea>canary</textarea>')).toBe(-1);
    expect(find('<p>nothing here</p>')).toBe(-1);
  });
});

// Helper: locate the marker and assert whether its context is "safe" (not a sink).
function safeAt(html: string, marker = 'CANARY'): boolean {
  const idx = html.toLowerCase().indexOf(marker.toLowerCase());
  if (idx === -1) throw new Error('marker not found');
  return isSafeReflectionContext(html.toLowerCase(), idx);
}

describe('isSafeReflectionContext', () => {
  it('treats <textarea> content as safe (RCDATA echo)', () => {
    expect(safeAt('<div><textarea>"\'<>canary</textarea></div>')).toBe(true);
  });

  it('treats an attribute value as safe', () => {
    expect(safeAt('<input type="text" value="canary">')).toBe(true);
  });

  it('treats <title>/<script>/<style> content as safe', () => {
    expect(safeAt('<title>canary</title>')).toBe(true);
    expect(safeAt('<script>var x="canary"</script>')).toBe(true);
    expect(safeAt('<style>/* canary */</style>')).toBe(true);
  });

  it('flags reflection in normal element text content as a potential sink', () => {
    expect(safeAt('<div>hello canary world</div>')).toBe(false);
  });

  it('flags reflection after a closed textarea (back in text content)', () => {
    expect(safeAt('<textarea>x</textarea><p>canary</p>')).toBe(false);
  });
});
