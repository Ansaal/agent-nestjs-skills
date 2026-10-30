---
title: Write Atomically with Guarded Updates and Serialized Transactions
impact: CRITICAL
impactDescription: Lost updates, version regressions, rolled-back reads, and concurrent requests failing inside transactions
tags: typeorm, transactions, concurrency, optimistic-locking, better-sqlite3, async-local-storage
---

## Write Atomically with Guarded Updates and Serialized Transactions

Read-then-write (`findOneBy`, compare in JavaScript, `save`) lets two overlapping requests both pass the check, so an older version can overwrite a newer one. Put the condition into the statement instead: `UPDATE … WHERE sku = :id AND version < :version` is atomic on its own, and the `UpdateResult.affected` count (populated by better-sqlite3 from `changes`, `0` when the guard rejects) tells you whether the write happened.

When several statements must commit together, they run in one transaction and every statement goes through its `manager`. better-sqlite3 gives a `DataSource` one shared connection and one shared `QueryRunner`, so transactions from concurrent requests collide: two `dataSource.transaction()` calls started in the same tick failed with `QueryFailedError: SqliteError: cannot start a transaction within a transaction` and `TransactionNotStartedError`. A statement issued from elsewhere while a transaction is open runs inside it and is rolled back with it. Route every transaction through one app-wide `TransactionRunner` that runs them one at a time.

Services compose, so a transactional method calls another one that also uses `run()`. A plain queue deadlocks there: the inner call waits for the outer one to finish, and the outer one waits for the inner result (in the probe it was still pending after 1 s). The runner therefore keeps the open transaction's manager in `AsyncLocalStorage`, and a `run()` inside it joins that transaction instead of queueing. The runner clears the manager as soon as the outer work settles, so a callback that inherited the context and fires later (a timer, such as a lock renewal started inside a transaction) queues like any top-level call instead of writing through a finished transaction, and the context it holds no longer references that manager. Both paths call `work` through `.then()`, so a synchronous throw rejects the returned promise instead of throwing at the call site.

**Incorrect (read-then-write; unserialized transactions; a queue that cannot nest):**

```typescript
async applySnapshot(sku: string, version: number) {
  const existing = await this.products.findOneBy({ sku });
  if (existing && existing.version >= version) return 'stale';
  await this.products.save({ ...existing, sku, version }); // a newer write may have landed in between
}

await Promise.all([a, b].map((v) => this.dataSource.transaction((manager) => apply(manager, v))));
// QueryFailedError: SqliteError: cannot start a transaction within a transaction

run<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
  const result = this.tail.then(() => this.dataSource.transaction(work));
  this.tail = result.catch(() => undefined);
  return result; // a run() inside work waits for this one forever
}
```

**Correct (`src/database/transaction-runner.ts`, provided once app-wide):**

```typescript
import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';

interface ActiveTransaction {
  /** Cleared when the outer work settles, so contexts that outlive the transaction hold no manager. */
  manager?: EntityManager;
}

/**
 * better-sqlite3 gives a DataSource one shared connection, so transactions run one at a time.
 * A run() inside an open transaction joins it instead of queueing behind it.
 */
@Injectable()
export class TransactionRunner {
  private readonly active = new AsyncLocalStorage<ActiveTransaction>();
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly dataSource: DataSource) {}

  run<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    // `.then(work)`: a synchronous throw in work rejects the returned promise on both paths.
    const joined = this.active.getStore()?.manager;
    if (joined) return Promise.resolve(joined).then(work);

    const result = this.tail.then(() =>
      this.dataSource.transaction((manager) => {
        const transaction: ActiveTransaction = { manager };
        return this.active
          .run(transaction, () => Promise.resolve(manager).then(work))
          .finally(() => {
            // Callbacks that inherited this context and fire later (timers) now queue like top-level calls.
            transaction.manager = undefined;
          });
      }),
    );
    this.tail = result.catch(() => undefined);
    return result;
  }
}
```

```typescript
// src/database/database.module.ts
import { Global, Module } from '@nestjs/common';
import { TransactionRunner } from './transaction-runner.js';

@Global()
@Module({ providers: [TransactionRunner], exports: [TransactionRunner] })
export class DatabaseModule {}
```

