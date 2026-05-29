import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError } from '../src/config/load';

describe('loadConfig', () => {
  it('resolves defaults and derives the origin allowlist from the target', async () => {
    const cfg = await loadConfig({
      ignoreConfigFile: true,
      overrides: { target: 'https://staging.example.com/app' },
    });
    expect(cfg.target).toBe('https://staging.example.com/app');
    expect(cfg.guardrails.allowedOrigins).toEqual(['https://staging.example.com']);
    expect(cfg.seed).toBeTruthy();
    expect(cfg.failOn).toBe('high');
    expect(cfg.guardrails.billing.mode).toBe('refuse');
    expect(cfg.budget.maxActions).toBeGreaterThan(0);
  });

  it('always includes the target origin in a custom allowlist', async () => {
    const cfg = await loadConfig({
      ignoreConfigFile: true,
      overrides: {
        target: 'https://a.example.com',
        guardrails: { allowedOrigins: ['https://b.example.com'] },
      },
    });
    expect(cfg.guardrails.allowedOrigins).toContain('https://a.example.com');
    expect(cfg.guardrails.allowedOrigins).toContain('https://b.example.com');
  });

  it('throws ConfigError when no target is given', async () => {
    await expect(loadConfig({ ignoreConfigFile: true, overrides: {} })).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  it('throws ConfigError on an invalid target URL', async () => {
    await expect(
      loadConfig({ ignoreConfigFile: true, overrides: { target: 'not-a-url' } }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('resolves relative routes against the target and allows their origins', async () => {
    const cfg = await loadConfig({
      ignoreConfigFile: true,
      overrides: {
        target: 'https://app.example.com/dashboard',
        routes: ['/a', '/b/c', 'https://app.example.com/d'],
      },
    });
    expect(cfg.routes).toEqual([
      'https://app.example.com/a',
      'https://app.example.com/b/c',
      'https://app.example.com/d',
    ]);
    expect(cfg.guardrails.allowedOrigins).toContain('https://app.example.com');
    expect(cfg.explore.crawl).toBe(true); // auto-crawl on by default
  });

  it('rejects invalid enum values', async () => {
    await expect(
      loadConfig({
        ignoreConfigFile: true,
        // @ts-expect-error intentionally bad
        overrides: { target: 'https://x.test', failOn: 'apocalyptic' },
      }),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});
