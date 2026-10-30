# NestJS TypeORM

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

TypeORM 1.x persistence for NestJS 12 ESM projects on better-sqlite3. Use when installing or configuring TypeORM, writing entities with relations, generating, checking or running migrations, writing transactions (`TransactionRunner`, nested service calls) or concurrent updates, deciding which reads must see only committed rows, or handling duplicate keys.

---

## Table of Contents

1. [TypeORM Setup and Writes](#1-typeorm-setup-and-writes) — **CRITICAL**
   - 1.1 [Write Atomically with Guarded Updates and Serialized Transactions](#11-write-atomically-with-guarded-updates-and-serialized-transactions)
   - 1.2 [Type Relation Properties as Relation<T>](#12-type-relation-properties-as-relation-t-)
   - 1.3 [Share One Typed DataSource File](#13-share-one-typed-datasource-file)
   - 1.4 [Detect Duplicates from the Unique Constraint](#14-detect-duplicates-from-the-unique-constraint)
   - 1.5 [Install TypeORM 1.x with better-sqlite3 12](#15-install-typeorm-1-x-with-better-sqlite3-12)
   - 1.6 [Write TypeORM 1.x Query Forms](#16-write-typeorm-1-x-query-forms)
2. [Migrations](#2-migrations) — **HIGH**
   - 2.1 [Run the TypeORM CLI through typeorm-ts-node-esm Scripts](#21-run-the-typeorm-cli-through-typeorm-ts-node-esm-scripts)
   - 2.2 [List Migration Classes in the DataSource](#22-list-migration-classes-in-the-datasource)

---

## 1. TypeORM Setup and Writes

**Section Impact: CRITICAL**

### 1.1 Write Atomically with Guarded Updates and Serialized Transactions

**Impact: CRITICAL** — Lost updates, version regressions, rolled-back reads, and concurrent requests failing inside transactions

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

---

### 1.2 Type Relation Properties as Relation<T>

**Impact: HIGH** — Circular entity imports crash the built app and the TypeORM CLI with a TDZ ReferenceError

Two entities that reference each other import each other. With `emitDecoratorMetadata`, SWC emits `_ts_metadata("design:type", typeof Category === "undefined" ? Object : Category)` for a property typed `Category`; in ESM the imported class is still in its temporal dead zone while the cycle loads, and even `typeof` throws. The built app (`node dist/main.js`) and the TypeORM CLI then fail with `ReferenceError: Cannot access 'Category' before initialization`. Vitest can pass at the same time because its import order differs, so a green test run does not prove the entities are safe. `Relation<T>` (`type Relation<T> = T`) is type-only, so the emitted metadata falls back to `Object` and the cycle disappears; the arrow functions in the decorators already tell TypeORM the target entity.

**Incorrect (bare entity types on relation properties):**

```typescript
@Entity('products')
export class Product {
  @ManyToOne(() => Category, (category) => category.products) category: Category;
}

@Entity('categories')
export class Category {
  @OneToMany(() => Product, (product) => product.category) products: Product[];
}
```

**Correct (`Relation<T>` on both sides, imported as a type):**

```typescript
import { Column, Entity, ManyToOne, PrimaryGeneratedColumn, type Relation } from 'typeorm';
import { Category } from './category.entity.js';

@Entity('products')
export class Product {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ unique: true }) sku: string;
  @Column('integer') version: number;
  @Column({ type: 'varchar', default: '' }) title: string;
  @Column({ type: 'varchar', nullable: true }) deletedReason: string | null;
  @ManyToOne(() => Category, (category) => category.products, { nullable: true }) category: Relation<Category> | null;
}
```

```typescript
import { Column, Entity, OneToMany, PrimaryGeneratedColumn, type Relation } from 'typeorm';
import { Product } from './product.entity.js';

@Entity('categories')
export class Category {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ unique: true }) name: string;
  @OneToMany(() => Product, (product) => product.category) products: Relation<Product[]>;
}
```

SWC also emits `Object` for union-typed columns such as `deletedReason: string | null`, so give those columns an explicit `type`; otherwise boot fails with `DataTypeNotSupportedError: Data type "Object" in "Product.deletedReason" is not supported by "better-sqlite3" database.`

Reference: [TypeORM: Relations in ESM projects](https://typeorm.io/docs/getting-started#relations-in-esm-projects)

---

### 1.3 Share One Typed DataSource File

**Impact: CRITICAL** — CLI and app drift apart; schema changes bypass migrations; DB errors in tests hang until timeout

The TypeORM CLI needs a file that default-exports a `DataSource`; the Nest app needs options for `TypeOrmModule`. Keep both in `src/data-source.ts` so entities, migrations and the database path are declared once. List entities explicitly there: `autoLoadEntities` only exists inside Nest, so the CLI would see no entities. Type the options as `Extract<DataSourceOptions, { type: 'better-sqlite3' }>` (`typeorm` does not export a `BetterSqlite3DataSourceOptions` name); the plain `DataSourceOptions` union breaks as soon as the factory overrides a field, e.g. `Type '() => { database: string; … type: "aurora-mysql"; … }' is not assignable to type '(...args: any[]) => TypeOrmModuleOptions | Promise<TypeOrmModuleOptions>'`.

Schema changes reach every database through migrations only, so `synchronize` is `false` in every environment, tests included; the app applies pending migrations on boot with `migrationsRun: true`. `TypeOrmModule` retries a failed connection 10 times, 3 s apart, by default; with SQLite a failure (bad path, broken migration) is deterministic, so `retryAttempts: 0` surfaces it at once instead of turning it into a 30 s hang and a Vitest timeout.

**Incorrect (inline config, synchronize, default retries):**

```typescript
@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'better-sqlite3',
      database: 'data.sqlite',
      autoLoadEntities: true,
      synchronize: true,
    }),
  ],
})
export class AppModule {}
```

**Correct (`src/data-source.ts`, used by the CLI and the app):**

```typescript
import 'reflect-metadata';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { Category } from './catalog/category.entity.js';
import { Product } from './catalog/product.entity.js';
import { Init1793292175434 } from './migrations/1793292175434-Init.js';
import { AddProductTitle1793292348845 } from './migrations/1793292348845-AddProductTitle.js';

type SqliteOptions = Extract<DataSourceOptions, { type: 'better-sqlite3' }>;

export const dataSourceOptions: SqliteOptions = {
  type: 'better-sqlite3',
  database: process.env.DB_PATH ?? 'data.sqlite',
  entities: [Category, Product],
  migrations: [Init1793292175434, AddProductTitle1793292348845],
  synchronize: false,
};

export default new DataSource(dataSourceOptions);
```

**Correct (`src/app.module.ts` reuses the options):**

```typescript
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CatalogModule } from './catalog/catalog.module.js';
import { dataSourceOptions } from './data-source.js';
import { DatabaseModule } from './database/database.module.js';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: () => ({ ...dataSourceOptions, migrationsRun: true, retryAttempts: 0 }),
    }),
    DatabaseModule, // TransactionRunner, orm-atomic-writes
    CatalogModule,
  ],
})
export class AppModule {}
```

**Correct (tests get a fresh, migrated in-memory database per app instance: one key in `test.env`):**

```typescript
// vitest.config.ts, inside the existing `test.env`; the whole file is nestjs-setup's vitest-swc-configs
DB_PATH: ':memory:',
```

Add the key next to the ones already in `test.env` and keep the rest of the config as `nestjs-setup` defines it. Every `:memory:` connection is a separate empty database, so each app that boots `AppModule` starts from the migrated schema with no rows; `nestjs-testing` creates one app per test (`e2e-real-app-module`). `:memory:` is for the app under test only: the migration CLI runs each command in its own process and needs a file database (`migration-cli-ts-node-esm`). Feature modules register repositories with `TypeOrmModule.forFeature([Product])`.

Reference: [NestJS docs: Database (TypeORM)](https://docs.nestjs.com/techniques/database)

---

### 1.4 Detect Duplicates from the Unique Constraint

**Impact: HIGH** — Check-then-insert races into duplicates or 500s; message matching breaks across drivers

A pre-check (`exists`, then `insert`) races: both requests see "absent" and the second insert fails anyway. Let the database decide: insert, and treat a unique-constraint failure as "already exists". TypeORM wraps driver errors in `QueryFailedError`; the better-sqlite3 `SqliteError` sits in `error.driverError` with a stable `code`. A `UNIQUE` column violation has `code: 'SQLITE_CONSTRAINT_UNIQUE'`, and a primary-key violation has `code: 'SQLITE_CONSTRAINT_PRIMARYKEY'`, although both messages read `UNIQUE constraint failed: products.<column>`. Match on the code, never on the message text.

**Incorrect (check-then-insert, message matching):**

```typescript
async create(sku: string, version: number) {
  if (await this.products.existsBy({ sku })) return 'duplicate';
  try {
    await this.products.insert({ sku, version });
  } catch (error) {
    if (String(error).includes('UNIQUE')) return 'duplicate';
    throw error;
  }
  return 'created';
}
```

**Correct (`src/database/is-unique-violation.ts`):**

```typescript
import { QueryFailedError } from 'typeorm';

const UNIQUE_CODES: ReadonlySet<unknown> = new Set(['SQLITE_CONSTRAINT_UNIQUE', 'SQLITE_CONSTRAINT_PRIMARYKEY']);

/** True when a write failed on a UNIQUE or PRIMARY KEY constraint (better-sqlite3). */
export function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const driverError: unknown = error.driverError;
  return (
    typeof driverError === 'object' &&
    driverError !== null &&
    'code' in driverError &&
    UNIQUE_CODES.has(driverError.code)
  );
}
```

**Correct (insert first, map the violation):**

```typescript
async create(sku: string, version: number): Promise<'created' | 'duplicate'> {
  try {
    await this.transactions.run((manager) => manager.insert(Product, { sku, version }));
    return 'created';
  } catch (error) {
    if (isUniqueViolation(error)) return 'duplicate';
    throw error;
  }
}
```

The write goes through `TransactionRunner` (see `orm-atomic-writes`). `driverError` is narrowed with `typeof` and `in` instead of being cast, and the set is typed `ReadonlySet<unknown>` so it accepts the unchecked `code`: a driver error without a string code is simply not a unique violation. In the probe a duplicate `sku` reported `SQLITE_CONSTRAINT_UNIQUE`, a duplicate `id` `SQLITE_CONSTRAINT_PRIMARYKEY`, and the helper returned `true`, `true` and `false` for those two and a plain `Error`; the e2e `POST /api/products` mapped it to 409. Back the dedup key with a `unique: true` column or primary key declared in a migration; without the constraint there is nothing to violate. Another driver needs its own codes in the set (PostgreSQL reports `23505`).

Reference: [better-sqlite3 API: SqliteError](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md#class-sqliteerror)

---

### 1.5 Install TypeORM 1.x with better-sqlite3 12

**Impact: CRITICAL** — Wrong driver or major version fails typecheck or lands outside TypeORM's peer range

TypeORM 1.x removed the `sqlite3` driver; SQLite runs only through `type: 'better-sqlite3'`, and `type: 'sqlite'` no longer typechecks (`Type '"sqlite"' is not assignable to type '"better-sqlite3" | "aurora-mysql" | …'`). `typeorm` 1.1.2 declares the peer `better-sqlite3 ^12.0.0`, while `better-sqlite3@latest` is 13.x, so an unpinned install lands outside the supported range. `@nestjs/typeorm` 12.0.2 accepts TypeORM 1.x (peer `typeorm ^0.3.0 || ^1.0.0-dev`). In 1.x the SQLite option `busyTimeout` is renamed `timeout` and `flags` is removed.

**Incorrect (0.3-era driver, unpinned native module):**

```bash
pnpm add @nestjs/typeorm typeorm sqlite3
pnpm add better-sqlite3   # resolves 13.x, outside typeorm's peer range
```

```typescript
TypeOrmModule.forRoot({ type: 'sqlite', database: 'data.sqlite', synchronize: true });
```

**Correct (1.x with the better-sqlite3 12 line, ts-node for the CLI):**

```bash
pnpm add @nestjs/typeorm typeorm@^1.1 better-sqlite3@^12
pnpm add -D ts-node
```

`better-sqlite3` is a native module that pnpm must be allowed to build; `nestjs-setup` owns that step. Configure the connection once in `src/data-source.ts` (see `orm-single-data-source`); `ts-node` is needed by the CLI (see `migration-cli-ts-node-esm`).

Reference: [TypeORM 1.0 upgrade guide](https://typeorm.io/docs/releases/1.0/upgrading-from-0.3)

---

### 1.6 Write TypeORM 1.x Query Forms

**Impact: HIGH** — 0.3-era APIs fail typecheck; null or undefined in where throws at runtime

Most TypeORM examples in training data are 0.3.x. TypeORM 1.x removed `Connection`/`ConnectionOptions` (use `DataSource`/`DataSourceOptions`), the global helpers (`getRepository`, `getConnection`, `createConnection`), `findByIds`, `findOneById`, `Repository.exist()`, and string arrays for `relations` and `select`. These fail typecheck, e.g. `Module '"typeorm"' has no exported member 'Connection'` and `Type 'string[]' has no properties in common with type 'FindOptionsRelations<Product>'`. Where values changed too: `invalidWhereValuesBehavior` now defaults to `throw`. A literal `null` is already a type error under `strict`, but `undefined` compiles (an optional filter field) and rejects at runtime with `Undefined value encountered in property 'Product.sku' of a where condition.`; a `null` arriving from untyped input rejects with `Null value encountered in property 'Product.deletedReason' of a where condition. To match with SQL NULL, the IsNull() operator must be used.`

**Incorrect (0.3 APIs):**

```typescript
import { Connection } from 'typeorm';

await products.findByIds(ids);
await products.findOneById(id);
await products.find({ relations: ['category'], select: ['id', 'sku'] });
await products.findBy({ deletedReason: null }); // meant: match SQL NULL
await products.findBy({ sku: filter.sku }); // throws when the filter is absent
```

**Correct (1.x forms):**

```typescript
import { In, IsNull, type FindOptionsWhere, type Repository } from 'typeorm';
import type { Product } from './product.entity.js';

export async function productQueries(products: Repository<Product>, ids: string[], id: string, sku?: string) {
  const byIds = await products.findBy({ id: In(ids) });
  const one = await products.findOneBy({ id });
  const withCategory = await products.find({ relations: { category: true }, select: { id: true, sku: true } });
  const active = await products.findBy({ deletedReason: IsNull() });
  const where: FindOptionsWhere<Product> = sku === undefined ? {} : { sku };
  const filtered = await products.findBy(where);
  return { byIds, one, withCategory, active, filtered };
}
```

Inject `DataSource` (not `Connection`) and repositories via `@InjectRepository(Entity)`. For an existing 0.3 codebase the upgrade guide documents `npx @typeorm/codemod v1 src/`, which rewrites most of these and leaves `TODO` comments for the rest.

Reference: [TypeORM 1.0 upgrade guide](https://typeorm.io/docs/releases/1.0/upgrading-from-0.3)

---

## 2. Migrations

**Section Impact: HIGH**

### 2.1 Run the TypeORM CLI through typeorm-ts-node-esm Scripts

**Impact: HIGH** — Other runners cannot load the TypeScript DataSource or lose decorator metadata; generating against the wrong database re-emits existing tables

The CLI has to load `src/data-source.ts`, its `.js`-suffixed ESM imports, and decorator metadata. `typeorm-ts-node-esm` (a bin shipped by `typeorm`; needs the `ts-node` devDependency) does all three. Plain `typeorm` runs on Node and fails with `Unable to open file: "…/src/data-source.ts". Cannot find module '…/src/catalog/category.entity.js'`. `tsx node_modules/typeorm/cli.js` loads the file, but esbuild emits no decorator metadata, so it fails with `Column type for Product#sku is not defined and cannot be guessed`. Wrap the commands in package scripts so the runner and `-d` path are written once.

`migration:generate` diffs the entities against the database at `DB_PATH`, so that database must hold every registered migration. Each CLI command is its own process, and with `DB_PATH=:memory:` (the test value, `orm-single-data-source`) each opens a new empty database: after `migration:run` had executed both migrations, `migration:check` in the next process still reported `Unexpected changes in database schema were found in check mode:` followed by `CREATE TABLE "products" …`. Run the commands in one subshell against a new file in a `mktemp -d` directory, with an `EXIT` trap that deletes only that directory. A fixed path such as `./tmp/migrations.sqlite` survives a failed command, so the next run no longer starts empty, and deleting its folder takes unrelated files with it.

The generated file imports `MigrationInterface` and `QueryRunner` as values (`import { MigrationInterface, QueryRunner } from "typeorm";`), which fails the lint gate of `nestjs-setup`: ``All imports in the declaration are only used as types. Use `import type`  @typescript-eslint/consistent-type-imports``. Fix and format the file before registering it. With `projectService` the autofix is safe here (`lint-decorator-type-imports`) and rewrote it to `import type { MigrationInterface, QueryRunner } from 'typeorm';`. The value import also breaks loading by path glob (`migration-list-classes`).

**Incorrect (wrong runner, no data source flag, generated against `:memory:`):**

```bash
npx typeorm migration:run -d src/data-source.ts
npx tsx node_modules/typeorm/cli.js migration:generate src/migrations/AddProductTitle -d src/data-source.ts
npx typeorm-ts-node-esm migration:run   # Missing required argument: dataSource
DB_PATH=:memory: pnpm migration:generate src/migrations/AddProductTitle   # re-emits every table
```

**Correct (`package.json` scripts):**

```json
{
  "scripts": {
    "migration:generate": "typeorm-ts-node-esm migration:generate -d src/data-source.ts",
    "migration:create": "typeorm-ts-node-esm migration:create",
    "migration:run": "typeorm-ts-node-esm migration:run -d src/data-source.ts",
    "migration:revert": "typeorm-ts-node-esm migration:revert -d src/data-source.ts",
    "migration:show": "typeorm-ts-node-esm migration:show -d src/data-source.ts",
    "migration:check": "typeorm-ts-node-esm migration:generate -d src/data-source.ts --check src/migrations/Check"
  }
}
```

**Correct (schema change workflow, each database fresh and removed on exit):**

```bash
(
  set -eu
  dir=$(mktemp -d)                                # own line: set -e stops here if mktemp fails
  trap 'rm -rf "$dir"' EXIT                       # removes only this run's database, on failure too
  export DB_PATH="$dir/migrations.sqlite"
  pnpm migration:run                              # bring it up to every registered migration first
  pnpm migration:generate src/migrations/AddProductTitle
)
pnpm exec eslint --fix src/migrations && pnpm exec prettier --write src/migrations   # import type, house style
# register the class in src/data-source.ts (migration-list-classes), then run the CI check below
```

**Correct (CI, and the check after registering):**

```bash
(
  set -eu
  dir=$(mktemp -d)
  trap 'rm -rf "$dir"' EXIT
  export DB_PATH="$dir/migrations.sqlite"
  pnpm migration:run
  pnpm migration:show                             # every line [X]
  pnpm migration:check                            # "No changes in database schema were found", exit 0
)
```

CI runs `migration:run` first because `migration:check` only compares: against a database without the migrations it reports every table as an unexpected change. With them applied, an entity change that has no migration exits 1 with `Unexpected changes in database schema were found in check mode`. In the probe, generation touched only the changed table (SQLite rebuilds it through `temporary_products`); under both bash and zsh the CI block listed `[X]` for each class and printed `No changes in database schema were found`, and a `false` inserted after `migration:run` exited the subshell with 1 while the trap still removed the database directory and left a file in `./tmp` in place. `migration:create src/migrations/BackfillTitles` writes an empty migration for data changes and needs no `-d`. `migration:revert` undoes the latest executed migration.

Reference: [TypeORM: Migrations](https://typeorm.io/docs/migrations/why)

---

### 2.2 List Migration Classes in the DataSource

**Impact: HIGH** — Glob paths crash tests and the built app; unregistered migrations are silently skipped

Path globs make TypeORM `import()` the matched files itself, outside any TypeScript loader, so Node's built-in type stripping loads `src/migrations/*.ts`. A generated migration whose `import { MigrationInterface, QueryRunner } from "typeorm"` is still a value import then fails under Vitest and in the built app (`node dist/main.js`) with `SyntaxError: The requested module 'typeorm' does not provide an export named 'MigrationInterface'`, because those names are types. After the import is converted (`migration-cli-ts-node-esm`), the glob still works only where `src/` sits next to `dist/`: the same build copied without `src/` logged `Nest application successfully started` against a database that held only the `migrations` table. A `dist/**/*.js` glob misses the `.ts` files the CLI and Vitest load, and `__dirname` does not exist in ESM. Import the migration classes and list them: the same array then works in the CLI, Vitest, and the built app.

The flip side: TypeORM runs only what the array lists. A migration that `migration:generate` wrote but nobody registered is ignored, and `migration:run` prints `No migrations are pending` while the schema is out of date.

**Incorrect (glob strings):**

```typescript
export const dataSourceOptions: SqliteOptions = {
  type: 'better-sqlite3',
  database: process.env.DB_PATH ?? 'data.sqlite',
  entities: [Category, Product],
  migrations: ['src/migrations/*.ts'],
  synchronize: false,
};
```

**Correct (import and list every migration class, oldest first):**

```typescript
import { Init1793292175434 } from './migrations/1793292175434-Init.js';
import { AddProductTitle1793292348845 } from './migrations/1793292348845-AddProductTitle.js';

export const dataSourceOptions: SqliteOptions = {
  type: 'better-sqlite3',
  database: process.env.DB_PATH ?? 'data.sqlite',
  entities: [Category, Product],
  migrations: [Init1793292175434, AddProductTitle1793292348845],
  synchronize: false,
};
```

After every `migration:generate` or `migration:create`, add the new file's import (with the `.js` suffix) and append its class to `migrations` in the same change, then run `migration:run` and `migration:show` (every entry `[X]`). The class name is the name you passed plus the timestamp in the file name (`src/migrations/AddProductTitle` → `AddProductTitle1793292348845` in `1793292348845-AddProductTitle.ts`). Full file: `orm-single-data-source`; commands: `migration-cli-ts-node-esm`.

Reference: [TypeORM: Migrations](https://typeorm.io/docs/migrations/why)

---

## References

- https://docs.nestjs.com
- https://github.com/nestjs/nest
- https://typeorm.io
- https://github.com/typestack/class-validator
- https://github.com/goldbergyoni/nodebestpractices

---

*Generated by build-agents.ts on 2026-10-30*
