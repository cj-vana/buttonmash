/**
 * Secret scanning and redaction. Patterns are derived from gitleaks' default
 * ruleset. Two jobs:
 *   - `redact(text)` scrubs secrets out of anything we persist (reports,
 *     DOM snapshots, console logs) BEFORE it touches disk.
 *   - `scanForSecrets(text)` reports client-exposed *secret* keys (sk_/rk_/
 *     whsec_/AWS/etc.) as findings — these are real leaks the monkey stumbled
 *     on. Publishable keys (pk_) are NOT leaks; see guardrails/billing.ts.
 *
 * Ref: https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml
 */

export interface SecretRule {
  id: string;
  re: RegExp;
}

export const SECRET_RULES: SecretRule[] = [
  // No upper bound: `{10,99}` made keys with a >99-char tail match nothing at
  // all (not truncate), so a long live key was neither redacted nor reported.
  { id: 'stripe-secret-key', re: /\b(?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,}\b/g },
  { id: 'stripe-webhook-secret', re: /\bwhsec_[a-zA-Z0-9]{20,}\b/g },
  { id: 'aws-access-key-id', re: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b/g },
  { id: 'github-pat', re: /\bghp_[0-9a-zA-Z]{36}\b/g },
  { id: 'github-token', re: /\b(?:gho|ghu|ghs|ghr)_[0-9a-zA-Z]{36}\b/g },
  { id: 'gitlab-pat', re: /\bglpat-[\w-]{20}\b/g },
  { id: 'slack-bot-token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
  {
    id: 'slack-webhook',
    re: /https?:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9+/]{43,56}/g,
  },
  { id: 'gcp-api-key', re: /\bAIza[\w-]{35}\b/g },
  {
    id: 'openai-key',
    re: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}\b/g,
  },
  { id: 'anthropic-key', re: /\bsk-ant-api03-[a-zA-Z0-9_-]{93}AA\b/g },
  { id: 'sendgrid-key', re: /\bSG\.[a-zA-Z0-9_.-]{22}\.[a-zA-Z0-9_.-]{43}\b/g },
  { id: 'twilio-key', re: /\bSK[0-9a-fA-F]{32}\b/g },
  { id: 'shopify-token', re: /\bshpat_[a-fA-F0-9]{32}\b/g },
  { id: 'npm-token', re: /\bnpm_[a-z0-9]{36}\b/g },
  { id: 'google-oauth', re: /\b[0-9]+-[0-9A-Za-z_]{32}\.apps\.googleusercontent\.com\b/g },
  {
    id: 'jwt',
    re: /\bey[a-zA-Z0-9]{17,}\.ey[a-zA-Z0-9/_-]{17,}\.[a-zA-Z0-9/_-]{10,}={0,2}\b/g,
  },
  { id: 'private-key', re: /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----/g },
];

export interface RedactResult {
  redacted: string;
  /** secret-rule id → number of occurrences redacted. */
  hits: Record<string, number>;
}

/** Replace every detected secret with a typed placeholder. */
export function redact(text: string): RedactResult {
  let redacted = text;
  const hits: Record<string, number> = {};
  for (const { id, re } of SECRET_RULES) {
    redacted = redacted.replace(re, () => {
      hits[id] = (hits[id] ?? 0) + 1;
      return `[REDACTED:${id}]`;
    });
  }
  return { redacted, hits };
}

/** Convenience: just the scrubbed string. */
export function redactString(text: string): string {
  return redact(text).redacted;
}

export interface SecretHit {
  ruleId: string;
  /** Already-redacted surrounding context for the report. */
  context: string;
}

/** Redacted from artifacts but NOT reported as leaks: a session/CSRF JWT
 *  inlined into the HTML is how practically every authenticated SSR app works —
 *  reporting it as a high-severity secret-leak reddens normal builds. */
const REPORT_EXCLUDED = new Set(['jwt']);

/**
 * Find client-exposed secrets in a blob of page text. Publishable keys are
 * intentionally excluded — they belong to billing-mode detection, not leak
 * reporting.
 */
export function scanForSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const { id, re } of SECRET_RULES) {
    if (REPORT_EXCLUDED.has(id)) continue;
    // Fresh regex to avoid lastIndex state across calls on the shared /g rule.
    const rx = new RegExp(re.source, re.flags);
    let m: RegExpExecArray | null;
    while ((m = rx.exec(text)) !== null) {
      const start = Math.max(0, m.index - 24);
      const end = Math.min(text.length, m.index + m[0].length + 24);
      hits.push({ ruleId: id, context: redactString(text.slice(start, end)) });
      if (m.index === rx.lastIndex) rx.lastIndex++; // guard against zero-width
    }
  }
  return hits;
}

/** Header names whose values must never be persisted. */
export const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'proxy-authorization',
]);
