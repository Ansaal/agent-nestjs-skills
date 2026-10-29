---
title: Write Atomically with Guarded Updates and Serialized Transactions
impact: CRITICAL
impactDescription: Lost updates, version regressions, and concurrent requests failing inside transactions
tags: typeorm, transactions, concurrency, optimistic-locking, better-sqlite3
---

## Write Atomically with Guarded Updates and Serialized Transactions

Read-then-write (`findOneBy`, compare in JavaScript, `save`) lets two overlapping requests both pass the check, so an older version can overwrite a newer one. Put the condition into the statement instead: `UPDATE … WHERE sku = :id AND version < :version` is atomic on its own, and the `UpdateResult.affected` count (populated by better-sqlite3 from `changes`, `0` when the guard rejects) tells you whether the write happened.

When several statements must commit together, run them in `dataSource.transaction(async (manager) => …)` and issue every statement through that `manager`. better-sqlite3 gives a `DataSource` one shared connection and one shared `QueryRunner`, so transactions from concurrent requests collide. Two that start in the same tick fail with `QueryFailedError: SqliteError: cannot start a transaction within a transaction`. One that starts while another is open runs as a savepoint inside it: it resolves as committed, and its rows vanish when the outer transaction rolls back. Route every transaction through one app-wide `TransactionRunner` that runs them one at a time.

**Incorrect (read-then-write; unserialized transactions):**

```typescript
async applySnapshot(sku: string, version: number) {
  const existing = await this.products.findOneBy({ sku });
  if (existing && existing.version >= version) return 'stale';
  await this.products.save({ ...existing, sku, version }); // a newer write may have landed in between
}

await Promise.all([a, b].map((v) => this.dataSource.transaction((manager) => apply(manager, v))));
// QueryFailedError: SqliteError: cannot start a transaction within a transaction
```

**Correct (`src/database/transaction-runner.ts`, provided once app-wide):**

```typescript
import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';

/** better-sqlite3 gives a DataSource one shared connection, so transactions must run one at a time. */
@Injectable()
export class TransactionRunner {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly dataSource: DataSource) {}

  run<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    const result = this.tail.then(() => this.dataSource.transaction(work));
    this.tail = result.catch(() => undefined);
    return result;
  }
}
```

```typescript
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
  constructor(
    private readonly transactions: TransactionRunner,
    @InjectRepository(Product) private readonly products: Repository<Product>,
  ) {}

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

Import `DatabaseModule` once in `AppModule`. Send every write through `run()`, single statements included: while a transaction is open, a statement from another request on the shared connection runs inside it and is rolled back with it (a plain `repository.insert` issued during a failing transaction left 0 rows), and reads outside `run()` can see its uncommitted rows. A failed `work` rolls back and the next queued transaction still runs. Keep `run()` calls out of `work` itself (the nested call waits for the outer one forever); pass `manager` down instead. Seven concurrent `applySnapshot` calls with versions `5, 3, 9, 1, 7, 2, 8` leave version `9` stored.

Reference: [NestJS docs: Database transactions](https://docs.nestjs.com/techniques/database#transactions)
