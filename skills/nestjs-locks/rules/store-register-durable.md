---
title: Register One Durable Lock Store That Every Instance Shares
impact: CRITICAL
impactDescription: Every instance takes the same lock and runs the same job
tags: locks, lock-store, registerSource, production, in-memory
---

## Register One Durable Lock Store That Every Instance Shares

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
