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
// src/products/sync.dispatcher.ts
import { Injectable } from '@nestjs/common';
import { SyncService } from '../sync.service.js';

@Injectable()
export class SyncDispatcher {
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly sync: SyncService) {}

  /** Fire-and-forget: the HTTP response does not wait for the sync. */
  dispatch(id: string): void {
    const job = this.sync.sync(id).finally(() => this.pending.delete(job));
    this.pending.add(job);
  }

  /** Resolves once every dispatched sync has settled (tests, graceful shutdown). */
  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }
}
```

```typescript
// test/sync-dispatch.e2e-spec.ts (app built as in e2e-real-app-module)
it('POST /api/products/:id/sync pushes after the 202', async () => {
  await request(app.getHttpServer()).post('/api/products/p-1/sync').expect(202);

  await app.get(SyncDispatcher).drain();

  expect(downstream.push).toHaveBeenCalledWith('p-1');
});

it('drain() combines with fake timers when the side effect retries', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  downstream.push.mockClear().mockRejectedValueOnce(Object.assign(new Error('unavailable'), { status: 503 }));

  await request(app.getHttpServer()).post('/api/products/p-2/sync').expect(202);
  const drained = app.get(SyncDispatcher).drain();
  await vi.advanceTimersByTimeAsync(60_000);
  await drained;
  vi.useRealTimers();

  expect(downstream.push).toHaveBeenCalledTimes(2);
});
```

The `while` loop also waits for work that is dispatched while `drain()` is already running. `SyncService.sync()` never rejects, because it records a dead letter instead. That keeps the fire-and-forget promise from becoming an unhandled rejection.

Reference: [NestJS – Testing: End-to-end testing](https://docs.nestjs.com/fundamentals/testing#end-to-end-testing)
