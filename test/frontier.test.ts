import { describe, expect, it, vi } from 'vitest';

import { RouteFrontier } from '../src/explorer/frontier';

function makeFrontier(overrides: Partial<ConstructorParameters<typeof RouteFrontier>[0]> = {}) {
  return new RouteFrontier({
    allowedOrigins: new Set(['https://app.test']),
    blockedPath: /delete|logout/i,
    includePaths: [],
    excludePaths: [],
    ...overrides,
  });
}

describe('route frontier', () => {
  it('queues safe routes breadth-first and rejects unsafe or duplicate URLs', async () => {
    const frontier = makeFrontier({ excludePaths: [/\/admin/] });
    frontier.enqueue('https://app.test/projects');
    frontier.enqueue('https://app.test/projects#details');
    frontier.enqueue('https://app.test/#/account/delete');
    frontier.enqueue('https://app.test/admin');
    frontier.enqueue('https://other.test/projects');
    frontier.enqueue('javascript:alert(1)');

    const visited: string[] = [];
    const navigate = vi.fn(async (url: string) => {
      visited.push(url);
    });
    expect(await frontier.visitNext(navigate)).toBe(true);
    expect(await frontier.visitNext(navigate)).toBe(false);
    expect(visited).toEqual(['https://app.test/projects']);
    expect(frontier.visitedCount).toBe(1);
  });

  it('honors include paths, capacity, and crashed-route suppression', async () => {
    const frontier = makeFrontier({ includePaths: [/^\/app/], capacity: 2 });
    frontier.enqueue('https://app.test/public');
    frontier.enqueue('https://app.test/app/one');
    frontier.enqueue('https://app.test/app/two');
    frontier.enqueue('https://app.test/app/three');
    frontier.markCrashed('https://app.test/app/two');

    const visited: string[] = [];
    while (await frontier.visitNext(async (url) => void visited.push(url))) {
      // Drain the bounded queue.
    }
    expect(visited).toEqual(['https://app.test/app/one']);
  });

  it('returns to the target only while empty passes are still finding pages', async () => {
    const frontier = makeFrontier();
    const navigate = vi.fn(async () => {});

    expect(await frontier.moveOn('https://app.test', navigate)).toBe(true);
    expect(await frontier.moveOn('https://app.test', navigate)).toBe(true);
    expect(await frontier.moveOn('https://app.test', navigate)).toBe(true);
    expect(await frontier.moveOn('https://app.test', navigate)).toBe(false);
    expect(navigate).toHaveBeenCalledTimes(3);
  });
});
