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

  it('interpolates ${ENV} in headers, basic-auth, and login credentials', async () => {
    process.env.BM_TEST_TOKEN = 'sekret-123';
    process.env.BM_TEST_PASS = 'pw-456';
    const cfg = await loadConfig({
      ignoreConfigFile: true,
      overrides: {
        target: 'https://x.test',
        headers: { Authorization: 'Bearer ${BM_TEST_TOKEN}' },
        auth: {
          basicAuth: { username: 'u', password: '${BM_TEST_PASS}' },
          loginScript: {
            url: '/login',
            usernameSelector: '#u',
            passwordSelector: '#p',
            username: 'admin',
            password: '${BM_TEST_PASS}',
          },
        },
      },
    });
    expect(cfg.headers.Authorization).toBe('Bearer sekret-123');
    expect(cfg.auth.basicAuth?.password).toBe('pw-456');
    expect(cfg.auth.loginScript?.password).toBe('pw-456');
    delete process.env.BM_TEST_TOKEN;
    delete process.env.BM_TEST_PASS;
  });

  it('resolves path-scope globs and defaults crawl on', async () => {
    const cfg = await loadConfig({
      ignoreConfigFile: true,
      overrides: {
        target: 'https://x.test',
        guardrails: { includePaths: ['^/app/'], excludePaths: ['/admin'] },
      },
    });
    expect(cfg.guardrails.includePaths).toEqual(['^/app/']);
    expect(cfg.guardrails.excludePaths).toEqual(['/admin']);
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

  it('resolves a baseline path and requires one for fail-on-new mode', async () => {
    const cfg = await loadConfig({
      ignoreConfigFile: true,
      cwd: '/tmp/buttonmash-project',
      overrides: {
        target: 'https://x.test',
        baseline: { path: 'reports/previous.json', failOnNew: true },
      },
    });
    expect(cfg.baseline.path).toBe('/tmp/buttonmash-project/reports/previous.json');
    expect(cfg.baseline.failOnNew).toBe(true);

    await expect(
      loadConfig({
        ignoreConfigFile: true,
        overrides: { target: 'https://x.test', baseline: { failOnNew: true } },
      }),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});

describe('additive CLI lists and credential hygiene', () => {
  it('append.allowedOrigins adds to (not replaces) configured origins', async () => {
    const cfg = await loadConfig({
      ignoreConfigFile: true,
      overrides: {
        target: 'https://a.example.com',
        guardrails: { allowedOrigins: ['https://api.example.com'] },
      },
      append: { allowedOrigins: ['https://cdn.example.com'] },
    });
    expect(cfg.guardrails.allowedOrigins).toContain('https://api.example.com');
    expect(cfg.guardrails.allowedOrigins).toContain('https://cdn.example.com');
    expect(cfg.guardrails.allowedOrigins).toContain('https://a.example.com');
  });

  it('append.routes adds to configured routes', async () => {
    const cfg = await loadConfig({
      ignoreConfigFile: true,
      overrides: { target: 'https://a.example.com', routes: ['/one'] },
      append: { routes: ['/two'] },
    });
    expect(cfg.routes).toContain('https://a.example.com/one');
    expect(cfg.routes).toContain('https://a.example.com/two');
  });

  it('moves credentials in the target URL into basicAuth and strips them', async () => {
    const cfg = await loadConfig({
      ignoreConfigFile: true,
      overrides: { target: 'https://admin:hunter2@staging.example.com/app' },
    });
    expect(cfg.target).toBe('https://staging.example.com/app');
    expect(cfg.auth.basicAuth).toEqual({ username: 'admin', password: 'hunter2' });
  });
});
