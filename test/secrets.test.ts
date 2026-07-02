import { describe, it, expect } from 'vitest';
import { redact, scanForSecrets } from '../src/guardrails/secrets';

describe('secrets', () => {
  it('redacts a Stripe secret key', () => {
    const { redacted, hits } = redact('key=sk_live_abcdefGHIJ1234567890zz more');
    expect(redacted).toContain('[REDACTED:stripe-secret-key]');
    expect(redacted).not.toContain('sk_live_abcdefGHIJ');
    expect(hits['stripe-secret-key']).toBe(1);
  });

  it('redacts GitHub PATs and AWS keys', () => {
    const r = redact('ghp_' + 'a'.repeat(36) + ' and AKIAIOSFODNN7EXAMPLE');
    expect(r.redacted).toContain('[REDACTED:github-pat]');
    expect(r.redacted).toContain('[REDACTED:aws-access-key-id]');
  });

  it('scanForSecrets finds secret keys but not publishable keys', () => {
    const hits = scanForSecrets('pk_test_aaaaaaaaaaaaaaaaa and sk_test_bbbbbbbbbbbbbbbbb');
    const ids = hits.map((h) => h.ruleId);
    expect(ids).toContain('stripe-secret-key');
    expect(ids).not.toContain('stripe-publishable'); // we never report pk_
    // context is itself redacted
    expect(hits.every((h) => !h.context.includes('sk_test_bbbb'))).toBe(true);
  });

  it('returns no hits on clean text', () => {
    expect(scanForSecrets('just some harmless text')).toHaveLength(0);
  });
});

describe('secret rule bounds', () => {
  it('redacts and reports Stripe keys longer than 99 chars (used to bypass entirely)', () => {
    const long = 'sk_live_' + 'a'.repeat(120);
    const { redacted } = redact(`key=${long}`);
    expect(redacted).toContain('[REDACTED:stripe-secret-key]');
    expect(redacted).not.toContain('sk_live_aaaa');
    expect(scanForSecrets(long).map((h) => h.ruleId)).toContain('stripe-secret-key');
  });

  it('redacts JWTs but does not report them as leaks (every SSR app inlines one)', () => {
    const jwt = 'ey' + 'a'.repeat(20) + '.ey' + 'b'.repeat(20) + '.' + 'c'.repeat(20);
    expect(redact(`token=${jwt}`).redacted).toContain('[REDACTED:jwt]');
    expect(scanForSecrets(jwt).map((h) => h.ruleId)).not.toContain('jwt');
  });
});
