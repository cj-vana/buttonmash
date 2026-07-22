import { normalizeUrl, routePath } from '../core/hash';
import { anyMatch } from '../core/regex';

export interface RouteFrontierOptions {
  allowedOrigins: ReadonlySet<string>;
  blockedPath?: RegExp | null;
  includePaths: readonly RegExp[];
  excludePaths: readonly RegExp[];
  capacity?: number;
}

/** Bounded, breadth-first queue of safe routes for a crawl. */
export class RouteFrontier {
  private readonly visited = new Set<string>();
  private readonly queued = new Set<string>();
  private readonly crashed = new Set<string>();
  private readonly queue: string[] = [];
  private readonly capacity: number;
  private emptyReturns = 0;
  private pagesAtLastEmpty = -1;

  constructor(private readonly options: RouteFrontierOptions) {
    this.capacity = options.capacity ?? 5000;
  }

  get visitedCount(): number {
    return this.visited.size;
  }

  enqueue(raw: string): void {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    if (!this.options.allowedOrigins.has(url.origin)) return;

    const path = routePath(url);
    if (this.options.blockedPath?.test(path)) return;
    if (this.options.excludePaths.length && anyMatch(path, this.options.excludePaths)) return;
    if (this.options.includePaths.length && !anyMatch(path, this.options.includePaths)) return;

    const normalized = normalizeUrl(raw);
    if (
      this.visited.has(normalized) ||
      this.queued.has(normalized) ||
      this.crashed.has(normalized) ||
      this.queue.length >= this.capacity
    ) {
      return;
    }
    this.queued.add(normalized);
    this.queue.push(raw);
  }

  markVisited(raw: string): void {
    this.visited.add(normalizeUrl(raw));
  }

  markCrashed(raw: string): void {
    this.crashed.add(normalizeUrl(raw));
  }

  /** Visit the next queued route, marking the requested URL before navigation. */
  async visitNext(navigate: (url: string) => Promise<void>): Promise<boolean> {
    while (this.queue.length > 0) {
      const url = this.queue.shift()!;
      const normalized = normalizeUrl(url);
      this.queued.delete(normalized);
      if (this.visited.has(normalized) || this.crashed.has(normalized)) continue;
      this.visited.add(normalized);
      await navigate(url);
      return true;
    }
    return false;
  }

  /**
   * Visit a queued route or return to the target. Repeated empty passes stop
   * after three returns that discover no additional pages.
   */
  async moveOn(target: string, navigate: (url: string) => Promise<void>): Promise<boolean> {
    if (await this.visitNext(navigate)) return true;
    if (this.visited.size === this.pagesAtLastEmpty) this.emptyReturns += 1;
    else this.emptyReturns = 0;
    this.pagesAtLastEmpty = this.visited.size;
    if (this.emptyReturns >= 3) return false;
    await navigate(target);
    return true;
  }
}
