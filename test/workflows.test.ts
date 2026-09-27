import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

describe('workflow token permissions', () => {
  it.each(['ci.yml', 'browser-smoke.yml'])('%s gives GITHUB_TOKEN read-only contents', (file) => {
    const yml = readFileSync(join(root, '.github', 'workflows', file), 'utf8');
    expect(yml).toMatch(/^permissions:\n {2}contents: read\n(?! )/m);
  });
});
