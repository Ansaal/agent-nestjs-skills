---
title: Share One Typed DataSource File
impact: CRITICAL
impactDescription: CLI and app drift apart; schema changes bypass migrations; DB errors in tests hang until timeout
tags: typeorm, datasource, configuration, forRootAsync, migrations
---

## Share One Typed DataSource File

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
import { dataSourceOptions } from './data-source.js';
import { CatalogModule } from './catalog/catalog.module.js';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: () => ({ ...dataSourceOptions, migrationsRun: true, retryAttempts: 0 }),
    }),
    CatalogModule,
  ],
})
export class AppModule {}
```

**Correct (tests get a fresh, migrated in-memory database per app instance, `vitest.config.ts`):**

```typescript
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { globals: true, root: './', include: ['src/**/*.spec.ts', 'test/**/*.e2e-spec.ts'], env: { DB_PATH: ':memory:' } },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
```

Every `:memory:` connection is a separate empty database, so each test that boots `AppModule` starts from the migrated schema with no rows. Feature modules register repositories with `TypeOrmModule.forFeature([Product])`.

Reference: [NestJS docs: Database (TypeORM)](https://docs.nestjs.com/techniques/database)
