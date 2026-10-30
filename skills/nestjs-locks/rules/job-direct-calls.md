---
title: Treat a Locked Job Method as a Lock Wrapper, Also When Calling It Directly
impact: HIGH
impactDescription: Tests that silently assert nothing; work skipped when an admin endpoint calls the job
tags: locks, schedule, testing, WithoutOverlapping, OnOneInstance, wrapper
---

## Treat a Locked Job Method as a Lock Wrapper, Also When Calling It Directly

`@WithoutOverlapping()` and `@OnOneInstance()` replace the method on the prototype with a wrapper (`dist/utils/job-decorator.util.js`), not a hook that only the scheduler sees. Every call goes through the lock: a test, a controller or another service calling `tick()` gets `undefined` back, without running anything, while another holder has the key. In the probe, `tick()` called while a test held `stock:reconcile` through `Locks.acquire()` resolved `undefined` and wrote no row; after `lock.release()` the same call ran with the next fencing token. A decorated method on an object created with `new` (not resolved from the app) rejects with ``OverlapProbe.both is decorated with @OnOneInstance() and @WithoutOverlapping(), but LocksModule doesn't know this instance, so it can't tell whether this call may run. Import LocksModule in the application, and provide OverlapProbe as a singleton provider (not request-scoped or transient, not created with `new`).`` A transient provider resolved with `app.resolve()` got the same rejection: decorate singleton providers only.

Keep the decorated method a thin entry point that hands the run's fencing token and signal to an undecorated provider method that does the work. Tests of the work call that method; one test proves the lock by holding the key and calling the entry point. Code that must run the work now (an admin endpoint) calls the work method inside `locks.withLock(key, (lock) => …)` with the lock's token, so a refusal is a `LockNotAcquiredError`, not a silent `undefined`.

**Incorrect (asserts on a call the lock may have skipped):**

```typescript
it('reconciles stock', async () => {
  await app.get(StockReconcileJob).tick(); // resolves undefined if anything holds 'stock:reconcile'
  expect(await stockLevels.find('A-1')).toMatchObject({ quantity: 3 });
});

it('reconciles stock (unit)', async () => {
  await new StockReconcileJob(context, reconciler).tick(); // rejects: LocksModule doesn't know this instance
});
```

**Correct (thin entry point; work tested directly, lock tested once):**

```typescript
// src/stock/stock-reconcile.job.ts
import { Injectable } from '@nestjs/common';
import { LocksContext, WithoutOverlapping } from '@nestjs/locks';
import { Interval } from '@nestjs/schedule';
import { StockReconciler } from './stock-reconciler.js';

@Injectable()
export class StockReconcileJob {
  constructor(
    private readonly locksContext: LocksContext,
    private readonly reconciler: StockReconciler,
  ) {}

  /** Scheduled entry point: skipped (resolves `undefined`) while a run holds `stock:reconcile` on any instance. */
  @Interval('stock:reconcile', 60_000)
  @WithoutOverlapping({ key: 'stock:reconcile', ttl: '60s' })
  async tick(): Promise<void> {
    await this.reconciler.reconcile(this.locksContext.fencingToken!, this.locksContext.signal!);
  }
}
```

```typescript
// src/stock/stock-reconciler.ts
import { Injectable, Logger } from '@nestjs/common';
import { StockLevelRepository } from './stock-level.repository.js';
import { WarehouseClient } from './warehouse.client.js';

@Injectable()
export class StockReconciler {
  private readonly logger = new Logger(StockReconciler.name);

  constructor(
    private readonly warehouse: WarehouseClient,
    private readonly stockLevels: StockLevelRepository,
  ) {}

  /** Writes the warehouse's counts as one snapshot, fenced with the caller's lock token; success is logged only once it landed. */
  async reconcile(fencingToken: number, signal: AbortSignal): Promise<'reconciled' | 'fenced'> {
    const counts = await this.warehouse.stockCounts(signal);
    if (!(await this.stockLevels.writeSnapshot(counts, fencingToken))) {
      this.logger.warn('Stale stock snapshot fenced off', { skus: counts.length, fencingToken });
      return 'fenced';
    }
    this.logger.log('Stock reconciled', { skus: counts.length, fencingToken });
    return 'reconciled';
  }
}
```

`writeSnapshot()` (`lock-fencing-tokens`) applies every row in one transaction and returns `false`, with nothing written, when a later holder has written any of them. A loop that ignores `write()`'s result is partial instead: with `B-2` already at token 1000, writing `A-1` and `B-2` at token 7 returned `[true, false]` and left `A-1` at token 7, half a snapshot that the old `reconcile()` then logged as `Stock reconciled`.

```typescript
// test/stock-reconcile.e2e-spec.ts (app from createTestApp(), nestjs-testing)
it('writes the counts with the given token', async () => {
  await expect(app.get(StockReconciler).reconcile(7, new AbortController().signal)).resolves.toBe('reconciled');
  expect(await app.get(StockLevelRepository).find('A-1')).toEqual({ quantity: 3, fencingToken: 7 });
});

it('writes nothing and reports fenced once a later holder has written any row', async () => {
  app.get(WarehouseClient).counts = [{ sku: 'A-1', quantity: 3 }, { sku: 'B-2', quantity: 5 }];
  await app.get(StockLevelRepository).write('B-2', 9, 1_000);

  await expect(app.get(StockReconciler).reconcile(7, new AbortController().signal)).resolves.toBe('fenced');

  expect(await app.get(StockLevelRepository).find('A-1')).toBeUndefined();
  expect(await app.get(StockLevelRepository).find('B-2')).toEqual({ quantity: 9, fencingToken: 1_000 });
});

it('skips the run while another holder has stock:reconcile, then runs with a greater token', async () => {
  const lock = await app.get(Locks).acquire('stock:reconcile');
  expect(lock).not.toBeNull();

  expect(await app.get(StockReconcileJob).tick()).toBeUndefined();
  expect(await app.get(StockLevelRepository).find('A-1')).toBeUndefined();

  await lock!.release();
  await app.get(StockReconcileJob).tick();
  expect(await app.get(StockLevelRepository).find('A-1')).toEqual({ quantity: 3, fencingToken: lock!.fencingToken + 1 });
});
```

`WarehouseClient` is the probe's stand-in with settable `counts`; in a real suite, override it as `nestjs-testing` describes. The fenced case logged only `Stale stock snapshot fenced off` at warn with `{ skus: 2, fencingToken: 7 }`, no `Stock reconciled`. Calls skipped by the lock are logged only at debug (`Skipped StockReconcileJob.tick: a run is still in progress`, also when the holder is not a run). Keep the interval from firing during tests (a long period, or fake timers as `nestjs-schedule` describes) so a scheduled tick can't take the key in the middle of an assertion.

Reference: [NestJS Locks](https://docs.nestjs.com/reliability/locks)
