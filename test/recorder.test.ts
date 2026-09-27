import { describe, expect, it } from 'vitest';

import { SignalRecorder } from '../src/detectors/recorder';
import { redactString } from '../src/guardrails/secrets';

const token = 'ghp_' + 'a1B2'.repeat(9);
const awsKey = 'AKIA' + 'IOSFODNN7EXAMPL2';

describe('SignalRecorder', () => {
  it('redacts detail, url and string meta values before storing them', () => {
    const recorder = new SignalRecorder(redactString);
    recorder.setContext(4, `https://app.test/cb?token=${token}`);
    recorder.add('dialog', `alert: Your deploy token is ${token}`, {
      meta: { source: `https://cdn.test/?k=${awsKey}`, status: 403, thirdParty: true },
    });
    recorder.add('broken-image', `https://b.test/cat.png?X-Amz-Credential=${awsKey}`, {
      url: `https://app.test/gallery?token=${token}`,
    });

    const stored = JSON.stringify(recorder.signals);
    expect(stored).not.toContain(token);
    expect(stored).not.toContain(awsKey);
    const [dialog, image] = recorder.signals;
    expect(dialog!.detail).toBe('alert: Your deploy token is [REDACTED:github-pat]');
    expect(dialog!.url).toBe('https://app.test/cb?token=[REDACTED:github-pat]');
    expect(dialog!.meta).toEqual({
      source: 'https://cdn.test/?k=[REDACTED:aws-access-key-id]',
      status: 403,
      thirdParty: true,
    });
    expect(dialog!.step).toBe(4);
    expect(image!.url).toBe('https://app.test/gallery?token=[REDACTED:github-pat]');
  });

  it('leaves detail that a call site already redacted unchanged', () => {
    const recorder = new SignalRecorder(redactString);
    const once = redactString(`console: ${token} and ${awsKey}`);
    recorder.add('console.error', once);
    expect(recorder.signals[0]!.detail).toBe(once);
  });

  it('stores text as given when constructed without a redactor', () => {
    const recorder = new SignalRecorder();
    recorder.add('dialog', `alert: ${token}`);
    expect(recorder.signals[0]!.detail).toBe(`alert: ${token}`);
  });
});
