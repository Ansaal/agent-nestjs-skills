# NestJS Setup

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

NestJS project setup for the current Nest major (ESM, SWC builder, Vitest with unplugin-swc, pnpm). Use when scaffolding a Nest project, adding or upgrading `@nestjs/*` packages, or fixing project config (tsconfig, nest-cli.json, vitest config, `.js` import errors, decorator-metadata or circular-import crashes, pnpm build approvals).

---

## Table of Contents

1. [Version Policy](#1-version-policy) — **CRITICAL**
   - 1.1 [Check the Registry Before Installing Nest Packages](#11-check-the-registry-before-installing-nest-packages)
   - 1.2 [Pin Node 24 LTS in .nvmrc and engines](#12-pin-node-24-lts-in-nvmrc-and-engines)
2. [ESM Project Shape](#2-esm-project-shape) — **CRITICAL**
   - 2.1 [Wrap Circular Type References in Relation or WrapperType](#21-wrap-circular-type-references-in-relation-or-wrappertype)
   - 2.2 [Write ESM Import Specifiers and Module Paths](#22-write-esm-import-specifiers-and-module-paths)
   - 2.3 [Configure the Project as ESM with Decorator Metadata](#23-configure-the-project-as-esm-with-decorator-metadata)
3. [SWC Builder](#3-swc-builder) — **HIGH**
   - 3.1 [Pair the SWC Builder with typeCheck](#31-pair-the-swc-builder-with-typecheck)
4. [Vitest Configuration](#4-vitest-configuration) — **HIGH**
   - 4.1 [Compile Vitest Runs with unplugin-swc](#41-compile-vitest-runs-with-unplugin-swc)
5. [pnpm Build Approvals](#5-pnpm-build-approvals) — **MEDIUM-HIGH**
   - 5.1 [Approve Native Builds with allowBuilds](#51-approve-native-builds-with-allowbuilds)

---

## 1. Version Policy

**Section Impact: CRITICAL**

### 1.1 Check the Registry Before Installing Nest Packages

**Impact: CRITICAL** — Prevents starting on a stale major with outdated APIs, CommonJS and Jest-era tooling

Versions recalled from memory lag the registry: a setup written from memory lands on an older Nest major with CommonJS, Jest and `ts-jest`, while Nest 12 ships ESM-only packages and scaffolds ESM + Vitest. Ask the registry first, then install with an explicit major. The framework packages (`@nestjs/common`, `core`, `platform-*`, `testing`, `cli`, `schematics`) share one major; integration packages (`@nestjs/typeorm` 12.0.2, `@nestjs/config` 12.0.1, `@nestjs/resilience` 0.0.3) have their own numbering, so pick the release whose `peerDependencies` include that major. A mismatch still installs: pnpm prints only `Issues with peer dependencies found` and exits 0, so `pnpm peers check` is the gate.

**Incorrect (versions from memory, mixed majors):**

```bash
pnpm add @nestjs/core @nestjs/common @nestjs/typeorm@11   # @nestjs/typeorm 11 peers on ^10 || ^11
pnpm add -D jest ts-jest @types/jest typescript           # typescript@latest is 7, the Nest 12 CLI checks with 6
```

**Correct (registry first, explicit major, peers checked):**

```bash
node -v                                              # see version-pin-node
npm view @nestjs/core version                        # 12.3.2 on 2026-10-29
npm view @nestjs/cli engines dependencies.typescript
npm view @nestjs/schematics engines peerDependencies
npm view @nestjs/typeorm peerDependencies            # repeat for every integration package you add

pnpm add @nestjs/common@^12 @nestjs/core@^12 @nestjs/platform-express@^12 reflect-metadata rxjs
pnpm add -D @nestjs/cli@^12 @nestjs/schematics@^12 @nestjs/testing@^12 typescript@^6 @types/node@^24 @types/express
pnpm peers check                                     # done when it prints "No peer dependency issues found"
```

Snapshot, verified 2026-10-29:

| Package | Version | Constraint that matters |
|---------|---------|-------------------------|
| `@nestjs/common`, `core`, `platform-express`, `testing` | 12.3.2 | ESM-only: `"type": "module"`, no `require` export condition |
| `@nestjs/cli` | 12.0.11 | depends on `typescript ~6.0.2`, which runs the `nest build` type check |
| `@nestjs/schematics` | 12.0.12 | engines `^22.22.3 \|\| ^24.15.0 \|\| >=26.0.0`; peer `typescript >=6.0.0` |
| `typescript` | 6.0.3 | `latest` is 7.0.2; install `^6` so `tsc` matches the CLI's checker |
| `vitest` | 5.0.5 | engines `^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0` |
| `@swc/core`, `@swc/cli`, `unplugin-swc` | 1.16.20, 0.8.2, 2.0.0 | |

When `npm view @nestjs/core version` reports a major above 12, read the migration guide first; treat this snapshot and every rule in this skill as possibly stale until the guide confirms them.

`nest new` templates lag the registry: `@nestjs/cli` 12.0.11 writes `vitest ^4.1.2` and `@nestjs/* ^12.0.1`. After scaffolding, compare `package.json` with `npm view` and bump.

Reference: [NestJS migration guide](https://docs.nestjs.com/migration-guide)

---

### 1.2 Pin Node 24 LTS in .nvmrc and engines

**Impact: CRITICAL** — Keeps nest generators, Vitest and the runtime on a Node version all of them support

A Nest 12 project has three Node floors: the runtime needs 20.19+ or 22.12+, Vitest 5 needs `^22.12.0 || ^24.0.0 || >=26.0.0`, and `nest new` / `nest generate` / `nest upgrade` (via `@nestjs/schematics`) need `^22.22.3 || ^24.15.0 || >=26.0.0`. Node 24 at 24.15 or later satisfies all three. Nothing stops a wrong Node by default: pnpm 12 installs `@nestjs/schematics` on Node 22.21 without a warning and ignores the project's own `engines` field. With `engineStrict: true`, a wrong Node fails the install: `ERR_PNPM_UNSUPPORTED_ENGINE … wanted: {"node":"^24.15.0"} (current: {"node":"24.14.0"})`. Run `node -v` before any install or `nest` command; on a mismatch, switch with `nvm use` / `nvm install`.

**Incorrect (whatever Node is active, nothing pinned):**

```json
{
  "name": "app",
  "private": true,
  "type": "module"
}
```

**Correct (exact version in `.nvmrc`, range in `engines`, enforced by pnpm):**

```bash
node -v                       # must satisfy ^24.15.0
nvm version-remote 24         # newest 24.x, v24.22.2 on 2026-10-29
echo 24.22.2 > .nvmrc
nvm install                   # installs and activates the .nvmrc version
```

```json
{
  "name": "app",
  "private": true,
  "type": "module",
  "engines": {
    "node": "^24.15.0"
  }
}
```

```yaml
# pnpm-workspace.yaml
engineStrict: true
```

`.nvmrc` holds an exact version because a major-only `24` resolves to the newest *installed* 24.x, which can be below 24.15. `engineStrict` also applies to dependencies' `engines`, which every package in this stack satisfies on Node 24.15+.

Reference: [NestJS migration guide – Node.js requirements](https://docs.nestjs.com/migration-guide)

---

## 2. ESM Project Shape

**Section Impact: CRITICAL**

### 2.1 Wrap Circular Type References in Relation or WrapperType

**Impact: HIGH** — Prevents "Cannot access 'X' before initialization" crashes at boot that tests do not reproduce

With ESM and SWC, decorator metadata (`design:type`, `design:paramtypes`) reads the imported class while the module is still being evaluated. When two files import each other, one of the classes is not initialized yet and the built app crashes at boot: `ReferenceError: Cannot access 'ProfileService' before initialization`, and after fixing the services, `ReferenceError: Cannot access 'Profile' before initialization` for the entities. `forwardRef()` fixes Nest's provider ordering, not this metadata read. Vitest's module runner hides the bug: the same circular providers and entities passed a Vitest spec while the `nest build` output crashed under `node`, so prove a cycle fix with `nest build` and a boot. Wrapping the type in an alias makes SWC emit `Object` instead of the class: TypeORM's `Relation<T>` for entity relation properties, a local `WrapperType<T>` for `forwardRef` constructor parameters.

**Incorrect (plain class types across a circular import):**

```typescript
// users.service.ts ↔ profile.service.ts import each other
@Injectable()
export class UsersService {
  constructor(
    @Inject(forwardRef(() => ProfileService))
    private readonly profiles: ProfileService,
  ) {}
}

// user.entity.ts ↔ profile.entity.ts import each other
@Entity()
export class User {
  @PrimaryGeneratedColumn() id: number;

  @OneToOne(() => Profile, (profile) => profile.user)
  @JoinColumn()
  profile: Profile;
}
```

**Correct (alias-wrapped types on both sides of each cycle):**

```typescript
// wrapper-type.ts
/** Type alias that SWC emits as `Object` in decorator metadata, so the class reference is not read at load time. */
export type WrapperType<T> = T;
```

```typescript
// users.service.ts (profile.service.ts mirrors it with WrapperType<UsersService>)
import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { ProfileService } from './profile.service.js';
import type { WrapperType } from './wrapper-type.js';

@Injectable()
export class UsersService {
  constructor(
    @Inject(forwardRef(() => ProfileService))
    private readonly profiles: WrapperType<ProfileService>,
  ) {}

  name(): string {
    return 'user';
  }

  describe(): string {
    return `${this.name()} with ${this.profiles.name()}`;
  }
}
```

```typescript
// user.entity.ts (profile.entity.ts mirrors it with `user: Relation<User>`)
import { Entity, JoinColumn, OneToOne, PrimaryGeneratedColumn, type Relation } from 'typeorm';
import { Profile } from './profile.entity.js';

@Entity()
export class User {
  @PrimaryGeneratedColumn() id: number;

  @OneToOne(() => Profile, (profile) => profile.user)
  @JoinColumn()
  profile: Relation<Profile>;
}
```

Removing the cycle is the better fix where the design allows it (`nestjs-best-practices`, `arch-avoid-circular-deps`); entity modelling lives in `nestjs-typeorm`.

Reference: [NestJS SWC recipe – Common pitfalls](https://docs.nestjs.com/recipes/swc)

---

### 2.2 Write ESM Import Specifiers and Module Paths

**Impact: CRITICAL** — Prevents TS2307 compile errors and __dirname crashes at runtime

Under `nodenext`, a relative import names the emitted file, so it ends in `.js` even though the source is `.ts`; without the suffix TypeScript 6 reports `error TS2307: Cannot find module './app.module' or its corresponding type declarations.` The same applies to deep imports into packages that have no `exports` map, e.g. `supertest/types.js` (the `nest new` e2e spec imports `supertest/types` and fails `tsc` with TS2307). ES modules have no `__dirname`; `tsc` accepts it because `@types/node` declares it globally, and the app crashes at runtime with `ReferenceError: __dirname is not defined in ES module scope`. Use `import.meta.dirname`. ESM entry points allow top-level await, so `main.ts` awaits `NestFactory.create` and `listen` directly, without a `bootstrap()` wrapper.

**Incorrect (CommonJS habits):**

```typescript
import { NestFactory } from '@nestjs/core';
import { join } from 'path';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useStaticAssets(join(__dirname, '..', 'public'));
  await app.listen(3000);
}
bootstrap();
```

**Correct (`src/main.ts`):**

```typescript
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'node:path';
import { AppModule } from './app.module.js';

const app = await NestFactory.create<NestExpressApplication>(AppModule);
app.useStaticAssets(join(import.meta.dirname, '..', 'public'));
await app.listen(process.env.PORT ?? 3000);
```

`import.meta.dirname` is the directory of the emitted file (`dist/` after `nest build`), so paths resolve relative to the build output.

Reference: [NestJS migration guide – ESM](https://docs.nestjs.com/migration-guide)

---

### 2.3 Configure the Project as ESM with Decorator Metadata

**Impact: CRITICAL** — Aligns package type, compiler and output layout with Nest 12's ESM-only packages

Nest 12 packages are ESM-only and `nest new` scaffolds ESM projects (the prompt offers CommonJS; non-interactive runs default to ESM). `"type": "module"` makes Node, the SWC builder and Vitest all treat the output as ES modules. `nodenext` applies Node's real resolution rules at compile time, `experimentalDecorators` + `emitDecoratorMetadata` produce the `design:paramtypes` / `design:type` metadata that Nest DI and TypeORM read, `isolatedModules` makes `tsc` reject what per-file compilers like SWC cannot compile, and `types: ["vitest/globals", "node"]` matches `globals: true` in the Vitest config (`vitest-swc-configs`). `tsconfig.build.json` limits the build to `src` without specs; without it, `nest build` compiled `app.controller.spec.js` into `dist` and failed on type errors in `test/`.

**Incorrect (CommonJS-era config):**

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2021",
    "experimentalDecorators": true,
    "outDir": "./dist",
    "types": ["node", "jest"]
  }
}
```

**Correct (`package.json`, `tsconfig.json`, `tsconfig.build.json`):**

```json
{
  "name": "app",
  "private": true,
  "type": "module",
  "engines": {
    "node": "^24.15.0"
  },
  "scripts": {
    "build": "nest build",
    "start": "nest start",
    "start:dev": "nest start --watch",
    "start:prod": "node dist/main.js",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "vitest run --config ./vitest.config.e2e.ts"
  }
}
```

```json
{
  "compilerOptions": {
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "resolvePackageJsonExports": true,
    "esModuleInterop": true,
    "isolatedModules": true,
    "declaration": true,
    "removeComments": true,
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true,
    "allowSyntheticDefaultImports": true,
    "target": "ES2023",
    "sourceMap": true,
    "outDir": "./dist",
    "incremental": true,
    "skipLibCheck": true,
    "strict": true,
    "strictPropertyInitialization": false,
    "types": ["vitest/globals", "node"]
  }
}
```

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": "./src"
  },
  "include": ["src"],
  "exclude": ["node_modules", "test", "dist", "**/*spec.ts"]
}
```

`tsconfig.json` covers `src`, `test` and the Vitest configs, so `pnpm typecheck` is the only step that type-checks spec files: `nest build` reads `tsconfig.build.json`, which excludes them, and Vitest checks no types. Run it next to `pnpm test` in CI.

Reference: [NestJS migration guide – ESM](https://docs.nestjs.com/migration-guide)

---

## 3. SWC Builder

**Section Impact: HIGH**

### 3.1 Pair the SWC Builder with typeCheck

**Impact: HIGH** — Prevents type errors from shipping in builds that report success

SWC strips types without checking them. With `"builder": "swc"` alone, `nest build` printed `Successfully compiled: 5 files with swc` and exited 0 for a source file containing `TS2322: Type 'string' is not assignable to type 'number'`. `"typeCheck": true` runs `tsc` in no-emit mode next to SWC (and runs CLI plugins such as Swagger's): the same build fails with `Found 1 type error(s) during compilation.` and exit code 1. The SWC builder emits ES modules because `package.json` has `"type": "module"`, so no `.swcrc` is needed. Install the builder with `pnpm add -D @swc/cli @swc/core`, then approve `@swc/core`'s install script (`pnpm-allow-builds`).

**Incorrect (fast build, no type check):**

```json
{
  "compilerOptions": {
    "builder": "swc"
  }
}
```

**Correct (`nest-cli.json`):**

```json
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": {
    "builder": "swc",
    "typeCheck": true,
    "deleteOutDir": true
  }
}
```

In `nest start --watch` the check runs asynchronously: the app still starts, and errors appear afterwards as `src/app.service.ts:10:14 - error TS2322 …` followed by `TSC  Found 1 error. Watching for file changes.`, so read the TSC lines after each rebuild. The check covers `tsconfig.build.json`, i.e. `src` without specs; specs are covered by `pnpm typecheck` (`esm-project-config`).

Reference: [NestJS SWC recipe](https://docs.nestjs.com/recipes/swc)

---

## 4. Vitest Configuration

**Section Impact: HIGH**

### 4.1 Compile Vitest Runs with unplugin-swc

**Impact: HIGH** — Keeps decorator metadata in tests identical to the SWC build, whatever Vite version resolves

Vitest compiles TypeScript with Vite's transformer, not with Nest's SWC builder, and `nest new` scaffolds no SWC plugin. Vitest 5 accepts Vite `^6.4.0 || ^7.0.0 || ^8.0.0`: Vite 8 (Oxc) emits decorator metadata, Vite 6/7 (esbuild) do not, and then DI and TypeORM fail with `Nest could not find DownstreamClient element (this provider does not exist in the current context)` and `ColumnTypeUndefinedError: Column type for Product#sku is not defined and cannot be guessed` (verified with Vite 7.3.7). `unplugin-swc` makes tests compile with SWC, the same compiler as `nest build`, whichever Vite resolves. `module: { type: 'es6' }` keeps a CommonJS `.swcrc` from leaking into the ESM test run. Supertest is a CommonJS function export: `import * as request` fails with `TS2349: This expression is not callable.` and at runtime with `TypeError: (0 , __vite_ssr_import_1__) is not a function`.

Install: `pnpm add -D vitest unplugin-swc @swc/core supertest @types/supertest`. The scripts (`test`, `test:watch`, `test:e2e`, `typecheck`) are in `esm-project-config`; `globals: true` pairs with `"types": ["vitest/globals", "node"]` there.

**Incorrect (Vite's transformer decides whether metadata exists):**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { globals: true, include: ['**/*.spec.ts'] },
});
```

**Correct (`vitest.config.ts` for unit specs in `src/`):**

```typescript
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['src/**/*.spec.ts'],
  },
  // SWC compiles the tests exactly like `nest build` does, decorator metadata included.
  // `module: es6` keeps a CommonJS `.swcrc` from leaking into the ESM test run.
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
```

**Correct (`vitest.config.e2e.ts` for `test/**/*.e2e-spec.ts`):**

```typescript
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
```

**Correct (`test/app.e2e-spec.ts` smoke test proving the setup):**

```typescript
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(() => app.close());

  it('GET /', () => request(app.getHttpServer()).get('/').expect(200).expect('Hello World!'));
});
```

How to write unit and e2e tests (auto-mocking, overrides, database in tests) lives in `nestjs-testing`.

Reference: [NestJS SWC recipe – Vitest](https://docs.nestjs.com/recipes/swc)

---

## 5. pnpm Build Approvals

**Section Impact: MEDIUM-HIGH**

### 5.1 Approve Native Builds with allowBuilds

**Impact: MEDIUM-HIGH** — Prevents failed installs and missing native bindings for @swc/core and better-sqlite3

pnpm 12 runs no dependency install scripts until each package is approved. Adding `@swc/core` or `better-sqlite3` fails with `ERR_PNPM_IGNORED_BUILDS … Ignored build scripts: @swc/core@1.16.20, better-sqlite3@12.11.1` and exit code 1, and an unbuilt `better-sqlite3` later throws `Error: Could not locate the bindings file.` The approvals live under `allowBuilds` in `pnpm-workspace.yaml`; the older `onlyBuiltDependencies` list is ignored by pnpm 12 (the install still fails with `ERR_PNPM_IGNORED_BUILDS`). Approve exactly the packages pnpm names: `@swc/core` (SWC builder, unplugin-swc), `better-sqlite3` (`nestjs-typeorm`), and `esbuild` once something pulls it in (`tsx`, Vite 6/7; a Vite 8 tree has none). Commit `pnpm-workspace.yaml` so every checkout and CI run builds the same packages.

**Incorrect (pnpm 9/10 key, ignored by pnpm 12):**

```yaml
onlyBuiltDependencies:
  - '@swc/core'
  - better-sqlite3
```

**Correct (approve by name after the failed install):**

```bash
pnpm approve-builds @swc/core better-sqlite3   # runs the scripts and writes allowBuilds
```

**Correct (or declare before installing, `pnpm-workspace.yaml`):**

```yaml
allowBuilds:
  '@swc/core': true
  better-sqlite3: true
```

Running `pnpm approve-builds` without arguments opens an interactive picker; pass the package names in non-interactive shells.

Reference: [pnpm approve-builds](https://pnpm.io/cli/approve-builds)

---

## References

- https://docs.nestjs.com
- https://github.com/nestjs/nest
- https://typeorm.io
- https://github.com/typestack/class-validator
- https://github.com/goldbergyoni/nodebestpractices

---

*Generated by build-agents.ts on 2026-10-29*
