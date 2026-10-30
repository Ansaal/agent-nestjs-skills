# NestJS Locks

**Version 2.0.0-ansaal**
Ansaal/agent-nestjs-skills
October 2026

> **Note:**
> This document is mainly for agents and LLMs to follow when maintaining,
> generating, or refactoring NestJS codebases. Humans may also find it
> useful, but guidance here is optimized for automation and consistency
> by AI-assisted workflows.

---

## Abstract

Distributed locks for NestJS with `@nestjs/locks`. Use when a scheduled job must not overlap itself or must run on one instance, when code needs a lock with a fencing token, when registering or testing a durable `LockStore`, or when one instance at a time must lead continuous work.

---

## Table of Contents

1. [Lock Store](#1-lock-store) — **CRITICAL**
   - 1.1 [Write Each Lock Store Method as One Compare-and-Set Statement](#11-write-each-lock-store-method-as-one-compare-and-set-statement)
   - 1.2 [Prove a Lock Store With the Package's Contract Suite](#12-prove-a-lock-store-with-the-package-s-contract-suite)
   - 1.3 [Register One Durable Lock Store That Every Instance Shares](#13-register-one-durable-lock-store-that-every-instance-shares)
2. [Scheduled Jobs](#2-scheduled-jobs) — **HIGH**
   - 2.1 [Treat a Locked Job Method as a Lock Wrapper, Also When Calling It Directly](#21-treat-a-locked-job-method-as-a-lock-wrapper-also-when-calling-it-directly)
   - 2.2 [Give Every Locked Job a Stable, Explicit Key](#22-give-every-locked-job-a-stable-explicit-key)
   - 2.3 [Use @WithoutOverlapping to Stop Overlapping Runs, @OnOneInstance Only to Pin a Job](#23-use-withoutoverlapping-to-stop-overlapping-runs-ononeinstance-only-to-pin-a-job)
3. [Ad-hoc Locks](#3-ad-hoc-locks) — **HIGH**
   - 3.1 [Handle a Refused Lock and Release Every Lock You Take](#31-handle-a-refused-lock-and-release-every-lock-you-take)
   - 3.2 [Fence Every Write a Lock Guards With Its Token](#32-fence-every-write-a-lock-guards-with-its-token)
4. [Leader Election](#4-leader-election) — **MEDIUM**
   - 4.1 [Run Continuous Single-Instance Work From @LeaderElection Hooks, Stopped by the Lease Signal](#41-run-continuous-single-instance-work-from-leaderelection-hooks-stopped-by-the-lease-signal)
5. [Testing Locks](#5-testing-locks) — **MEDIUM**
   - 5.1 [Test Expiry and Takeover With a ManualLockClock per Instance and a Shared In-Memory Store](#51-test-expiry-and-takeover-with-a-manuallockclock-per-instance-and-a-shared-in-memory-store)

---

## 1. Lock Store

**Section Impact: CRITICAL**

### 1.1 Write Each Lock Store Method as One Compare-and-Set Statement

**Impact: CRITICAL** — Concurrent callers all acquire the same key; renewals that silently roll back or starve behind long transactions

The `LockStore` contract (`dist/interfaces/lock-store.interface.d.ts` in 0.0.5): `acquire(key, owner, ttl)` lets exactly one of any number of concurrent callers take a free or expired key and returns a fencing token greater than every token ever returned for that key, across releases and expiries; it refuses a live lock, even to its own owner. `renew` and `release` are compare-and-set on `owner` and resolve `false` when the owner no longer holds a live lock. Expiry is measured on the store's clock, so instances with skewed clocks agree on it. A store that reads, decides in JavaScript, then writes breaks the first rule: against the contract suite (`store-contract-suite`) it failed with `acquire() of a free key: 16 of 16 concurrent callers acquired the key`.

On SQLite with TypeORM 1.x, three more traps, each observed in the probe:

- `manager.query()` returns better-sqlite3's `lastInsertRowid` for an `UPDATE` without `RETURNING`, not the number of changed rows: an update that matched one row and one that matched none both returned `2`, the rowid of the previous `INSERT`. Add `RETURNING` and count the rows.
- better-sqlite3 gives the `DataSource` one connection. A renewal sent with `dataSource.query()` while another request's transaction was open ran inside it, answered `[{ key: 'g:renew' }]`, and was rolled back with it (`expiresAt` unchanged): the lock then expires while its holder believes it renewed. Send every statement through the `TransactionRunner` from `nestjs-typeorm` (`orm-atomic-writes`).
- Deleting the row on release restarts the key's token at 1 on the next `INSERT`; the contract suite failed that with `fencing tokens must grow: 1 after 1`. Keep the row and mark it free (`owner` NULL, `expiresAt` 0).

**Incorrect (read, then write; result of an UPDATE without RETURNING):**

```typescript
async acquire(key: string, owner: string, ttl: number): Promise<LockAcquireResult> {
  const [row] = await this.dataSource.query(`SELECT * FROM "lock_lease" WHERE "key" = ?`, [key]);
  if (row && row.expiresAt > Date.now()) return { acquired: false }; // every concurrent caller passes this check
  const fencingToken = (row?.fencingToken ?? 0) + 1;
  await this.dataSource.query(`INSERT OR REPLACE INTO "lock_lease" VALUES (?, ?, ?, ?)`, [key, owner, fencingToken, Date.now() + ttl]);
  return { acquired: true, fencingToken };
}

async renew(key: string, owner: string, ttl: number): Promise<boolean> {
  const result = await this.dataSource.query(`UPDATE "lock_lease" SET "expiresAt" = ? WHERE "key" = ? AND "owner" = ?`, [
    Date.now() + ttl, key, owner,
  ]);
  return Boolean(result); // lastInsertRowid: truthy whether or not a row matched
}
```

**Correct (`src/distributed-locks/typeorm-lock-store.ts`):**

```typescript
import { Injectable } from '@nestjs/common';
import { type LockAcquireResult, type LockStore, LocksStorage } from '@nestjs/locks';
import { TransactionRunner } from '../database/transaction-runner.js';

/** The store's clock: SQLite's, in epoch milliseconds, so every instance on the shared database agrees on expiry. */
const NOW = `CAST(unixepoch('subsec') * 1000 AS INTEGER)`;

/**
 * `LockStore` on the `lock_lease` table. Every method is one statement, so check and write are atomic.
 * A freed lease keeps its row (`owner` NULL, expired), so the key's fencing token only grows.
 */
@Injectable()
export class TypeOrmLockStore implements LockStore {
  constructor(
    private readonly transactions: TransactionRunner,
    storage: LocksStorage,
  ) {
    storage.registerSource(this);
  }

  async acquire(key: string, owner: string, ttl: number): Promise<LockAcquireResult> {
    const rows: { fencingToken: number }[] = await this.transactions.run((manager) =>
      manager.query(
        `INSERT INTO "lock_lease" ("key", "owner", "fencingToken", "expiresAt") VALUES (?, ?, 1, ${NOW} + ?)
         ON CONFLICT ("key") DO UPDATE SET
           "owner" = excluded."owner",
           "fencingToken" = "lock_lease"."fencingToken" + 1,
           "expiresAt" = excluded."expiresAt"
         WHERE "lock_lease"."expiresAt" <= ${NOW}
         RETURNING "fencingToken"`,
        [key, owner, ttl],
      ),
    );
    return rows.length === 1 ? { acquired: true, fencingToken: rows[0].fencingToken } : { acquired: false };
  }

  async renew(key: string, owner: string, ttl: number): Promise<boolean> {
    const rows: unknown[] = await this.transactions.run((manager) =>
      manager.query(
        `UPDATE "lock_lease" SET "expiresAt" = ${NOW} + ?
         WHERE "key" = ? AND "owner" = ? AND "expiresAt" > ${NOW}
         RETURNING "key"`,
        [ttl, key, owner],
      ),
    );
    return rows.length === 1;
  }

  async release(key: string, owner: string): Promise<boolean> {
    const rows: unknown[] = await this.transactions.run((manager) =>
      manager.query(
        `UPDATE "lock_lease" SET "owner" = NULL, "expiresAt" = 0
         WHERE "key" = ? AND "owner" = ? AND "expiresAt" > ${NOW}
         RETURNING "key"`,
        [key, owner],
      ),
    );
    return rows.length === 1;
  }
}
```

**Correct (migration, listed in the `DataSource` per `nestjs-typeorm`):**

```typescript
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateLockLeases1793300000004 implements MigrationInterface {
  name = 'CreateLockLeases1793300000004';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "lock_lease" (
        "key" varchar PRIMARY KEY NOT NULL,
        "owner" varchar,
        "fencingToken" integer NOT NULL,
        "expiresAt" integer NOT NULL
      )`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "lock_lease"`);
  }
}
```

`unixepoch('subsec')` needs SQLite 3.42+; better-sqlite3 12.11.1 bundles 3.53.2. Tokens here count per key, which the contract allows (a store-wide counter also works). The `ON CONFLICT … DO UPDATE … WHERE` takes over only an expired row and draws the token in the same statement; a refused upsert returns no row. For other databases the interface docs name the equivalents: `INSERT … ON CONFLICT DO UPDATE … WHERE expired` with `clock_timestamp()` on PostgreSQL, and a Lua script around `SET NX PX` plus a persisted `INCR` counter on Redis.

**The runner bounds the lease.** With every statement on the one `TransactionRunner`, a renewal waits behind every transaction queued ahead of it. A lock renews every `ttl / 3` and is lost when no renewal reaches the store before its deadline, so a renewal tolerates at most `2·ttl/3` of queue latency. In the probe (`ttl` 3 s, renewal due 1 s after `acquire()`, one transaction started at 0.9 s), a transaction of 1.5 s or 1.9 s kept the lock; one of 2.1 s, 2.5 s or 4 s lost it: `lock.signal` aborted with `LockLostError` (`detectedBy: 'deadline'`), the package warned `Lost the lock "report:build" (fencing token 1): no renewal reached the store before it expired. …`, and another owner's `acquire()` got fencing token 2 while the first holder's work could still be running. A queued renewal also fails once it outlasts `storeTimeout` (default 10 s): with `storeTimeout` 1 s, a 1.5 s transaction logged `Could not renew the lock "k"` at error, though the lock was still held afterwards. Keep the longest transaction plus the queue ahead of it well below both `storeTimeout` and `2·ttl/3` (20 s at the default 30 s `ttl`), and size `ttl` from that, not only from the locked work. An app whose transactions can run for seconds (bulk imports, backfills) keeps its locks on a separate backend (`store-register-durable`).

**Take locks outside `run()`.** The runner is re-entrant (`orm-atomic-writes`): a `run()` inside an open transaction joins it. A lock acquired inside `run()` writes its lease in that transaction: when the transaction rolled back, `lock.held` stayed `true` while another owner's `acquire()` took the key with fencing token 1, the same token, so fencing could no longer tell the holders apart. The lock's renewal timers inherit the same async context: they join the transaction while it is open and queue normally once it has settled, because the runner marks the context finished. A runner without that mark sent a renewal straight to the shared connection, inside another request's transaction that then rolled back: 747 ms were left on the lease afterwards, against 1449 ms with the mark. Acquire first (`withLock()`, `@WithoutOverlapping()`), then open transactions inside the lock.

Reference: [@nestjs/locks source: LockStore](https://github.com/nestjs/locks)

---

### 1.2 Prove a Lock Store With the Package's Contract Suite

**Impact: HIGH** — Races, token resets and clock bugs ship unnoticed in a hand-written store

`@nestjs/locks/testing` exports `lockStoreContract(createStore, options)`, which returns runner-agnostic cases (`{ name, run }`); register each as a test. With `concurrent: true` there are 16: 10 behaviour cases (exclusive acquire, owner-only release and renew, expiry measured from the call in milliseconds, takeover with a greater token, tokens growing across release and expiry, exact key separation, 30-day durations) and 6 races with 16 callers each. Hand-written tests rarely cover the races: a read-then-write store passes a sequential acquire/release test and fails `concurrency: of 16 callers acquiring a free key at once, exactly one wins` with `16 of 16 concurrent callers acquired the key`; a store that deletes on release fails `fencing tokens must grow: 1 after 1` (`store-atomic-statements`).

The expiry cases need the store's clock to move. A store on a database or Redis clock can't be faked with `vi.useFakeTimers()`, so the cases wait in real time with a 2.5 s `ttl`: against SQLite the 8 timed cases took 2.9 to 4.2 s each and the file 25 s, above Vitest's 5 s default per test. Give each case a 30 s timeout. The in-memory store takes `advanceTime` and finishes the 16 cases in milliseconds.

**Incorrect (two hand-written cases, no races, no expiry):**

```typescript
it('acquires and releases', async () => {
  const store = app.get(TypeOrmLockStore);
  expect(await store.acquire('k', 'a', 1_000)).toMatchObject({ acquired: true });
  expect(await store.acquire('k', 'b', 1_000)).toEqual({ acquired: false });
  expect(await store.release('k', 'a')).toBe(true);
});
```

**Correct (`test/typeorm-lock-store.e2e-spec.ts`, the store from the real app):**

```typescript
import { lockStoreContract } from '@nestjs/locks/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { TypeOrmLockStore } from '../src/distributed-locks/typeorm-lock-store.js';
import { createTestApp } from './support/test-app.js';

describe('TypeOrmLockStore', () => {
  let app: NestExpressApplication;

  beforeEach(async () => {
    app = await createTestApp();
    return () => app.close();
  });

  // The store measures expiry on SQLite's clock, which fake timers can't move: the expiry cases wait in real time.
  for (const contractCase of lockStoreContract(() => app.get(TypeOrmLockStore), { concurrent: true })) {
    it(contractCase.name, () => contractCase.run(), 30_000);
  }
});
```

**Correct (in-memory store on a manual clock, for comparison or a store double):**

```typescript
import { InMemoryLockStore, ManualLockClock } from '@nestjs/locks';
import { lockStoreContract } from '@nestjs/locks/testing';

describe('InMemoryLockStore on a ManualLockClock', () => {
  const clock = new ManualLockClock();
  const store = new InMemoryLockStore({ clock });
  for (const contractCase of lockStoreContract(() => store, { advanceTime: (ms) => clock.advance(ms), concurrent: true })) {
    it(contractCase.name, () => contractCase.run());
  }
});
```

`createStore` runs once per case, after `beforeEach` booted that case's app, so each case gets the store of a fresh app and database. `createTestApp()` boots the real `AppModule` (`nestjs-testing`), so the migration and the `TransactionRunner` are the production ones. On one better-sqlite3 connection the races are serialized by the runner, which the suite accepts as a valid run; run them against a pooled server database too when the store targets one. Raise `ttl` (default 2500 ms) for a remote store whose round trips are slow, or the expiry cases turn flaky. The `.e2e-spec.ts` file is picked up by the single Vitest config from `nestjs-setup`.

Reference: [NestJS Locks](https://docs.nestjs.com/reliability/locks)

---

### 1.3 Register One Durable Lock Store That Every Instance Shares

**Impact: CRITICAL** — Every instance takes the same lock and runs the same job

`@nestjs/locks` 0.0.5 ships one store, `InMemoryLockStore`, used when nothing is registered. It excludes callers in one process only: two instances each hold "the" lock. With `NODE_ENV=production` and no registered store, `app.init()` fails with `LocksStorage: no LockStore is registered, and NODE_ENV is "production": in memory, a lock only excludes callers in this process, so every instance of the app would take the same lock and run the same job.` `allowInMemoryStorage: true` silences that, and is only correct for an app that runs as exactly one instance.

There is no `store` option (``LocksModule: `store` is not an option.``). A store is an `@Injectable()` singleton that implements `LockStore` (`acquire`, `renew`, `release`) and calls `storage.registerSource(this)` in its constructor. The registry locks in `LocksModule.onModuleInit()`; a later call throws `LocksStorage.registerSource(): … registered after LocksModule initialized … Register from the constructor of a singleton provider: providers of lazy-loaded modules, request-scoped and transient providers, and lifecycle hooks run too late.` A second store throws `… can't register, InMemoryLockStore already did. Register one store, or pass { replace: true } to replace it on purpose (tests, wrappers).` Startup logs which store won: `LocksStorage: TypeOrmLockStore`.

A durable store only excludes instances that share it. In the probe, with two app instances on their own `:memory:` SQLite databases, instance two's `@WithoutOverlapping({ key: 'stock:reconcile' })` job ran while instance one held `stock:reconcile`.

The SQLite store below is shared only by processes on one host that open the same local database file. Two `node` processes on one file took each of 30 contested keys exactly once, and process B's job skipped its run while A held `stock:reconcile`. They also share SQLite's single writer: while A held a write transaction for 7 s, B's `acquire()` rejected after 5368 ms with `QueryFailedError: SqliteError: database is locked` (better-sqlite3's 5 s busy timeout), a store failure that skips locked jobs and misses renewals (`store-atomic-statements`). A per-container file coordinates nothing, and SQLite on a network filesystem depends on that filesystem's locking ([SQLite over a network](https://www.sqlite.org/useovernet.html)). For replicas on several hosts or containers, implement the store on PostgreSQL or Redis, prove it with the contract suite (`store-contract-suite`), and add one integration test that runs two real instances against that backend.

**Incorrect (in-memory locks in a multi-instance deployment):**

```typescript
@Module({
  imports: [LocksModule.forRoot({ allowInMemoryStorage: true })], // every replica runs every "locked" job
})
export class DistributedLocksModule {}
```

**Correct (`src/distributed-locks/distributed-locks.module.ts`):**

```typescript
import { Module } from '@nestjs/common';
import { LocksModule } from '@nestjs/locks';
import { TypeOrmLockStore } from './typeorm-lock-store.js';

/** Configures the global LocksModule and registers the database-backed store every instance shares. */
@Module({
  imports: [LocksModule.forRoot({ ttl: '30s' })],
  providers: [TypeOrmLockStore],
})
export class DistributedLocksModule {}
```

```typescript
// src/distributed-locks/typeorm-lock-store.ts, excerpt: the full class is in store-atomic-statements
@Injectable()
export class TypeOrmLockStore implements LockStore {
  constructor(
    private readonly transactions: TransactionRunner,
    storage: LocksStorage,
  ) {
    storage.registerSource(this);
  }
  // acquire(), renew(), release()
}
```

Import `DistributedLocksModule` once in `AppModule`; `LocksModule` is global by default, so `Locks`, `LocksContext` and `LocksEvents` inject anywhere. Module options: `ttl` (default `'30s'`, the lease each lock renews every `ttl / 3`), `storeTimeout` (default `'10s'`, after which a store call fails with `LockStoreTimeoutError`), `clock` (tests: `test-manual-lock-clock`). Every instance points at the same store; a `:memory:` or per-container SQLite file is a per-instance store.

Reference: [NestJS Locks](https://docs.nestjs.com/reliability/locks)

---

## 2. Scheduled Jobs

**Section Impact: HIGH**

### 2.1 Treat a Locked Job Method as a Lock Wrapper, Also When Calling It Directly

**Impact: HIGH** — Tests that silently assert nothing; work skipped when an admin endpoint calls the job

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

---

### 2.2 Give Every Locked Job a Stable, Explicit Key

**Impact: HIGH** — A rename or rolling deploy runs the job twice; colliding keys fail startup

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

---

### 2.3 Use @WithoutOverlapping to Stop Overlapping Runs, @OnOneInstance Only to Pin a Job

**Impact: HIGH** — Overlapping runs of a long job, on one instance or on all of them

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

---

## 3. Ad-hoc Locks

**Section Impact: HIGH**

### 3.1 Handle a Refused Lock and Release Every Lock You Take

**Impact: HIGH** — Work runs unlocked on null, or a held lock blocks the key for a full ttl

`Locks` (global, injectable) has two entry points. `acquire(key, { ttl, wait, signal })` resolves a `Lock` or `null`: `null` when another holder kept the key for `wait` (default `0`, try once), when the store granted it only after `ttl` had passed, or when the app is shutting down. It rejects when the store fails or exceeds `storeTimeout` (`LockStoreTimeoutError`). `withLock(key, fn, options)` runs `fn(lock)`, releases afterwards whether `fn` resolves or throws, and rejects with `LockNotAcquiredError` when it can't take the key: observed `Could not acquire the lock "stock:A-1": another holder has it`, `reason: 'taken'` (`'shutdown'` during shutdown). Neither is an HTTP error (no 4xx `status`); map it yourself.

A `Lock` renews itself every `ttl / 3` until released, so a forgotten `release()` keeps the key for as long as the process lives, and after a crash for one more `ttl`. Release in `finally`, or with `await using` (TypeScript 6.0.3 with `target: ES2023`, SWC and Node 24 compiled and ran it; the lock was free again right after the block). In the probe, `acquire('stock:reconcile', { wait: '2s' })` against a held key resolved `null` after 2002 ms; without `wait` it resolved `null` at once.

Pick the key by the resource the section writes, not by the caller: every writer of the same rows takes the same key, because fencing tokens are only comparable within one key (`lock-fencing-tokens`). Below, a one-SKU sync, an admin "reconcile now" and the scheduled `StockReconcileJob` all write `stock_level`, so all three take `stock:reconcile`.

**Incorrect (`null` ignored, no release; `withLock` refusal unhandled):**

```typescript
const lock = await this.locks.acquire(`stock:${sku}`); // another key than the job that writes the same rows
const quantity = await this.warehouse.stockCount(sku, lock!.signal); // TypeError when another holder has the key
await this.stockLevels.write(sku, quantity, lock!.fencingToken); // the lock is never released

await this.locks.withLock('stock:reconcile', (lock) => this.reconciler.reconcile(lock.fencingToken, lock.signal)); // LockNotAcquiredError becomes a 500
```

**Correct (`src/stock/stock-sync.service.ts`):**

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { Locks } from '@nestjs/locks';
import { StockLevelRepository } from './stock-level.repository.js';
import { WarehouseClient } from './warehouse.client.js';

@Injectable()
export class StockSyncService {
  private readonly logger = new Logger(StockSyncService.name);

  constructor(
    private readonly locks: Locks,
    private readonly warehouse: WarehouseClient,
    private readonly stockLevels: StockLevelRepository,
  ) {}

  /** `'busy'` while a sync or the reconcile job holds `stock:reconcile` on any instance: they write the same rows. */
  async syncSku(sku: string): Promise<'synced' | 'busy' | 'fenced'> {
    const lock = await this.locks.acquire('stock:reconcile', { ttl: '30s', wait: '2s' });
    if (!lock) return 'busy';
    try {
      const quantity = await this.warehouse.stockCount(sku, lock.signal);
      const written = await this.stockLevels.write(sku, quantity, lock.fencingToken);
      if (!written) {
        this.logger.warn('Stale stock write fenced off', { sku, fencingToken: lock.fencingToken });
        return 'fenced';
      }
      this.logger.debug('Stock synced', { sku, fencingToken: lock.fencingToken });
      return 'synced';
    } finally {
      await lock.release();
    }
  }
}
```

**Correct (`withLock` with the refusal handled, and `await using`):**

```typescript
/** An admin endpoint's "reconcile now": a refusal is a 409, not a silent skip; `'fenced'` tells the caller nothing was written. */
async reconcileNow(): Promise<'reconciled' | 'fenced'> {
  try {
    return await this.locks.withLock('stock:reconcile', (lock) => this.reconciler.reconcile(lock.fencingToken, lock.signal));
  } catch (error) {
    if (error instanceof LockNotAcquiredError) throw new ConflictException('Stock reconciliation is already running');
    throw error;
  }
}

async scoped(): Promise<void> {
  await using lock = await this.locks.acquire('stock:B-2');
  if (!lock) return;
  // ... released when the block ends, also on throw
}
```

Inside `withLock`, `LocksContext` also holds the lock, so services deeper in the call reach the token and signal without parameters; a lock from `acquire()` is not in `LocksContext` (`locksContext.fencingToken` was `undefined`) unless you wrap the call in `locksContext.run(lock, fn)`. Keys are arbitrary strings, case-sensitive, up to 500 characters; name them `<resource>:<id>`. A job's key (`job-explicit-keys`) taken here excludes the job's runs. `ttl` per call overrides the module's `'30s'`.

Reference: [NestJS Locks](https://docs.nestjs.com/reliability/locks)

---

### 3.2 Fence Every Write a Lock Guards With Its Token

**Impact: HIGH** — A paused holder overwrites the work of the holder that took over

A lock is a lease. A holder that pauses longer than `ttl` (GC, a blocked event loop, a lost database connection) loses the lock while still running; another instance takes it and runs the same section. When the paused holder resumes, its next renewal is refused and `lock.signal` aborts, but writes it has already started still land. The package can only report the loss: in the probe the store refused the renewal, `lock.held` became `false`, `lock.signal.reason` was a `LockLostError` (`detectedBy: 'renewal'`), and the package logged at warn `Lost the lock "stock:A-1" (fencing token 1): it expired before it was renewed, and another holder may have it. Stop writing on its behalf, and fence what it guards with its token.` (`detectedBy: 'deadline'` means `ttl` passed without a confirmed renewal, e.g. a store outage.)

The fence is the resource's job. Every acquisition gets a `fencingToken` greater than any earlier one for the key (proven by the contract suite, `store-contract-suite`). Store the token with the data and write only when the stored token is not greater (`<=` lets one holder write several times). Pass `lock.signal` to every call the section makes so it stops once the lock is lost. A job gets both from `LocksContext` (`job-without-overlapping`).

**Incorrect (write ignores the token; a stale holder wins last):**

```typescript
await this.dataSource.query(
  `INSERT INTO "stock_level" ("sku", "quantity") VALUES (?, ?)
   ON CONFLICT ("sku") DO UPDATE SET "quantity" = excluded."quantity"`,
  [sku, quantity],
);
```

**Correct (`src/stock/stock-level.repository.ts`, token-guarded upsert, and a snapshot that lands whole or not at all):**

```typescript
import { Injectable } from '@nestjs/common';
import { TransactionRunner } from '../database/transaction-runner.js';

export interface StockCount {
  sku: string;
  quantity: number;
}

/** Thrown inside the snapshot transaction to roll it back when one row is fenced off. */
class FencedOffError extends Error {}

@Injectable()
export class StockLevelRepository {
  constructor(private readonly transactions: TransactionRunner) {}

  /** Writes only if no later lock holder has written: `false` means this holder was fenced off. */
  async write(sku: string, quantity: number, fencingToken: number): Promise<boolean> {
    const rows: unknown[] = await this.transactions.run((manager) =>
      manager.query(
        `INSERT INTO "stock_level" ("sku", "quantity", "fencingToken") VALUES (?, ?, ?)
         ON CONFLICT ("sku") DO UPDATE SET "quantity" = excluded."quantity", "fencingToken" = excluded."fencingToken"
         WHERE "stock_level"."fencingToken" <= excluded."fencingToken"
         RETURNING "sku"`,
        [sku, quantity, fencingToken],
      ),
    );
    return rows.length === 1;
  }

  /** All rows or none: `false` (and nothing written) when a later holder has written any of them. */
  async writeSnapshot(counts: readonly StockCount[], fencingToken: number): Promise<boolean> {
    try {
      await this.transactions.run(async () => {
        for (const { sku, quantity } of counts) {
          // write() joins this transaction (re-entrant run()), so one fenced row rolls back the rows before it.
          if (!(await this.write(sku, quantity, fencingToken))) throw new FencedOffError(sku);
        }
      });
      return true;
    } catch (error) {
      if (error instanceof FencedOffError) return false;
      throw error;
    }
  }
}
```

**Correct (the fenced-off holder, `test/stock-sync.e2e-spec.ts`):**

```typescript
it('is fenced off once a later holder has written', async () => {
  await app.get(StockLevelRepository).write('A-1', 99, 1_000);
  expect(await app.get(StockSyncService).syncSku('A-1')).toBe('fenced');
  expect(await app.get(StockLevelRepository).find('A-1')).toEqual({ quantity: 99, fencingToken: 1_000 });
});
```

When the rows form one logical update (a reconcile's whole snapshot), write them with `writeSnapshot()`: with `B-2` already at token 1000, a snapshot of `A-1` and `B-2` at token 7 returned `false` and left `A-1` unwritten, where per-row `write()` calls left `A-1` at token 7 (`job-direct-calls`). The nested `write()` relies on the re-entrant `TransactionRunner` from `nestjs-typeorm`.

`StockSyncService.syncSku()` (`lock-acquire-release`) logs the refused write at warn, since the stale holder's work was dropped and the newer holder's kept. The `stock_level` table gets its `"fencingToken" integer NOT NULL` column from a migration (`nestjs-typeorm`). `TypeOrmLockStore` counts tokens per key, so tokens of two keys are not comparable: every writer of `stock_level` (the sync, the admin reconcile, `StockReconcileJob`) takes the one key `stock:reconcile`. For a downstream API, send the token (a header or field) and have it reject lower ones. Lost locks are also published on `LocksEvents.events$` and on the `nestjs:locks:lock-lost` diagnostics channel, for metrics and alerts; both carried `{"type":"lock-lost","key":"stock:A-1","fencingToken":1,"detectedBy":"renewal"}` in the probe. Writes inside a transaction follow `orm-atomic-writes` in `nestjs-typeorm`.

Reference: [NestJS Locks](https://docs.nestjs.com/reliability/locks)

---

## 4. Leader Election

**Section Impact: MEDIUM**

### 4.1 Run Continuous Single-Instance Work From @LeaderElection Hooks, Stopped by the Lease Signal

**Impact: MEDIUM** — Two instances consume the same stream after a leader pauses or loses its lease

`@LeaderElection(key, { ttl })` on a singleton provider makes every instance campaign for the lease `key` from `onApplicationBootstrap`. The winner's `onLeadershipAcquired(lock)` runs (logged `Leading "warehouse-feed" (fencing token 1)`); the leader renews every `ttl / 3`, the others retry as often. It fits work that runs continuously on one instance (a feed consumer, a socket to a partner); a periodic job belongs on `@OnOneInstance()` and `@WithoutOverlapping()` (`job-without-overlapping`).

Leadership ends three ways, each observed in the probe with two app instances sharing an `InMemoryLockStore` (`test-manual-lock-clock`):

- Shutdown: `app.close()` stepped down (`Stepped down from "warehouse-feed"`, then `Warehouse feed stopped` from the hook), `lock.signal` aborted with an `AbortError` `DOMException`, and the other instance led after its next campaign, one `ttl / 3` later, with fencing token 2.
- Lease lost: a leader whose renewals stopped for longer than `ttl` was replaced (token 2) while its own work still ran; when it resumed, its renewal was refused, `lock.signal` aborted with `LockLostError`, and `LocksEvents.events$` emitted `lock-lost` (`detectedBy: 'renewal'`) then `leadership-lost` (`reason: 'lost'`).
- A hook that throws, or returns a promise that rejects: `WarehouseFeed.onLeadershipAcquired() failed for "warehouse-feed": stepping down` at error with the stack, `Stepped down from "warehouse-feed"`, a `leadership-lost` event with `reason: 'released'`, and a new campaign every `ttl / 3` (2 attempts after 10 s with `ttl` 30 s).

The election only sees a failure the hook reports: it attaches its handler to the thenable `onLeadershipAcquired()` returns (`services/leader-elections.service.js`). Return the work's promise. With `void this.consume(…)`, the same rejection (`Error: feed connection reset`) reached `process.on('unhandledRejection')` instead, which ends a Node 24 process, and the election never stepped down (`events$` emitted only `leadership-acquired`). A returned promise that rejects because leadership ended is also reported: without the `signal.aborted` check below, every shutdown logged `onLeadershipAcquired() failed … stepping down` with an `AbortError`. Resolve when the signal aborts; reject only on a real failure.

Because of the overlap window, start the work with `lock.signal` so it stops on loss, and fence its writes with `lock.fencingToken` (`lock-fencing-tokens`). `onLeadershipLost(lock)` runs on every end; it is for cleanup and logging, not the only stop.

**Incorrect (work ignores the lease; a detached loop's rejection escapes the election):**

```typescript
@Injectable()
@LeaderElection('warehouse-feed')
export class WarehouseFeed implements OnLeadershipAcquired {
  onLeadershipAcquired(lock: Lock): void {
    setInterval(() => void this.pullUpdates(), 1_000); // still pulling on the old leader after a takeover
    void this.consume(lock.signal, lock.fencingToken); // a rejection is an unhandled rejection; no step-down
  }
}
```

**Correct (`src/stock/warehouse-feed.ts`):**

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { LeaderElection, type Lock, type OnLeadershipAcquired, type OnLeadershipLost } from '@nestjs/locks';
import { WarehouseUpdates } from './warehouse-updates.js';

@Injectable()
@LeaderElection('warehouse-feed', { ttl: '30s' })
export class WarehouseFeed implements OnLeadershipAcquired, OnLeadershipLost {
  private readonly logger = new Logger(WarehouseFeed.name);

  constructor(private readonly updates: WarehouseUpdates) {}

  /** Returned, not `void`ed: when the loop rejects, the election logs it and steps down so another instance leads. */
  onLeadershipAcquired(lock: Lock): Promise<void> {
    return this.consume(lock.signal, lock.fencingToken);
  }

  onLeadershipLost(lock: Lock): void {
    this.logger.log('Warehouse feed stopped', { fencingToken: lock.fencingToken });
  }

  /** Runs until leadership ends (resolves) or an update fails (rejects); every write carries `fencingToken`. */
  private async consume(signal: AbortSignal, fencingToken: number): Promise<void> {
    this.logger.log('Warehouse feed started', { fencingToken });
    try {
      while (!signal.aborted) await this.updates.applyNext(signal, fencingToken);
    } catch (error) {
      if (signal.aborted) return; // leadership ended: the abort is the stop, not a failure
      throw error;
    }
  }
}
```

`WarehouseUpdates.applyNext()` is one step of the consumer: it passes `signal` to every call it makes, so it rejects with the abort reason once leadership ends. In the probe, a failing step logged `Warehouse feed started`, the error above, `Stepped down from "warehouse-feed"` and `Warehouse feed stopped`, with no unhandled rejection; `app.close()` logged the same without the error.

The provider must be a singleton and implement at least one hook, or startup fails with `@LeaderElection("no-hooks") on NoHooks: implement OnLeadershipAcquired (onLeadershipAcquired(lock)) and OnLeadershipLost (onLeadershipLost(lock)), or the election has nothing to call`. An election key is checked against job keys and their leases at startup: `@LeaderElection("stock:reconcile:owner")` next to a job keyed `stock:reconcile` failed with `… both use the lock key "stock:reconcile:owner", so they would exclude each other.` (`job-explicit-keys`). Log levels follow `nestjs-logging`: start and stop of the feed are `log` events.

Reference: [NestJS Locks](https://docs.nestjs.com/reliability/locks)

---

## 5. Testing Locks

**Section Impact: MEDIUM**

### 5.1 Test Expiry and Takeover With a ManualLockClock per Instance and a Shared In-Memory Store

**Impact: MEDIUM** — Slow real-time sleeps, or tests that never see a lock expire

Lock timing runs on a `LockClock`: lease deadlines, renewals every `ttl / 3`, `wait` polling, and the in-memory store's expiry. `ManualLockClock` (exported from `@nestjs/locks`) moves only when a test calls `await clock.advance(duration)`, firing every due timer in order and waiting for each renewal to reach the store. Give it to the module's options (`LocksModule.forRoot({ clock })`, or in a test `overrideProvider(LOCKS_MODULE_OPTIONS)`, which replaces the whole options object); test the code that uses locks against an `InMemoryLockStore`, and the durable store separately with the contract suite (`store-contract-suite`).

The trap is one clock for everything: the holder's renewals fire as the clock advances, so its lock never expires. With one shared clock, `advance('31s')` past a 30 s `ttl` left the lock with instance A and instance B's `acquire()` resolved `null`. A paused process is an instance whose clock does not move while the store's does: give each simulated instance its own `ManualLockClock`, give the shared store another, and register that store in every instance in place of the production store. Then B took the key with a greater token, and when A's clock moved its renewal was refused and `lockA.signal.reason` was a `LockLostError` with `detectedBy: 'renewal'`. Both tests run in milliseconds; the real-time alternative sleeps past `ttl`.

**Incorrect (one clock for both instances and the store):**

```typescript
const clock = new ManualLockClock();
const store = new InMemoryLockStore({ clock });
const [a, b] = [await instance(clock, store), await instance(clock, store)];
await a.get(Locks).acquire('stock:reconcile', { ttl: '30s' });
await clock.advance('31s'); // A renewed at 10 s, 20 s and 30 s
expect(await b.get(Locks).acquire('stock:reconcile')).not.toBeNull(); // fails: null
```

**Correct (`test/lock-expiry.e2e-spec.ts`):**

```typescript
import { InMemoryLockStore, LOCKS_MODULE_OPTIONS, LockLostError, Locks, LocksStorage, ManualLockClock } from '@nestjs/locks';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { TypeOrmLockStore } from '../src/distributed-locks/typeorm-lock-store.js';
import { createTestApp } from './support/test-app.js';

/** One simulated app instance: the real AppModule, its locks on `clock`, its store the one all instances share. */
function instance(clock: ManualLockClock, store: InMemoryLockStore): Promise<NestExpressApplication> {
  return createTestApp((builder) =>
    builder
      .overrideProvider(LOCKS_MODULE_OPTIONS)
      .useValue({ ttl: '30s', clock })
      // Registers the shared store instead of the production one (store-register-durable).
      .overrideProvider(TypeOrmLockStore)
      .useFactory({ factory: (storage: LocksStorage) => storage.registerSource(store), inject: [LocksStorage] }),
  );
}

describe('stock:reconcile lock across instances', () => {
  const apps: NestExpressApplication[] = [];
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
  });

  it('keeps a lock its holder renews', async () => {
    const clock = new ManualLockClock();
    const store = new InMemoryLockStore({ clock });
    apps.push(await instance(clock, store));

    const lock = (await apps[0].get(Locks).acquire('stock:reconcile', { ttl: '30s' }))!;
    await clock.advance('5m'); // renewals every 10 s fire on the way

    expect(lock.held).toBe(true);
    expect(store.peek('stock:reconcile')?.fencingToken).toBe(lock.fencingToken);
  });

  it('hands the lock to another instance when the holder pauses past its ttl', async () => {
    const storeClock = new ManualLockClock();
    const store = new InMemoryLockStore({ clock: storeClock });
    const clockA = new ManualLockClock();
    const clockB = new ManualLockClock();
    apps.push(await instance(clockA, store), await instance(clockB, store));

    const lockA = (await apps[0].get(Locks).acquire('stock:reconcile', { ttl: '30s' }))!;
    await storeClock.advance('31s'); // A is paused: its clock stands still, so no renewal reaches the store
    const lockB = (await apps[1].get(Locks).acquire('stock:reconcile', { ttl: '30s' }))!;
    expect(lockB.fencingToken).toBeGreaterThan(lockA.fencingToken);

    await clockA.advance('10s'); // A resumes: its renewal is refused
    expect(lockA.held).toBe(false);
    expect(lockA.signal.reason).toBeInstanceOf(LockLostError);
    expect(lockA.signal.reason).toMatchObject({ key: 'stock:reconcile', detectedBy: 'renewal' });
  });
});
```

`InMemoryLockStore#peek(key)` returns the live lock (`{ owner, fencingToken, expiresAt }`) or `undefined`, for assertions. The same setup drives `@LeaderElection()` takeovers (`leader-election-hooks`). `createTestApp()` is `nestjs-testing`'s helper; the overrides run before `compile()`, so the provider that registers the store in production never runs and the shared store is the only one. `ManualLockClock` replaces only the package's clock; `@nestjs/schedule` timers in the same test need Vitest fake timers (`nestjs-schedule`).

Reference: [NestJS Locks](https://docs.nestjs.com/reliability/locks)

---

## References

- https://docs.nestjs.com
- https://github.com/nestjs/nest
- https://typeorm.io
- https://github.com/typestack/class-validator
- https://github.com/goldbergyoni/nodebestpractices

---

*Generated by build-agents.ts on 2026-10-30*
