---
title: Run the TypeORM CLI through typeorm-ts-node-esm Scripts
impact: HIGH
impactDescription: Other runners cannot load the TypeScript DataSource or lose decorator metadata; generating against the wrong database re-emits existing tables
tags: typeorm, cli, migrations, esm, ts-node, package-scripts, ci
---

## Run the TypeORM CLI through typeorm-ts-node-esm Scripts

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
