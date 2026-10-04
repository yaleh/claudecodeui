import { describe, expect, it, vi } from 'vitest';

import { createScrubWindowLoader } from '@/modules/chat/utils/scrubWindowLoader';
import type { ScrubWindowBounds } from '@/modules/chat/utils/scrubWindowLoader';

/** A page the loader's cache and containment tests can reason about. */
type Page = ScrubWindowBounds & { id: string };

/** A `load` whose resolution is decided by the test, one call at a time. */
function deferredLoad() {
  const calls: { id: string; resolve: (page: Page | null) => void }[] = [];
  const load = vi.fn(
    (id: string) =>
      new Promise<Page | null>((resolve) => {
        calls.push({ id, resolve });
      }),
  );
  return { load, calls, get inFlight() { return calls.length; } };
}

const page = (id: string, startIndex: number, endIndex: number): Page => ({ id, startIndex, endIndex });

/** Lets the promise chain the loader builds settle. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('createScrubWindowLoader', () => {
  it('keeps at most one read in flight', async () => {
    const { load, calls } = deferredLoad();
    const loader = createScrubWindowLoader<Page>(load);

    const first = loader.request('a', 10);
    const second = loader.request('b', 20);
    expect(load).toHaveBeenCalledTimes(1);

    calls[0].resolve(page('a', 0, 50));
    await flush();
    // The first read landed while a newer request was waiting: it is discarded,
    // and exactly one more read — for the newest request — is now in flight.
    expect(load).toHaveBeenCalledTimes(2);
    expect(calls[1].id).toBe('b');

    calls[1].resolve(page('b', 10, 60));
    await flush();
    expect(await first).toBeNull();
    expect(await second).toEqual(page('b', 10, 60));
  });

  it('coalesces many requests into the newest waiting one', async () => {
    const { load, calls } = deferredLoad();
    const loader = createScrubWindowLoader<Page>(load);

    const first = loader.request('a', 10);
    const superseded = loader.request('b', 20);
    const newest = loader.request('c', 30);
    expect(load).toHaveBeenCalledTimes(1);

    calls[0].resolve(page('a', 0, 50));
    await flush();
    // Only the newest request survives coalescing; the middle one lost.
    expect(load).toHaveBeenCalledTimes(2);
    expect(calls[1].id).toBe('c');

    calls[1].resolve(page('c', 20, 70));
    await flush();
    expect(await first).toBeNull();
    expect(await superseded).toBeNull();
    expect(await newest).toEqual(page('c', 20, 70));
  });

  it('answers a request from a cached window without reading again', async () => {
    const { load, calls } = deferredLoad();
    const restore = vi.fn();
    const loader = createScrubWindowLoader<Page>(load, { restore });

    const first = loader.request('a', 10);
    calls[0].resolve(page('a', 0, 100));
    await flush();
    expect(await first).toEqual(page('a', 0, 100));

    // A drag back into the window the loader already holds: no new read, and the
    // cached page is handed back for the caller to re-apply.
    const again = await loader.request('x', 55);
    expect(load).toHaveBeenCalledTimes(1);
    expect(again).toEqual(page('a', 0, 100));
    expect(restore).toHaveBeenCalledWith(page('a', 0, 100));
  });

  it('forgets everything on reset, including an in-flight read', async () => {
    const { load, calls } = deferredLoad();
    const loader = createScrubWindowLoader<Page>(load);

    const inFlight = loader.request('a', 10);
    loader.reset();
    calls[0].resolve(page('a', 0, 100));
    await flush();
    expect(await inFlight).toBeNull();
    expect(loader.last()).toBeNull();

    // The window read before the reset is not cached either.
    const after = loader.request('b', 20);
    expect(load).toHaveBeenCalledTimes(2);
    calls[1].resolve(page('b', 50, 90));
    await flush();
    expect(await after).toEqual(page('b', 50, 90));
  });

  it('bounds the cache and drops the least recently used window', async () => {
    const { load, calls } = deferredLoad();
    const loader = createScrubWindowLoader<Page>(load, { cacheSize: 1 });

    const first = loader.request('a', 10);
    calls[0].resolve(page('a', 0, 50));
    await flush();
    await first;

    const second = loader.request('b', 60);
    calls[1].resolve(page('b', 50, 100));
    await flush();
    await second;

    // The first window was evicted, so asking for it again reads afresh.
    const back = loader.request('a2', 10);
    expect(load).toHaveBeenCalledTimes(3);
    calls[2].resolve(page('a2', 0, 50));
    await flush();
    expect(await back).toEqual(page('a2', 0, 50));
  });
});
