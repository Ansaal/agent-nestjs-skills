---
title: Fence Every Write a Lock Guards With Its Token
impact: HIGH
impactDescription: A paused holder overwrites the work of the holder that took over
tags: locks, fencing-token, signal, LockLostError, guarded-write
---

## Fence Every Write a Lock Guards With Its Token

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
