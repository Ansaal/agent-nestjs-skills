---
title: Compile Vitest Runs with unplugin-swc
impact: HIGH
impactDescription: Keeps decorator metadata in tests identical to the SWC build, whatever Vite version resolves
tags: vitest, unplugin-swc, swc, e2e, supertest, decorator-metadata, env
---

## Compile Vitest Runs with unplugin-swc

Vitest compiles TypeScript with Vite's transformer, not with Nest's SWC builder, and `nest new` scaffolds no SWC plugin. Vitest 5 accepts Vite `^6.4.0 || ^7.0.0 || ^8.0.0`: Vite 8 (Oxc) emits decorator metadata, Vite 6/7 (esbuild) do not, and then DI and TypeORM fail with `Nest could not find DownstreamClient element (this provider does not exist in the current context)` and `ColumnTypeUndefinedError: Column type for Product#sku is not defined and cannot be guessed` (verified with Vite 7.3.7). `unplugin-swc` makes tests compile with SWC, the same compiler as `nest build`, whichever Vite resolves. `module: { type: 'es6' }` keeps a CommonJS `.swcrc` from leaking into the ESM test run. Supertest is a CommonJS function export: `import * as request` fails with `TS2349: This expression is not callable.` and at runtime with `TypeError: (0 , __vite_ssr_import_1__) is not a function`.

Install: `pnpm add -D vitest unplugin-swc @swc/core supertest @types/supertest`. Keep one config: `vitest run -t '<name>'` (how `nestjs-fdd` runs a single feature) reads only `vitest.config.ts`, so with a separate `vitest.config.e2e.ts` and `test:e2e` script a filter that matches only an e2e suite runs nothing and the e2e feature is silently skipped. `pnpm test` runs both kinds; the probe ran unit specs and e2e suites in one `vitest run`. The scripts (`test`, `test:watch`, `typecheck`) are in `esm-project-config`; `globals: true` pairs with `"types": ["vitest/globals", "node"]` there.

Test-only settings go into the one `test.env` object, which Vitest applies before any test file imports the app. This is the only complete Vitest config across the skills: every other installed skill names the keys it adds, and each key is added next to the ones already there, never in a second `defineConfig()`. The example shows the merged shape for a project that uses `nestjs-typeorm` (`DB_PATH`), `nestjs-logging` (`NEST_LOG_LEVEL`) and `nestjs-schedule`, which adds one `<JOB>_POLL_MS` key per env-driven job; `BATCH_POLL_MS` is the key of its batch job, and a second env-driven job adds its own key next to it.

**Incorrect (Vite's transformer decides whether metadata exists):**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { globals: true, include: ['**/*.spec.ts'] },
});
```

**Correct (one `vitest.config.ts` for unit specs and e2e suites):**

```typescript
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    // One config: `vitest run -t '<name>'` reaches unit specs and e2e suites alike.
    include: ['src/**/*.spec.ts', 'test/**/*.e2e-spec.ts'],
    // Test-only settings. Installed skills add keys here; keep every key that is already present.
    env: {
      GREETING: 'Hello World!',
      DB_PATH: ':memory:', // nestjs-typeorm, orm-single-data-source
      NEST_LOG_LEVEL: process.env.NEST_LOG_LEVEL || 'fatal', // nestjs-logging, test-quiet-and-capture
      BATCH_POLL_MS: '3600000', // nestjs-schedule, test-call-the-work: one <JOB>_POLL_MS per env-driven job
    },
  },
  // SWC compiles the tests exactly like `nest build` does, decorator metadata included.
  // `module: es6` keeps a CommonJS `.swcrc` from leaking into the ESM test run.
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
```

**Correct (`test/app.e2e-spec.ts` smoke test proving the setup):**

```typescript
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp } from './support/test-app.js';

describe('App (e2e)', () => {
  let app: NestExpressApplication;

  beforeEach(async () => {
    app = await createTestApp();
    return () => app.close();
  });

  it('GET /api', () => request(app.getHttpServer()).get('/api').expect(200).expect('Hello World!'));
});
```

`createTestApp()` (boots `AppModule`, applies `configureApp`, `await app.init()`) and the app-per-test lifecycle are in `nestjs-testing` `e2e-real-app-module`.

How to write unit and e2e tests (auto-mocking, overrides, database in tests) lives in `nestjs-testing`.

Reference: [NestJS SWC recipe – Vitest](https://docs.nestjs.com/recipes/swc)
