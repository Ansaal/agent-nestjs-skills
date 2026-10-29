---
title: Detect Duplicates from the Unique Constraint
impact: HIGH
impactDescription: Check-then-insert races into duplicates or 500s; message matching breaks across drivers
tags: typeorm, better-sqlite3, unique, idempotency, errors
---

## Detect Duplicates from the Unique Constraint

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

const UNIQUE_CODES = new Set(['SQLITE_CONSTRAINT_UNIQUE', 'SQLITE_CONSTRAINT_PRIMARYKEY']);

/** True when a write failed on a UNIQUE or PRIMARY KEY constraint (better-sqlite3). */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof QueryFailedError && UNIQUE_CODES.has((error.driverError as { code?: string }).code ?? '');
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

The write goes through `TransactionRunner` (see `orm-atomic-writes`). Back the dedup key with a `unique: true` column or primary key declared in a migration; without the constraint there is nothing to violate. Another driver needs its own codes in the set (PostgreSQL reports `23505`).

Reference: [better-sqlite3 API: SqliteError](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md#class-sqliteerror)
