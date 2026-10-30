---
title: Give Every Locked Job a Stable, Explicit Key
impact: HIGH
impactDescription: A rename or rolling deploy runs the job twice; colliding keys fail startup
tags: locks, schedule, keys, WithoutOverlapping, OnOneInstance, deploy
---

## Give Every Locked Job a Stable, Explicit Key

Without `key`, a job's lock key is `ClassName.methodName`. Renaming the class or method (or minifying the build) changes it, and during a rolling deploy the old and new instances then hold different locks and both run the job. Set `key` on every `@WithoutOverlapping()` and `@OnOneInstance()`, as a domain name (`stock:reconcile`) that never follows refactors, and use the same name for the `@Interval()`/`@Cron()` job name so logs and `SchedulerRegistry` agree.

A job with key `k` holds two keys: `k` (the run lock) and `k:owner` (the `@OnOneInstance()` lease, logged as `OverlapProbe.both runs on this instance (lease "probe:both:owner", fencing token 1)`). `LocksModule` checks every job and `@LeaderElection()` key at startup and refuses overlaps, so `app.init()` fails rather than two features silently excluding each other. Observed messages:

- A key that is another job's lease: `LocksModule: the job ReportsOwnerJob.run (key "reports:owner") and the job ReportsJob.run (key "reports") both use the lock key "reports:owner", so they would exclude each other. Give one of them another key.`
- A default key that another job sets explicitly: ``LocksModule: InvoiceExport.run and LegacyExport.run both use the lock key "InvoiceExport.run". Two jobs share a key only when both set it on purpose (to exclude each other); set `key` on @WithoutOverlapping() to tell them apart.``

Two jobs that must never run at the same time (an import and an export of the same table) share a key on purpose by both setting it. Code outside a job that must not run alongside it takes the same key with `locks.withLock(key, …)` (`lock-acquire-release`).

**Incorrect (default key follows the class and method name):**

```typescript
@Injectable()
export class StockReconcileJob {
  @Interval(60_000)
  @WithoutOverlapping() // key "StockReconcileJob.tick": a rename gives the new release a different lock
  async tick(): Promise<void> {}
}
```

**Correct (one explicit name for timer and lock):**

```typescript
@Injectable()
export class StockReconcileJob {
  @Interval('stock:reconcile', 60_000)
  @WithoutOverlapping({ key: 'stock:reconcile', ttl: '60s' })
  async tick(): Promise<void> {}
}
```

Decorator arguments are checked when the class is defined, so a typo fails at import: ``@WithoutOverlapping(): `key` must be a non-empty string, got ""`` and ``@WithoutOverlapping(): `ttl`: Invalid duration "30 seconds". Use milliseconds or a string such as "15m" or "3d".`` `ttl` takes milliseconds or a string (`'250ms'`, `'30s'`, `'15m'`, `'6h'`, `'3d'`, `'1w'`).

Reference: [NestJS Locks](https://docs.nestjs.com/reliability/locks)
