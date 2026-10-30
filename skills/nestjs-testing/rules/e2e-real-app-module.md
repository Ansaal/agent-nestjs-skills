---
title: Run E2E Tests Against the Real AppModule Over HTTP
impact: CRITICAL
impactDescription: Green e2e suites that never exercise the real module graph, routes or migrations, or that pass only in one test order
tags: testing, e2e, supertest, overrideProvider, AppModule, isolation
---

## Run E2E Tests Against the Real AppModule Over HTTP

An e2e test shows that the app works once it is wired together: module imports, global enhancers, routes, serialization and migrations. Put each suite in `test/<feature>.e2e-spec.ts` and import the real `AppModule`. Use `overrideProvider()` only for providers that leave the process, such as outbound HTTP clients, message brokers and mailers. In-process providers stay real, and so does the database: every app instance gets a fresh migrated SQLite `:memory:` database (that setup is in `nestjs-typeorm`). `createNestApplication()` does not initialize the app; `await app.init()` runs before the first request, and `app.close()` closes the connection and runs the lifecycle hooks. In ESM, Supertest is a default import. `import * as request from 'supertest'` fails at the first call with `TypeError: (0 , __vite_ssr_import_0__) is not a function`.

Every suite boots through one helper, `createTestApp()`, so no suite forgets `init()` or the settings `main.ts` applies. Other skills extend it through its two parameters instead of building their own app: `override` receives the `TestingModuleBuilder` (provider overrides such as an HTTP client double or parked timers), and `options.logger` replaces Nest's logger (a capturing logger from `nestjs-logging`, or `false`).

Each test gets its own app. A database that is fresh per app is not fresh per test when the app is created in `beforeAll`: in the probe, a suite of 30 tests that each create product `p-1` passed the first test and failed the other 29 with `expected 201 "Created", got 409 "Conflict"`. With the app created in `beforeEach`, all 30 passed. The cost is one boot per test: with 12 migrations and 500 seeded rows, `createTestApp()` plus `close()` took 5.3 ms (median of 30), and the 30-test suite ran in 894 ms against 703 ms for one shared app. A deterministic reset (delete every entity table inside `TransactionRunner.run()` before each test) ran it in 648 ms, but it has to know every table, has to re-seed what migrations inserted, and leaves provider state alive: circuit breakers, dispatcher queues and caches carry over between tests. Use the app per test; switch a suite to a reset only when its boot measurably dominates, and then reset that state too.

**Incorrect (hand-assembled module, mocked internals, namespace import, no lifecycle):**

```typescript
import * as request from 'supertest';

const moduleRef = await Test.createTestingModule({
  controllers: [ProductsController],
  providers: [
    { provide: getRepositoryToken(Product), useValue: { save: vi.fn() } },
    { provide: SyncDispatcher, useValue: { dispatch: vi.fn() } },
  ],
}).compile();
const app = moduleRef.createNestApplication(); // no init(), never closed
```

**Incorrect (one app, and one database, for the whole suite):**

```typescript
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(() => app.close());
// the second test that creates p-1 gets 409: the first test's row is still there
```

**Correct (`test/support/test-app.ts`, one boot path for every suite):**

```typescript
import type { LoggerService } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/configure-app.js';

export interface TestAppOptions {
  /** App logger, e.g. a capturing logger (nestjs-logging); `false` silences Nest's output. */
  logger?: LoggerService | false;
}

/** Boots the real AppModule with main.ts's app settings. `override` replaces outbound boundaries only. */
export async function createTestApp(
  override: (builder: TestingModuleBuilder) => TestingModuleBuilder = (builder) => builder,
  options: TestAppOptions = {},
): Promise<NestExpressApplication> {
  const moduleRef = await override(Test.createTestingModule({ imports: [AppModule] })).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>(
    options.logger === undefined ? {} : { logger: options.logger },
  );
  try {
    configureApp(app);
    await app.init();
  } catch (error) {
    // No teardown is registered for an app that never returned: close what init() opened, report the boot error.
    await app.close().catch(() => undefined);
    throw error;
  }
  return app;
}
```

**Correct (real `AppModule`, outbound client overridden, one app per test):**

```typescript
// test/products.e2e-spec.ts
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DownstreamClient } from '../src/sync/downstream.client.js';
import { createTestApp } from './support/test-app.js';

describe('Products (e2e)', () => {
  const downstream = { push: vi.fn((id: string) => Promise.resolve(`ok:${id}`)) };
  let app: NestExpressApplication;

  // A fresh app per test: its own migrated :memory: database and fresh provider state.
  beforeEach(async () => {
    app = await createTestApp((builder) => builder.overrideProvider(DownstreamClient).useValue(downstream));
    return () => app.close();
  });

  it('POST /api/products stores the product', async () => {
    const res = await request(app.getHttpServer()).post('/api/products').send({ sku: 'p-1' }).expect(201);

    expect(res.body).toMatchObject({ sku: 'p-1', version: 1 });
  });

  it('POST /api/products answers 409 for a duplicate sku', async () => {
    await request(app.getHttpServer()).post('/api/products').send({ sku: 'p-1' }).expect(201);
    await request(app.getHttpServer()).post('/api/products').send({ sku: 'p-1' }).expect(409);
  });

  it('POST /api/products rejects an invalid body', async () => {
    await request(app.getHttpServer()).post('/api/products').send({ sku: 42 }).expect(400);
  });
});
```

The function `beforeEach` returns is Vitest's teardown for that test. It is registered only once the app exists: when a provider factory threw during boot, the returned-teardown suite reported only `Error: boot failed`, while a separate `afterEach(() => app.close())` added `TypeError: Cannot read properties of undefined (reading 'close')`. A boot that fails after the app is created is therefore closed inside `createTestApp()`: with a provider whose `onModuleInit` started an interval and then threw, the test still saw the original `boot failed in onModuleInit`, and the provider's `onModuleDestroy` ran and the `DataSource` was closed; without the `catch`, neither happened. The 400 comes from the `ValidationPipe` that `AppModule` registers; `configureApp()` applies the global prefix that `main.ts` also uses (`e2e-global-enhancers-as-providers`). The 409 comes from the unique-constraint mapping in `nestjs-typeorm` (`orm-unique-violation`). With `{ logger: capture }`, the capturing logger received `Nest application successfully started` from `init()`.

For an HTTP dependency, `DownstreamClient` is the system's client provider that wraps a `@nestjs/http-client` client; how to register it, and how to test the client itself against a stubbed transport, is in `nestjs-http-client` (`test-override-client-provider`, `test-mock-agent-dispatcher`).

Reference: [NestJS – Testing: End-to-end testing](https://docs.nestjs.com/fundamentals/testing#end-to-end-testing), [Vitest – beforeEach](https://vitest.dev/api/#beforeeach)
