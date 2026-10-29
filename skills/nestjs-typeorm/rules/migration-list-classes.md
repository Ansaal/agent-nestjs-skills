---
title: List Migration Classes in the DataSource
impact: HIGH
impactDescription: Glob paths crash tests and the built app; unregistered migrations are silently skipped
tags: typeorm, migrations, esm, datasource
---

## List Migration Classes in the DataSource

Path globs make TypeORM `import()` the matched files itself, outside any TypeScript loader, so Node's built-in type stripping loads `src/migrations/*.ts`. Under Vitest and in the built app (`node dist/src/main.js`), the generated `import { MigrationInterface, QueryRunner } from "typeorm"` then fails with `SyntaxError: The requested module 'typeorm' does not provide an export named 'MigrationInterface'`, because those names are types. A `dist/**/*.js` glob misses the `.ts` files the CLI and Vitest load, and `__dirname` does not exist in ESM. Import the migration classes and list them: the same array then works in the CLI, Vitest, and the built app.

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
