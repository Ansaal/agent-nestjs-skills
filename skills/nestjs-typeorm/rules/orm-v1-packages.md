---
title: Install TypeORM 1.x with better-sqlite3 12
impact: CRITICAL
impactDescription: Wrong driver or major version fails typecheck or lands outside TypeORM's peer range
tags: typeorm, better-sqlite3, versions, install
---

## Install TypeORM 1.x with better-sqlite3 12

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
