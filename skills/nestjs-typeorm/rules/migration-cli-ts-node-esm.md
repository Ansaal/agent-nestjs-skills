---
title: Run the TypeORM CLI through typeorm-ts-node-esm Scripts
impact: HIGH
impactDescription: Other runners cannot load the TypeScript DataSource or lose decorator metadata
tags: typeorm, cli, migrations, esm, ts-node, package-scripts
---

## Run the TypeORM CLI through typeorm-ts-node-esm Scripts

The CLI has to load `src/data-source.ts`, its `.js`-suffixed ESM imports, and decorator metadata. `typeorm-ts-node-esm` (a bin shipped by `typeorm`; needs the `ts-node` devDependency) does all three. Plain `typeorm` runs on Node and fails with `Unable to open file: "…/src/data-source.ts". Cannot find module '…/src/catalog/category.entity.js'`. `tsx node_modules/typeorm/cli.js` loads the file, but esbuild emits no decorator metadata, so it fails with `ColumnTypeUndefinedError: Column type for Product#sku is not defined and cannot be guessed`. Wrap the commands in package scripts so the runner and `-d` path are written once.

**Incorrect (wrong runner, no data source flag):**

```bash
npx typeorm migration:run -d src/data-source.ts
npx tsx node_modules/typeorm/cli.js migration:generate src/migrations/AddProductTitle -d src/data-source.ts
npx typeorm-ts-node-esm migration:run   # Missing required argument: dataSource
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

**Correct (schema change workflow):**

```bash
pnpm migration:run                                    # bring the local DB (DB_PATH, default data.sqlite) up to date first
pnpm migration:generate src/migrations/AddProductTitle # diff entities vs that DB → src/migrations/<timestamp>-AddProductTitle.ts
# register the class in src/data-source.ts (migration-list-classes)
pnpm migration:run
pnpm migration:show                                   # every line [X]
pnpm migration:check                                  # "No changes in database schema were found", exit 0
```

`migration:generate` diffs entities against the database at `DB_PATH`; against an empty or stale database it re-emits tables that earlier migrations already create, so run pending migrations before generating. `migration:create src/migrations/BackfillTitles` writes an empty migration for data changes and needs no `-d`. `migration:revert` undoes the latest executed migration. In CI, `migration:check` exits 1 with `Unexpected changes in database schema were found in check mode` when an entity change has no migration.

Reference: [TypeORM: Migrations](https://typeorm.io/docs/migrations/why)
