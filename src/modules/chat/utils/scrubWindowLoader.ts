/**
 * The scrub's window reader: at most one read in flight, latest position wins.
 *
 * A drag asks for a window on nearly every pointer frame. Firing one read per
 * frame would put many in flight at once and let whichever lands last decide
 * what the reader sees — including a read for a position the pointer has already
 * left. This loader serialises the reads and coalesces the requests: while one
 * read is in flight every newer request replaces the waiting one, and when the
 * read lands the newest request is served next. A request whose window was
 * superseded resolves `null`, so its caller knows not to settle on it.
 *
 * A small cache of already-read windows (keyed by the ordinal range they cover)
 * answers a back-and-forth drag without touching the network again; a hit is
 * handed back through `restore` so the caller can re-apply the page it already
 * has.
 *
 * Used by `useChatSessionState` for the drawn scrollbar's drag, and unit-tested
 * directly.
 */

/**
 * The absolute ordinal range a window page covers: `[startIndex, endIndex)` on
 * the same scale the turn outline indexes on.
 */
export type ScrubWindowBounds = {
  startIndex: number;
  endIndex: number;
};

/** The number of windows a scrub keeps for a back-and-forth drag. */
export const SCRUB_WINDOW_CACHE_SIZE = 4;

type Waiter<T extends ScrubWindowBounds> = {
  id: string;
  /** The ordinal the request was made for — the cache containment test. */
  ordinal: number;
  /** Monotonic request stamp; a later stamp makes an earlier read superseded. */
  seq: number;
  resolve: (page: T | null) => void;
};

export type ScrubWindowLoader<T extends ScrubWindowBounds> = {
  /**
   * Ask for a window covering `ordinal`, addressed by `id`. Resolves with the
   * page whose window is the newest settled one, or `null` when a later request
   * superseded this one. At most one read is ever in flight.
   */
  request: (id: string, ordinal: number) => Promise<T | null>;
  /** Forget every cached and in-flight window — a session change or a drag end. */
  reset: () => void;
  /** The window the loader last settled on, or null. */
  last: () => T | null;
};

/** Whether a window's ordinal range covers an ordinal. */
function covers(bounds: ScrubWindowBounds, ordinal: number): boolean {
  return ordinal >= bounds.startIndex && ordinal < bounds.endIndex;
}

export function createScrubWindowLoader<T extends ScrubWindowBounds>(
  load: (id: string) => Promise<T | null>,
  options: { cacheSize?: number; restore?: (page: T) => void } = {},
): ScrubWindowLoader<T> {
  const cacheSize = options.cacheSize ?? SCRUB_WINDOW_CACHE_SIZE;
  const restore = options.restore;
  /** Most recently used first, so eviction drops the oldest read. */
  let cache: T[] = [];
  /** The read in flight, if any. */
  let inFlight: Waiter<T> | null = null;
  /** The newest request not yet started — older waiting requests are dropped. */
  let pending: Waiter<T> | null = null;
  let generation = 0;
  let lastApplied: T | null = null;

  function remember(page: T): void {
    cache = [page, ...cache.filter((entry) => entry.startIndex !== page.startIndex)]
      .slice(0, Math.max(1, cacheSize));
  }

  function pump(): void {
    if (inFlight || !pending) return;
    const waiter = pending;
    pending = null;
    inFlight = waiter;
    load(waiter.id).then(
      (page) => {
        inFlight = null;
        // A repeat request for the window that just landed — a drag held at one
        // position while its read was in flight asks for the same page again —
        // is answered with what arrived rather than read a second time.
        const next = pending;
        if (next && next.id === waiter.id && page) {
          pending = null;
          remember(page);
          lastApplied = page;
          waiter.resolve(null);
          next.resolve(page);
          pump();
          return;
        }
        // A request that arrived while this read was in flight makes it stale:
        // answer it with null rather than letting it settle the reader on a
        // window the pointer has already left. A stale read is not cached either
        // — `reset` must not be undone by a read that was already on the wire.
        if (waiter.seq !== generation) {
          waiter.resolve(null);
        } else {
          if (page) remember(page);
          lastApplied = page;
          waiter.resolve(page);
        }
        pump();
      },
      () => {
        inFlight = null;
        waiter.resolve(null);
        pump();
      },
    );
  }

  return {
    request(id: string, ordinal: number): Promise<T | null> {
      const hit = cache.find((entry) => covers(entry, ordinal));
      if (hit) {
        remember(hit);
        restore?.(hit);
        lastApplied = hit;
        return Promise.resolve(hit);
      }

      const waiter: Waiter<T> = { id, ordinal, seq: ++generation, resolve: () => {} };
      const promise = new Promise<T | null>((resolve) => {
        waiter.resolve = resolve;
      });
      // The newest request replaces whatever was waiting; the replaced one is
      // told it lost so its caller does not settle on a stale position.
      pending?.resolve(null);
      pending = waiter;
      pump();
      return promise;
    },

    reset(): void {
      generation += 1;
      pending?.resolve(null);
      pending = null;
      cache = [];
      lastApplied = null;
    },

    last(): T | null {
      return lastApplied;
    },
  };
}
