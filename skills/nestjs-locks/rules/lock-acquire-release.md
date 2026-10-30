---
title: Handle a Refused Lock and Release Every Lock You Take
impact: HIGH
impactDescription: Work runs unlocked on null, or a held lock blocks the key for a full ttl
tags: locks, acquire, withLock, LockNotAcquiredError, await-using, release
---

## Handle a Refused Lock and Release Every Lock You Take

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
