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

  it('keeps a neighbouring secret cut by the context window out of the context', () => {
    const aws = 'AKIA' + 'IOSFODNN7EXAMPL2';
    const gh = 'ghp_' + 'Q7w9E2r4T6y8U1i3O5p7A9s2D4f6G8h1J3k5';
    const page = `<script>window.cfg={"a":"${aws}","g":"${gh}"}</script>`;
    const hits = scanForSecrets(page);
    expect(hits.map((h) => h.ruleId).sort()).toEqual(['aws-access-key-id', 'github-pat']);
    for (const hit of hits) {
      expect(hit.context).not.toContain(aws.slice(4, 12));
      expect(hit.context).not.toContain(gh.slice(4, 12));
    }
  });

  it('redacts the key id in a presigned URL but does not report it as a leak', () => {
    // AKIA/ASIA + 16 of [A-Z2-7], the aws-access-key-id quantifiers.
    for (const key of ['AKIA' + 'IOSFODNN7EXAMPL2', 'ASIA' + 'Y34FZKBOKMUTVV7A']) {
      const img =
        `<img src="https://b.s3.amazonaws.com/cat.png?X-Amz-Algorithm=AWS4-HMAC-SHA256` +
        `&amp;X-Amz-Credential=${key}%2F20260926%2Fus-east-1%2Fs3%2Faws4_request` +
        `&amp;X-Amz-Signature=abc123">`;
      expect(redact(img).redacted).not.toContain(key);
      expect(scanForSecrets(img)).toEqual([]);
      // The same key anywhere else is still a leak.
      expect(scanForSecrets(`${img} const aws = "${key}";`).map((h) => h.ruleId)).toEqual([
        'aws-access-key-id',
      ]);
    }
  });

  it('does not report a placeholder the page already contained', () => {
    expect(scanForSecrets('docs: we log [REDACTED:github-pat] instead of tokens')).toEqual([]);
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

  it('redacts and reports GitLab tokens in both the classic and routable forms', () => {
    // Built from gitleaks' gitlab-pat (glpat- + 20 of [\w-]) and
    // gitlab-pat-routable (glpat- + 27..300 of [0-9a-zA-Z_-] + . + 2 + 7 of [0-9a-z]).
    const classic = 'glpat-' + 'a1B2c'.repeat(4);
    const routable = 'glpat-' + 'a1B2c3D4e5'.repeat(3) + '.' + '0a' + 'b1c2d3e';
    for (const [token, id] of [
      [classic, 'gitlab-pat'],
      [routable, 'gitlab-pat-routable'],
    ]) {
      const text = `token="${token}"`;
      expect(redact(text).redacted).toBe(`token="[REDACTED:${id}]"`);
      expect(scanForSecrets(text).map((h) => h.ruleId)).toEqual([id]);
    }
  });

  it('redacts a whole PEM private key, body and END line included', () => {
    const line = 'MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun';
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      line,
      [...line].reverse().join(''),
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const { redacted } = redact(`config loaded: ${pem} done`);
    expect(redacted).toBe('config loaded: [REDACTED:private-key] done');
    expect(scanForSecrets(pem).map((h) => h.ruleId)).toContain('private-key');
  });

  it('redacts the body of a PEM key cut off before its END line', () => {
    const line = 'MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun';
    const { redacted } = redact(`key: -----BEGIN PRIVATE KEY-----\n${line}\n${line.slice(0, 20)}`);
    expect(redacted).toBe('key: [REDACTED:private-key]');
  });

  it('redacts JWTs but does not report them as leaks (every SSR app inlines one)', () => {
    const jwt = 'ey' + 'a'.repeat(20) + '.ey' + 'b'.repeat(20) + '.' + 'c'.repeat(20);
    expect(redact(`token=${jwt}`).redacted).toContain('[REDACTED:jwt]');
    expect(scanForSecrets(jwt).map((h) => h.ruleId)).not.toContain('jwt');
  });
});
