---
title: Await Fire-and-Forget Work Through drain()
impact: MEDIUM-HIGH
impactDescription: Assertions that run before the side effect, or sleeps that guess its duration
tags: testing, e2e, async, side-effects, dispatcher
---

## Await Fire-and-Forget Work Through drain()

When a handler answers 202 and runs the downstream call after the response, Supertest resolves before that work finishes. An assertion right after the request fails, and a sleep can only guess how long the work takes. Give the component that starts the work an awaitable. The dispatcher keeps each in-flight promise in a set and exposes `drain()`, which resolves when every promise has settled. The test awaits `drain()` after the response, so it waits exactly as long as the work takes. When the work retries, combine `drain()` with fake timers: start `drain()`, advance the clock, then await it (`async-fake-timers`). When to answer before the downstream call, and how a failed call becomes a dead letter, is `nestjs-resilience`.

**Incorrect (sleeping until the side effect has probably happened):**

```typescript
await request(app.getHttpServer()).post('/api/products/p-1/sync').expect(202);
await new Promise((resolve) => setTimeout(resolve, 500));
expect(downstream.push).toHaveBeenCalledWith('p-1');
```

**Correct (the dispatcher tracks its work; the test awaits `drain()`):**

```typescript
// src/sync/sync.dispatcher.ts
import { Injectable, Logger } from '@nestjs/common';
import { SyncService } from './sync.service.js';

@Injectable()
export class SyncDispatcher {
  private readonly logger = new Logger(SyncDispatcher.name);
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly sync: SyncService) {}

  /** Fire-and-forget: the HTTP response does not wait for the sync. */
  dispatch(id: string): void {
    const job = this.sync
      .sync(id)
      .catch((error: unknown) => {
        // sync() dead-letters final failures; this catches the dead-letter write failing too.
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger.error('Product sync lost, dead letter not recorded', { productId: id }, err);
      })
      .finally(() => this.pending.delete(job));
    this.pending.add(job);
  }

  /** Resolves once every dispatched sync has settled (tests, graceful shutdown). */
  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }
}
```

```typescript
// test/sync-dispatch.e2e-spec.ts
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { DownstreamClient } from '../src/sync/downstream.client.js';
import { SyncDispatcher } from '../src/sync/sync.dispatcher.js';
import { createTestApp } from './support/test-app.js';

const downstream = { push: vi.fn((id: string) => Promise.resolve(`ok:${id}`)) };
let app: NestExpressApplication;

beforeEach(async () => {
  downstream.push.mockClear();
  app = await createTestApp((builder) => builder.overrideProvider(DownstreamClient).useValue(downstream));
  return () => app.close();
});

it('POST /api/products/:sku/sync pushes after the 202', async () => {
  await request(app.getHttpServer()).post('/api/products/p-1/sync').expect(202);

  await app.get(SyncDispatcher).drain();

  expect(downstream.push).toHaveBeenCalledWith('p-1');
});

it('drain() combines with fake timers when the side effect retries', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  downstream.push.mockRejectedValueOnce(Object.assign(new Error('unavailable'), { status: 503 }));

  await request(app.getHttpServer()).post('/api/products/p-2/sync').expect(202);
  const drained = app.get(SyncDispatcher).drain();
  await vi.advanceTimersByTimeAsync(60_000);
  await drained;
  vi.useRealTimers();

  expect(downstream.push).toHaveBeenCalledTimes(2);
});
```

The `while` loop also waits for work that is dispatched while `drain()` is already running. `sync()` records final failures as dead letters, but that write can fail too (`nestjs-resilience`, `dlq-record-final-failure`), so every dispatched promise ends in the `.catch`. Tests that call `drain()` do not reveal a missing `.catch`, because `Promise.allSettled` handles the rejection: without it, a spec that dispatched and drained passed cleanly, and one that dispatched without draining, like production, ended with Vitest's `Unhandled Rejection` error; in the app, `main.ts`'s handler would log it as fatal and exit. With the `.catch`, both specs passed. The log follows `nestjs-logging`: a fixed message, fields, the `Error` as the third argument, at `error` because the work is lost.

Reference: [NestJS – Testing: End-to-end testing](https://docs.nestjs.com/fundamentals/testing#end-to-end-testing)
