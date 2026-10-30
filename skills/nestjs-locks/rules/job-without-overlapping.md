---
title: Use @WithoutOverlapping to Stop Overlapping Runs, @OnOneInstance Only to Pin a Job
impact: HIGH
impactDescription: Overlapping runs of a long job, on one instance or on all of them
tags: locks, schedule, cron, interval, WithoutOverlapping, OnOneInstance
---

## Use @WithoutOverlapping to Stop Overlapping Runs, @OnOneInstance Only to Pin a Job

`@nestjs/schedule` starts a tick whether or not the previous one finished, on every instance. The two decorators from `@nestjs/locks` solve different halves:

- `@WithoutOverlapping({ key, ttl })` takes the lock `key` for the length of each run, renews it every `ttl / 3`, and releases it when the run ends. A tick that finds the key held, on this instance or another, is skipped: it resolves `undefined` and logs at debug `Skipped StockReconcileJob.tick: a run is still in progress`.
- `@OnOneInstance({ key, ttl })` takes a lease on `<key>:owner` at the first tick and keeps renewing it; that instance runs every tick, the others skip until the lease expires `ttl` after the owner dies. It does not stop a run from overlapping the previous one on the owner: in the probe, two concurrent calls of an `@OnOneInstance()` method both ran (2 runs in progress at once).

For "this job must never run twice at the same time" use `@WithoutOverlapping()`, alone or with `@OnOneInstance()` when the job should also stay on one instance (warm caches, one log stream). Both decorators share one key, set on either; order relative to `@Cron()`/`@Interval()` doesn't matter. A store failure fails closed: the tick doesn't run, and rejects with `<job> did not run: the lock store failed (…)`.

**Incorrect (pinned, but a slow run overlaps the next tick):**

```typescript
@Cron(CronExpression.EVERY_MINUTE)
@OnOneInstance({ key: 'stock:reconcile' })
async tick(): Promise<void> {
  await this.reconcile(); // takes 3 minutes: three runs in progress on the owner
}
```

**Correct (`src/stock/stock-reconcile.job.ts`):**

```typescript
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

**Correct (also pinned to one instance):**

```typescript
@Cron(CronExpression.EVERY_5_MINUTES)
@OnOneInstance({ key: 'stock:reconcile' })
@WithoutOverlapping()
async tick(): Promise<void> {}
```

`@nestjs/schedule` calls jobs without arguments, so the run's lock reaches the method through `LocksContext` (backed by `AsyncLocalStorage`, `undefined` outside a run): `fencingToken` is new and higher for each run, and `signal` aborts if the lock is lost or the run ends. Hand both to the method that does the work and fence its writes with the token (`StockReconciler` in `job-direct-calls`, `lock-fencing-tokens`). Choose `ttl` above the longest pause the process may take (GC, a blocked event loop), not above the run length: the lock renews itself every `ttl / 3` while the run lasts. Registering the timers and testing them on fake time is `nestjs-schedule`.

Reference: [NestJS Locks](https://docs.nestjs.com/reliability/locks)
