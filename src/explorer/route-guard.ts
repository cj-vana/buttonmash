/**
 * The path guards (`blockedPathPatterns` plus the dangerous-path list,
 * `includePaths`, `excludePaths`) decide where the crawl may go. The frontier,
 * the runner (for client-side navigations that never pass through it) and the
 * action gate (for links) all ask the same question through here.
 */
import { routePath } from '../core/hash';
import { anyMatch } from '../core/regex';

export interface PathGuards {
  blocked: RegExp | null;
  include: readonly RegExp[];
  exclude: readonly RegExp[];
}

/**
 * The strings a guard is matched against for one URL: the path with its query,
 * since some apps route by query (`/index.php?route=account/logout`); and for a
 * hash router, the hash route alone (`#/billing` is `/billing`) as well as
 * after the path.
 */
export function guardedPaths(u: URL): string[] {
  const route = routePath(u);
  const hashRoute = route.slice(u.pathname.length);
  const paths = [u.pathname + u.search, route];
  if (hashRoute) paths.push(hashRoute);
  return paths;
}

/** Why `url` is off-limits to the crawl, or null when it may be explored. */
export function pathGuardReason(
  url: URL,
  guards: PathGuards,
): 'blocked' | 'excluded' | 'not included' | null {
  const paths = guardedPaths(url);
  const { blocked } = guards;
  if (blocked && paths.some((p) => ((blocked.lastIndex = 0), blocked.test(p)))) return 'blocked';
  if (guards.exclude.length && paths.some((p) => anyMatch(p, guards.exclude))) return 'excluded';
  if (guards.include.length && !paths.some((p) => anyMatch(p, guards.include))) {
    return 'not included';
  }
  return null;
}