**Correct (guarded update inside a serialized transaction):**

```typescript
export type ApplyResult = 'inserted' | 'updated' | 'stale';

@Injectable()
export class ProductService {
  constructor(private readonly transactions: TransactionRunner) {}

  /** Applies a snapshot only if its version is newer than the stored one. */
  applySnapshot(sku: string, version: number): Promise<ApplyResult> {
    return this.transactions.run(async (manager) => {
      const updated = await manager
        .createQueryBuilder()
        .update(Product)
        .set({ version })
        .where({ sku })
        .andWhere('version < :version', { version })
        .execute();
      if (updated.affected) return 'updated';
      if (await manager.existsBy(Product, { sku })) return 'stale';
      await manager.insert(Product, { sku, version });
      return 'inserted';
    });
  }
}
```

**Correct (`test/transaction-runner.e2e-spec.ts`, the runner's contract):**

```typescript
import type { NestExpressApplication } from '@nestjs/platform-express';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { Product } from '../src/catalog/product.entity.js';
import { TransactionRunner } from '../src/database/transaction-runner.js';
import { createTestApp } from './support/test-app.js';

let app: NestExpressApplication;
let runner: TransactionRunner;
let products: Repository<Product>;

beforeEach(async () => {
  app = await createTestApp();
  runner = app.get(TransactionRunner);
  products = app.get<Repository<Product>>(getRepositoryToken(Product));
  return () => app.close();
});

it('rolls back the outer transaction when a nested run() throws', async () => {
  const outcome = runner.run(async (manager) => {
    await manager.insert(Product, { sku: 'outer', version: 1 });
    await runner.run(async (inner) => {
      await inner.insert(Product, { sku: 'inner', version: 1 });
      throw new Error('inner failed');
    });
  });

  await expect(outcome).rejects.toThrow('inner failed');
  expect(await products.count()).toBe(0);
});

it('serializes concurrent top-level runs', async () => {
  const log: string[] = [];
  const tx = (name: string) =>
    runner.run(async (manager) => {
      log.push(`start ${name}`);
      await manager.insert(Product, { sku: name, version: 1 });
      await new Promise((resolve) => setTimeout(resolve, 10));
      log.push(`end ${name}`);
    });

  await Promise.all([tx('a'), tx('b'), tx('c')]);

  expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
});
```

Import `DatabaseModule` once in `AppModule` (`orm-single-data-source`). Send every write through `run()`, single statements included, directly or through a service whose method calls it. Await nested `run()` calls inside `work`; the join lasts only until the outer `work` settles. In the probe, against an app with a migrated `:memory:` database:

- A nested `run()` completed and both rows committed; the same code on the plain queue was still pending after 1 s.
- A throw in the nested `run()` rejected the outer one and left 0 rows. A join has no savepoint: when the outer `work` caught the inner error and went on, the inner row committed with the outer one.
- A nested `run()` whose callback threw synchronously returned a rejected promise; calling `work(manager)` directly on the join path threw at the call site instead.
- Three concurrent top-level runs logged `start a, end a, start b, end b, start c, end c`, and seven concurrent `applySnapshot` calls with versions `5, 3, 9, 1, 7, 2, 8` left version `9` stored.
- A `setTimeout` started inside a transaction fired after its commit while another request's transaction was open and then rolled back; its insert queued behind that transaction and survived, and the store it inherited read `{ manager: undefined }`. A variant that kept joining after the outer work settled wrote the insert into the other request's transaction, and the rollback removed it; one that only flagged the context closed still held the `EntityManager`.

Reads follow one contract. A read that decides a write, or whose result must not include rows another request may still roll back, goes through `run()` together with the write it decides, on the same `manager`. A plain repository read runs on the shared connection whenever it is issued, including in the middle of someone else's transaction: in the probe, `products.countBy({ sku })` during an open transaction returned `1` for a row that was rolled back moments later, while the same count through `run()` waited for the rollback and returned `0`. Use plain repository reads only for data where that is acceptable, such as display lists.

Reference: [NestJS docs: Database transactions](https://docs.nestjs.com/techniques/database#transactions), [Node.js: AsyncLocalStorage](https://nodejs.org/api/async_context.html#class-asynclocalstorage)
