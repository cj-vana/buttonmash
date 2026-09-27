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
  // gitleaks' routable form: these tokens run past 20 chars, where the rule
  // above's trailing \b can never match.
  {
    id: 'gitlab-pat-routable',
    re: /\bglpat-[0-9a-zA-Z_-]{27,300}\.[0-9a-z]{2}[0-9a-z]{7}\b/g,
  },
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
  // gitleaks' form runs from BEGIN through the END line. The second branch
  // takes the base64 run after a BEGIN whose END never arrives (a log line cut
  // short), so the body goes too; it may also take words that follow it.
  {
    id: 'private-key',
    re: /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----(?:[\s\S-]{64,}?KEY(?: BLOCK)?-----|[A-Za-z0-9+/=\s\\]*)/g,
  },
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

const PLACEHOLDER_RE = /\[REDACTED:([a-z0-9-]+)\]/g;

/**
 * Find client-exposed secrets in a blob of page text. Publishable keys are
 * intentionally excluded — they belong to billing-mode detection, not leak
 * reporting.
 */
export function scanForSecrets(text: string): SecretHit[] {
  // Redact the whole text before cutting context windows: a neighbouring
  // secret cut in half by a window edge no longer matches its rule.
  const { redacted, hits: redactedCounts } = redact(text);
  const unclaimed = { ...redactedCounts };
  const hits: SecretHit[] = [];
  for (const m of redacted.matchAll(PLACEHOLDER_RE)) {
    const id = m[1]!;
    // More placeholders than redactions means the page itself contains one.
    if (!unclaimed[id]) continue;
    unclaimed[id] -= 1;
    if (REPORT_EXCLUDED.has(id)) continue;
    const start = Math.max(0, m.index - 24);
    const end = Math.min(redacted.length, m.index + m[0].length + 24);
    hits.push({ ruleId: id, context: redacted.slice(start, end) });
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
