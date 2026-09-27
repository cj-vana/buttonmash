import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError } from '../src/config/load';
import { buttonmash } from '../src/index';

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

  it('refuses a ${ENV} reference to an unset variable, naming it and the field', async () => {
    // A missing CI secret must not become an empty password or Authorization header.
    delete process.env.BM_TEST_UNSET;
    const loginScript = {
      url: '/login',
      usernameSelector: '#u',
      passwordSelector: '#p',
      username: 'admin',
      password: '${BM_TEST_UNSET}',
    };
    for (const [overrides, field] of [
      [{ auth: { loginScript } }, 'auth.loginScript.password'],
      [
        { auth: { basicAuth: { username: '${BM_TEST_UNSET}', password: 'p' } } },
        'auth.basicAuth.username',
      ],
      [{ headers: { Authorization: 'Bearer ${BM_TEST_UNSET}' } }, 'headers.Authorization'],
    ] as const) {
      const load = loadConfig({
        ignoreConfigFile: true,
        overrides: { target: 'https://x.test', ...overrides },
      });
      await expect(load).rejects.toBeInstanceOf(ConfigError);
      await expect(load).rejects.toThrow(/BM_TEST_UNSET/);
      await expect(load).rejects.toThrow(field);
    }
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

  it('rejects a destructive safe-name pattern that is not a valid regex', async () => {
    const cfg = await loadConfig({
      ignoreConfigFile: true,
      overrides: {
        target: 'https://x.test',
        guardrails: { destructive: { safeNames: ['^reset zoom$'] } },
      },
    });
    expect(cfg.guardrails.destructive.safeNames).toEqual(['^reset zoom$']);

    await expect(
      loadConfig({
        ignoreConfigFile: true,
        overrides: {
          target: 'https://x.test',
          guardrails: { destructive: { safeNames: ['reset ('] } },
        },
      }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('rejects every invalid regex field instead of dropping the pattern', async () => {
    // A dropped blockedPathPatterns entry silently removes a safety block, and
    // an all-invalid includePaths widens the crawl to the whole site.
    const bad = 'reset (';
    const cases: [Record<string, unknown>, string][] = [
      [{ guardrails: { blockedPathPatterns: ['^/ok$', bad] } }, 'guardrails.blockedPathPatterns.1'],
      [{ guardrails: { includePaths: [bad] } }, 'guardrails.includePaths.0'],
      [{ guardrails: { excludePaths: [bad] } }, 'guardrails.excludePaths.0'],
      [{ detectors: { ignorePatterns: [bad] } }, 'detectors.ignorePatterns.0'],
      [{ detectors: { custom: [{ name: 'x', pattern: bad }] } }, 'detectors.custom.0.pattern'],
      [{ auth: { loginUrlPattern: bad } }, 'auth.loginUrlPattern'],
    ];
    for (const [overrides, field] of cases) {
      const load = loadConfig({
        ignoreConfigFile: true,
        overrides: { target: 'https://x.test', ...overrides },
      });
      await expect(load).rejects.toBeInstanceOf(ConfigError);
      await expect(load).rejects.toThrow(`${field}: must be a valid regular expression`);
    }
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

  it('normalizes allowed origins from the config and from --allow-origin', async () => {
    // The fence compares exact origins, so a trailing slash or upper-case host
    // would otherwise allow nothing.
    const cfg = await loadConfig({
      ignoreConfigFile: true,
      overrides: {
        target: 'https://a.example.test',
        guardrails: { allowedOrigins: ['https://auth.example.test/', 'https://A.example.test'] },
      },
      append: { allowedOrigins: ['https://CDN.example.test/assets/app.js'] },
    });
    expect(cfg.guardrails.allowedOrigins.sort()).toEqual([
      'https://a.example.test',
      'https://auth.example.test',
      'https://cdn.example.test',
    ]);
  });

  it('rejects an allowed origin that does not parse, naming where it came from', async () => {
    const fromConfig = loadConfig({
      ignoreConfigFile: true,
      overrides: {
        target: 'https://a.example.test',
        guardrails: { allowedOrigins: ['auth.example.test'] },
      },
    });
    await expect(fromConfig).rejects.toBeInstanceOf(ConfigError);
    await expect(fromConfig).rejects.toThrow(/guardrails\.allowedOrigins.*auth\.example\.test/);

    const fromFlag = loadConfig({
      ignoreConfigFile: true,
      overrides: { target: 'https://a.example.test' },
      append: { allowedOrigins: ['cdn example'] },
    });
    await expect(fromFlag).rejects.toBeInstanceOf(ConfigError);
    await expect(fromFlag).rejects.toThrow(/--allow-origin.*cdn example/);

    // An opaque origin serializes as the string 'null', which would allow every
    // opaque URL the fence sees.
    await expect(
      loadConfig({
        ignoreConfigFile: true,
        overrides: { target: 'https://a.example.test' },
        append: { allowedOrigins: ['file:///etc/passwd'] },
      }),
    ).rejects.toThrow(/--allow-origin/);
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

describe('trace capture', () => {
  const load = (overrides: Record<string, unknown>) =>
    loadConfig({ ignoreConfigFile: true, overrides: { target: 'https://x.test', ...overrides } });

  it('is on by default for a run with no credentials', async () => {
    expect((await load({})).report.captureTrace).toBe(true);
  });

  it('is off by default when the run carries credentials', async () => {
    // Playwright traces keep request headers, cookies and filled values verbatim.
    for (const overrides of [
      { headers: { Authorization: 'Bearer t0ken' } },
      { auth: { basicAuth: { username: 'u', password: 'p' } } },
      { auth: { storageState: 'playwright/.auth/user.json' } },
      {
        auth: {
          loginScript: {
            url: '/login',
            usernameSelector: '#u',
            passwordSelector: '#p',
            username: 'u',
            password: 'p',
          },
        },
      },
    ]) {
      expect((await load(overrides)).report.captureTrace).toBe(false);
    }
  });

  it('stays on when asked for explicitly', async () => {
    const cfg = await load({
      headers: { Authorization: 'Bearer t0ken' },
      report: { captureTrace: true },
    });
    expect(cfg.report.captureTrace).toBe(true);
  });
});

describe('config files', () => {
  it("resolve `import ... from 'buttonmash'` without a local install", async () => {
    // The composite action installs buttonmash outside the workspace, so the
    // import in a scaffolded config has no node_modules to resolve from.
    const workspace = mkdtempSync(join(tmpdir(), 'buttonmash-workspace-'));
    try {
      writeFileSync(
        join(workspace, 'buttonmash.config.ts'),
        "import { defineConfig } from 'buttonmash';\n" +
          "export default defineConfig({ target: 'https://x.test', failOn: 'medium' });\n",
      );
      const cfg = await loadConfig({ cwd: workspace });
      expect(cfg.failOn).toBe('medium');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('load an explicit configPath even when discovery is off', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'buttonmash-workspace-'));
    try {
      const path = join(workspace, 'custom.json');
      writeFileSync(path, JSON.stringify({ failOn: 'medium' }));
      const cfg = await loadConfig({
        ignoreConfigFile: true,
        configPath: path,
        overrides: { target: 'https://x.test' },
      });
      expect(cfg.failOn).toBe('medium');
      expect(cfg.configPath).toBe(path);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('buttonmash(config, { configPath }) reads that file', async () => {
    // An invalid value in the file proves it was loaded, without launching a browser.
    const workspace = mkdtempSync(join(tmpdir(), 'buttonmash-workspace-'));
    try {
      const path = join(workspace, 'custom.json');
      writeFileSync(path, JSON.stringify({ failOn: 'apocalyptic' }));
      await expect(buttonmash({ target: 'https://x.test' }, { configPath: path })).rejects.toThrow(
        /Invalid configuration:\n {2}- failOn/,
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
