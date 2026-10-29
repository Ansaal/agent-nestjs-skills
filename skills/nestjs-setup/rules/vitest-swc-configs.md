---
title: Compile Vitest Runs with unplugin-swc
impact: HIGH
impactDescription: Keeps decorator metadata in tests identical to the SWC build, whatever Vite version resolves
tags: vitest, unplugin-swc, swc, e2e, supertest, decorator-metadata
---

## Compile Vitest Runs with unplugin-swc

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
