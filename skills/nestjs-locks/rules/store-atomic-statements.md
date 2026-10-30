---
title: Write Each Lock Store Method as One Compare-and-Set Statement
impact: CRITICAL
impactDescription: Concurrent callers all acquire the same key; renewals that silently roll back or starve behind long transactions
tags: locks, lock-store, sqlite, typeorm, fencing-token, atomic, returning
---

## Write Each Lock Store Method as One Compare-and-Set Statement

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
