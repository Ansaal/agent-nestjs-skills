---
name: nestjs-typeorm
description: TypeORM 1.x persistence for NestJS 12 ESM projects on better-sqlite3. Use when installing or configuring TypeORM, writing entities with relations, generating, checking or running migrations, writing transactions (`TransactionRunner`, nested service calls) or concurrent updates, deciding which reads must see only committed rows, or handling duplicate keys.
license: MIT
metadata:
  author: Ansaal
  version: "1.0.0"
---

# NestJS TypeORM

Rules for `@nestjs/typeorm` with TypeORM 1.x and `better-sqlite3` in an ESM NestJS app built with SWC. They cover the package set, the one shared `DataSource` file, entity relations, migrations and the CLI, and atomic writes. Every write in every skill goes through `TransactionRunner.run()` (`orm-atomic-writes`), directly or through a service that calls it. Verified 2026-10-29 against NestJS 12.3.2, @nestjs/typeorm 12.0.2, TypeORM 1.1.2, better-sqlite3 12.11.1, ts-node 10.9.2, TypeScript 6.0.3, @swc/core 1.16.20, Vitest 5.0.5, ESLint 10.13.0 with typescript-eslint 8.72.1, Prettier 3.9.10, on Node 24.22.2.

Project scaffolding, native build approval, the SWC/Vitest toolchain and the one `vitest.config.ts` belong to `nestjs-setup` (this skill adds `DB_PATH: ':memory:'` to its `test.env`); test structure belongs to `nestjs-testing`.

## Rules
| Prefix | Section | Impact |
|--------|---------|--------|
| `orm-` | TypeORM Setup and Writes | CRITICAL |
| `migration-` | Migrations | HIGH |

- `orm-v1-packages` - Install `typeorm@^1.1` with `better-sqlite3@^12` and `type: 'better-sqlite3'`
- `orm-v1-removed-apis` - Write 1.x query forms: `DataSource`, `findBy` + `In`, object `relations`/`select`, `IsNull()`
- `orm-single-data-source` - One typed `src/data-source.ts` shared by the CLI and `forRootAsync`; tests add only `DB_PATH: ':memory:'` to setup's `test.env`
- `orm-relation-wrapper` - Type every relation property as `Relation<T>`
- `orm-atomic-writes` - Guarded single-statement updates; one re-entrant `TransactionRunner` (nested `run()` joins via `AsyncLocalStorage`, the manager is cleared when the outer work settles, synchronous throws reject); reads that must not see uncommitted rows go through `run()`
- `orm-unique-violation` - Detect duplicates via `QueryFailedError` + `driverError.code`
- `migration-list-classes` - List migration classes in the `DataSource`; register every generated one
- `migration-cli-ts-node-esm` - Run the CLI through `typeorm-ts-node-esm` package scripts; generate and check in a subshell against a `mktemp -d` database its `EXIT` trap removes, convert the generated import to `import type`; CI runs `migration:run` then `migration:check`

Read `rules/<id>.md` for the rule's reasoning and examples.
