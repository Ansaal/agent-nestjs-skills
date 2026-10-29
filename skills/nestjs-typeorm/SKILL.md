---
name: nestjs-typeorm
description: TypeORM 1.x persistence for NestJS 12 ESM projects on better-sqlite3. Use when installing or configuring TypeORM, writing entities with relations, generating or running migrations, or writing concurrent updates and duplicate-key handling.
license: MIT
metadata:
  author: Ansaal
  version: "1.0.0"
---

# NestJS TypeORM

Rules for `@nestjs/typeorm` with TypeORM 1.x and `better-sqlite3` in an ESM NestJS app built with SWC. They cover the package set, the one shared `DataSource` file, entity relations, migrations and the CLI, and atomic writes. Verified 2026-10-29 against NestJS 12.3.2, @nestjs/typeorm 12.0.2, TypeORM 1.1.2, better-sqlite3 12.11.1, ts-node 10.9.2, TypeScript 6.0.3, @swc/core 1.16.20, Vitest 5.0.5 on Node 22.21.

Project scaffolding, native build approval and the SWC/Vitest toolchain belong to `nestjs-setup`; test structure belongs to `nestjs-testing`.

## Rules
| Prefix | Section | Impact |
|--------|---------|--------|
| `orm-` | TypeORM Setup and Writes | CRITICAL |
| `migration-` | Migrations | HIGH |

- `orm-v1-packages` - Install `typeorm@^1.1` with `better-sqlite3@^12` and `type: 'better-sqlite3'`
- `orm-v1-removed-apis` - Write 1.x query forms: `DataSource`, `findBy` + `In`, object `relations`/`select`, `IsNull()`
- `orm-single-data-source` - One typed `src/data-source.ts` shared by the CLI and `forRootAsync`
- `orm-relation-wrapper` - Type every relation property as `Relation<T>`
- `orm-atomic-writes` - Guarded single-statement updates; serialized transactions on `manager`
- `orm-unique-violation` - Detect duplicates via `QueryFailedError` + `driverError.code`
- `migration-list-classes` - List migration classes in the `DataSource`; register every generated one
- `migration-cli-ts-node-esm` - Run the CLI through `typeorm-ts-node-esm` package scripts

Read `rules/<id>.md` for the rule's reasoning and examples.
