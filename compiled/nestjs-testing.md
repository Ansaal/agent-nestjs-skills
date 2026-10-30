# NestJS Testing

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

Testing NestJS apps with Vitest and `@nestjs/testing`. Use when writing unit tests for a provider or controller, e2e tests over HTTP with Supertest (`createTestApp()`, `configureApp()`, per-test database isolation), tests for work that finishes after the response, or tests that exercise existing retry/backoff behaviour on fake timers. To design or configure the retry policy itself, load `nestjs-resilience`.

---

## Table of Contents

1. [Unit Tests](#1-unit-tests) — **HIGH**
   - 1.1 [Test One Provider With Every Dependency Auto-Mocked](#11-test-one-provider-with-every-dependency-auto-mocked)
   - 1.2 [Resolve Scoped Providers and Override REQUEST](#12-resolve-scoped-providers-and-override-request)
   - 1.3 [Match the Token for Specific Doubles, Delegate the Rest to autoMock](#13-match-the-token-for-specific-doubles-delegate-the-rest-to-automock)
2. [E2E Tests](#2-e2e-tests) — **CRITICAL**
   - 2.1 [Register Global Enhancers as APP_* Providers](#21-register-global-enhancers-as-app-providers)
   - 2.2 [Run E2E Tests Against the Real AppModule Over HTTP](#22-run-e2e-tests-against-the-real-appmodule-over-http)
3. [Time and Async Work](#3-time-and-async-work) — **MEDIUM-HIGH**
   - 3.1 [Await Fire-and-Forget Work Through drain()](#31-await-fire-and-forget-work-through-drain-)
   - 3.2 [Drive Retry Backoff With Fake Timers](#32-drive-retry-backoff-with-fake-timers)

---

## 1. Unit Tests

**Section Impact: HIGH**

### 1.1 Test One Provider With Every Dependency Auto-Mocked

**Impact: HIGH** — Unit tests that break on every constructor change or quietly run real collaborators

A unit test compiles a testing module that holds only the unit, one provider or controller, and lets `useMocker()` build every constructor dependency. When you list real collaborators, the test runs their code and needs their dependencies too. When you hand-write a `{ provide, useValue }` for each dependency, the test breaks on every constructor change. `@nestjs/testing` 12 has no ready-made mock factory, only the `MockFactory` type. The project keeps one factory in `test/auto-mock.ts` and uses no third-party mock library. `moduleRef.get(Dep)` returns the same mock the unit received, and `vi.mocked()` types it so `.mockResolvedValue` and the matchers type-check. If the factory returns `undefined` for a token, `compile()` fails with the same error you get when a provider is missing: `Nest can't resolve dependencies of the SyncService (?, DownstreamClient). Please make sure that the argument ResilienceService at index [0] is available in the RootTestModule module.`

**Incorrect (real collaborators and hand-listed fakes):**

```typescript
const moduleRef = await Test.createTestingModule({
  providers: [
    SyncDispatcher,
    SyncService, // real: now needs ResilienceService and DownstreamClient too
    { provide: DownstreamClient, useValue: { push: vi.fn() } as any },
  ],
}).compile();
```

**Correct (`test/auto-mock.ts` once, `useMocker(autoMock)` in every unit test):**

```typescript
// test/auto-mock.ts
import type { InjectionToken } from '@nestjs/common';
import { vi } from 'vitest';

/** Mock factory for `useMocker()`: every method on a class token's prototype chain becomes `vi.fn()`. */
export function autoMock(token?: InjectionToken): Record<string, unknown> {
  const mock: Record<string, unknown> = {};
  if (typeof token !== 'function') return mock;
  let proto: unknown = token.prototype;
  while (typeof proto === 'object' && proto !== null && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key !== 'constructor' && !(key in mock)) mock[key] = vi.fn();
    }
    proto = Object.getPrototypeOf(proto);
  }
  return mock;
}
```

```typescript
// src/sync/sync.dispatcher.spec.ts
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { autoMock } from '../../test/auto-mock.js';
import { SyncService } from './sync.service.js';
import { SyncDispatcher } from './sync.dispatcher.js';

describe('SyncDispatcher', () => {
  let moduleRef: TestingModule;

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({ providers: [SyncDispatcher] })
      .useMocker(autoMock)
      .compile();
  });

  it('runs the sync for a dispatched id', async () => {
    const sync = vi.mocked(moduleRef.get(SyncService));
    sync.sync.mockResolvedValue('ok:p-1');

    const dispatcher = moduleRef.get(SyncDispatcher);
    dispatcher.dispatch('p-1');
    await dispatcher.drain();

    expect(sync.sync).toHaveBeenCalledWith('p-1');
  });

  it('settles drain() when the sync itself rejects', async () => {
    vi.mocked(moduleRef.get(SyncService)).sync.mockRejectedValue(new Error('dead-letter store down'));

    const dispatcher = moduleRef.get(SyncDispatcher);
    dispatcher.dispatch('p-1');

    await expect(dispatcher.drain()).resolves.toBeUndefined();
  });
});
```

`autoMock` mocks the methods of class tokens. String and symbol tokens, and methods whose return value the unit calls further, need a specific double (`unit-specific-doubles`). Unit specs sit next to their source as `*.spec.ts`. `token.prototype` is `any`; walking it as `unknown` with a type guard keeps `autoMock` clean under `recommendedTypeChecked`, where a `let proto = token.prototype` loop failed `pnpm lint` with ``Unsafe assignment of an `any` value  @typescript-eslint/no-unsafe-assignment``. The `expect(sync.sync)` matchers rely on `unbound-method` being off for test files (`nestjs-setup`, `lint-type-aware-flat-config`).

Reference: [NestJS – Testing: Auto mocking](https://docs.nestjs.com/fundamentals/testing#auto-mocking)

---

### 1.2 Resolve Scoped Providers and Override REQUEST

**Impact: MEDIUM-HIGH** — get() throws for scoped providers; an auto-mocked REQUEST is silently undefined

`moduleRef.get()` only returns static instances. For a request- or transient-scoped provider it throws: `TenantContext is marked as a scoped provider. Request and transient-scoped providers can't be used in combination with "get()" method. Please, use "resolve()" instead.` The scope moves up the injection chain, so a default-scoped class that injects `TenantContext` throws the same error. Use `await moduleRef.resolve(Unit)`. Each call builds a new DI sub-tree, so two calls return two different instances. To get the same instance twice, pass one `ContextIdFactory.create()` to both calls. `REQUEST` and `INQUIRER` are already defined in the context, so `useMocker()` never receives them. The provider gets `undefined` and fails at first use: `Cannot read properties of undefined (reading 'header')`. Supply them with `overrideProvider()`.

**Incorrect (`get()` on a scoped provider, REQUEST left to the mocker):**

```typescript
const moduleRef = await Test.createTestingModule({ providers: [TenantContext] })
  .useMocker(autoMock)
  .compile();
const context = moduleRef.get(TenantContext); // throws: scoped provider, use resolve()
```

**Correct (REQUEST overridden, unit resolved):**

```typescript
import { REQUEST } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { expect, it } from 'vitest';
import { autoMock } from '../../test/auto-mock.js';
import { TenantContext } from './tenant-context.js';

it('reads the tenant from the request header', async () => {
  const moduleRef = await Test.createTestingModule({ providers: [TenantContext] })
    .overrideProvider(REQUEST)
    .useValue({ header: (name: string) => (name === 'x-tenant-id' ? 'acme' : undefined) })
    .useMocker(autoMock)
    .compile();

  const context = await moduleRef.resolve(TenantContext);

  expect(context.tenantId).toBe('acme');
});
```

`TenantContext` is `@Injectable({ scope: Scope.REQUEST })` with `@Inject(REQUEST) request: Request`. The double implements only the members the unit reads.

Reference: [NestJS – Testing: Testing request-scoped instances](https://docs.nestjs.com/fundamentals/testing#testing-request-scoped-instances)

---

### 1.3 Match the Token for Specific Doubles, Delegate the Rest to autoMock

**Impact: HIGH** — TypeError from empty mocks, or failures swallowed into a passing-looking undefined

`autoMock` has two gaps. First, it returns `{}` for string and symbol tokens. `@InjectRepository(Product)` is the string token `'ProductRepository'`, so the controller fails with `TypeError: this.products.findOneBy is not a function`. Second, every mocked method returns `undefined`. If the unit chains on a return value, such as `this.resilience.preset('downstream').execute(fn)`, the call throws. When the unit's own `catch` turns that error into a dead letter, the test gets `undefined` back and no error at all. For these tokens, write a factory that compares the token, returns the specific double, and passes every other token to `autoMock(token)`. A new constructor parameter then still gets mocked.

**Incorrect (matches one token and returns `undefined` for the rest):**

```typescript
const moduleRef = await Test.createTestingModule({ controllers: [ProductsController] })
  .useMocker((token) => {
    if (token === getRepositoryToken(Product)) return products;
  }) // Nest can't resolve dependencies of the ProductsController (ProductRepository, ?, SyncDispatcher)
  .compile();
```

**Correct (specific double for the repository token, `autoMock` for everything else):**

```typescript
// src/catalog/products.controller.spec.ts
import { NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { autoMock } from '../../test/auto-mock.js';
import { SyncDispatcher } from '../sync/sync.dispatcher.js';
import { Product } from './product.entity.js';
import { ProductsController } from './products.controller.js';

describe('ProductsController', () => {
  const products = { findOneBy: vi.fn<(where: Partial<Product>) => Promise<Partial<Product> | null>>() };
  let moduleRef: TestingModule;

  beforeEach(async () => {
    products.findOneBy.mockReset();
    moduleRef = await Test.createTestingModule({ controllers: [ProductsController] })
      .useMocker((token) => (token === getRepositoryToken(Product) ? products : autoMock(token)))
      .compile();
  });

  it('returns the stored product', async () => {
    products.findOneBy.mockResolvedValue({ sku: 'p-1', version: 3 });

    await expect(moduleRef.get(ProductsController).findOne('p-1')).resolves.toEqual({ sku: 'p-1', version: 3 });
    expect(products.findOneBy).toHaveBeenCalledWith({ sku: 'p-1' });
  });

  it('answers 404 for an unknown sku', async () => {
    products.findOneBy.mockResolvedValue(null);

    await expect(moduleRef.get(ProductsController).findOne('p-9')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('hands the sync to the dispatcher', () => {
    moduleRef.get(ProductsController).sync('p-1');

    expect(vi.mocked(moduleRef.get(SyncDispatcher)).dispatch).toHaveBeenCalledWith('p-1');
  });
});
```

The controller reads through `@InjectRepository(Product)`, creates through `ProductService` (auto-mocked here), and dispatches through `SyncDispatcher`. Writes stay out of controllers and repositories: they go through `TransactionRunner` in a service (`nestjs-typeorm`, `orm-atomic-writes`), which the e2e suite covers. Keep the double in a local `const` so the test uses it with its real type, with no `moduleRef.get<…>(stringToken)` cast. Use the same pattern for a pass-through policy, so a service unit test runs the wrapped call directly:

```typescript
.useMocker((token) =>
  token === ResilienceService ? { preset: () => ({ execute: (fn: () => unknown) => fn() }) } : autoMock(token),
)
```

Reference: [NestJS – Testing: Auto mocking](https://docs.nestjs.com/fundamentals/testing#auto-mocking)

---

## 2. E2E Tests

**Section Impact: CRITICAL**

### 2.1 Register Global Enhancers as APP_* Providers

**Impact: CRITICAL** — E2E tests run without the production validation, error mapping and guards

`createNestApplication()` builds the app from the module graph, and `main.ts` never runs in a test. A pipe, filter, interceptor or guard registered with `app.useGlobal*()` in `main.ts` is missing from every e2e app. In the probe, with `ValidationPipe` only in `main.ts`, `POST /api/products { sku: 42 }` returned 201 and stored the number. With `APP_PIPE` it returned 400. Copying `app.useGlobalPipes(...)` into each suite tests the copy, which drifts from `main.ts`. Register global enhancers as `APP_PIPE` / `APP_FILTER` / `APP_INTERCEPTOR` / `APP_GUARD` providers in `AppModule`. In that form they can also inject dependencies.

App settings that have no provider form and that production and tests share, such as `setGlobalPrefix`, `enableCors`, `enableVersioning` and `useStaticAssets`, go into one exported `configureApp(app)`. `main.ts` and `createTestApp()` (`e2e-real-app-module`) call it. Two things stay out of it. `enableShutdownHooks()` belongs to `main.ts` only: a test closes its app with `app.close()`, which runs the same lifecycle hooks, and each open app with shutdown hooks holds its own `SIGTERM` listener (3 open apps, 3 listeners; `close()` removed them). And Express's 100 kb JSON limit stays unless the application needs more.

**Incorrect (enhancers bound in `main.ts`, re-typed in tests):**

```typescript
// src/main.ts
const app = await NestFactory.create(AppModule);
app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
app.useGlobalFilters(new HttpErrorFilter());
app.setGlobalPrefix('api');
await app.listen(3000);

// test/products.e2e-spec.ts
app = moduleRef.createNestApplication();
app.useGlobalPipes(new ValidationPipe()); // a second, already different copy; no filter, no prefix
```

**Correct (enhancers in the module graph, shared settings in `configureApp`):**

```typescript
// src/app.module.ts
import { Module, ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';

@Module({
  imports: [/* TypeOrmModule, DatabaseModule, ResilienceModule, CatalogModule, … */],
  providers: [{ provide: APP_PIPE, useValue: new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }) }],
})
export class AppModule {}
```

```typescript
// src/configure-app.ts
import type { NestExpressApplication } from '@nestjs/platform-express';

/** Settings with no provider form that production and tests share; main.ts and createTestApp() call this. */
export function configureApp(app: NestExpressApplication): NestExpressApplication {
  return app.setGlobalPrefix('api');
}
```

```typescript
// src/main.ts (excerpt; the full file is nestjs-setup, esm-imports-and-paths)
const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger });
configureApp(app);
app.enableShutdownHooks(); // production only
await app.listen(process.env.PORT ?? 3000);
```

`configureApp` takes `NestExpressApplication` (from `@nestjs/platform-express`), not `INestApplication`, so Express-only settings such as `useBodyParser` and `useStaticAssets` type-check in it. Create the app as `NestFactory.create<NestExpressApplication>()` and `createNestApplication<NestExpressApplication>()` so both call sites type-check. A larger body limit is an application decision, recorded with its reason where it is made:

```typescript
// Application decision: the bulk import endpoint takes up to 2 MB (PLAN D9).
app.useBodyParser('json', { limit: '2mb' });
```

Inside `configureApp`, before `init()`, no `bodyParser: false` is needed: in the probe a 1.2 MB JSON body returned 201 with that line and 413 without it. Called after `init()`, the same line had no effect (413).

To replace a global enhancer in a suite, such as an auth guard, register it as `{ provide: APP_GUARD, useExisting: ApiKeyGuard }` plus `ApiKeyGuard` as a plain provider. Then `createTestApp((builder) => builder.overrideProvider(ApiKeyGuard).useValue({ canActivate: () => true }))` replaces it. With `useClass`, the test has no token to override: in the probe the same override let a denying guard through with `useExisting` (200) and not with `useClass` (403).

Reference: [NestJS – Pipes: Global scoped pipes](https://docs.nestjs.com/pipes#global-scoped-pipes), [NestJS – Testing: Overriding globally registered enhancers](https://docs.nestjs.com/fundamentals/testing#overriding-globally-registered-enhancers)

---

### 2.2 Run E2E Tests Against the Real AppModule Over HTTP

**Impact: CRITICAL** — Green e2e suites that never exercise the real module graph, routes or migrations, or that pass only in one test order

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

---

## 3. Time and Async Work

**Section Impact: MEDIUM-HIGH**

### 3.1 Await Fire-and-Forget Work Through drain()

**Impact: MEDIUM-HIGH** — Assertions that run before the side effect, or sleeps that guess its duration

When a handler answers 202 and runs the downstream call after the response, Supertest resolves before that work finishes. An assertion right after the request fails, and a sleep can only guess how long the work takes. Give the component that starts the work an awaitable. The dispatcher keeps each in-flight promise in a set and exposes `drain()`, which resolves when every promise has settled. The test awaits `drain()` after the response, so it waits exactly as long as the work takes. When the work retries, combine `drain()` with fake timers: start `drain()`, advance the clock, then await it (`async-fake-timers`). When to answer before the downstream call, and how a failed call becomes a dead letter, is `nestjs-resilience`.

**Incorrect (sleeping until the side effect has probably happened):**

```typescript
await request(app.getHttpServer()).post('/api/products/p-1/sync').expect(202);
await new Promise((resolve) => setTimeout(resolve, 500));
expect(downstream.push).toHaveBeenCalledWith('p-1');
```

**Correct (the dispatcher tracks its work; the test awaits `drain()`):**

```typescript
// src/sync/sync.dispatcher.ts
import { Injectable, Logger } from '@nestjs/common';
import { SyncService } from './sync.service.js';

@Injectable()
export class SyncDispatcher {
  private readonly logger = new Logger(SyncDispatcher.name);
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly sync: SyncService) {}

  /** Fire-and-forget: the HTTP response does not wait for the sync. */
  dispatch(id: string): void {
    const job = this.sync
      .sync(id)
      .catch((error: unknown) => {
        // sync() dead-letters final failures; this catches the dead-letter write failing too.
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger.error('Product sync lost, dead letter not recorded', { productId: id }, err);
      })
      .finally(() => this.pending.delete(job));
    this.pending.add(job);
  }

  /** Resolves once every dispatched sync has settled (tests, graceful shutdown). */
  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }
}
```

```typescript
// test/sync-dispatch.e2e-spec.ts
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { DownstreamClient } from '../src/sync/downstream.client.js';
import { SyncDispatcher } from '../src/sync/sync.dispatcher.js';
import { createTestApp } from './support/test-app.js';

const downstream = { push: vi.fn((id: string) => Promise.resolve(`ok:${id}`)) };
let app: NestExpressApplication;

beforeEach(async () => {
  downstream.push.mockClear();
  app = await createTestApp((builder) => builder.overrideProvider(DownstreamClient).useValue(downstream));
  return () => app.close();
});

it('POST /api/products/:sku/sync pushes after the 202', async () => {
  await request(app.getHttpServer()).post('/api/products/p-1/sync').expect(202);

  await app.get(SyncDispatcher).drain();

  expect(downstream.push).toHaveBeenCalledWith('p-1');
});

it('drain() combines with fake timers when the side effect retries', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  downstream.push.mockRejectedValueOnce(Object.assign(new Error('unavailable'), { status: 503 }));

  await request(app.getHttpServer()).post('/api/products/p-2/sync').expect(202);
  const drained = app.get(SyncDispatcher).drain();
  await vi.advanceTimersByTimeAsync(60_000);
  await drained;
  vi.useRealTimers();

  expect(downstream.push).toHaveBeenCalledTimes(2);
});
```

The `while` loop also waits for work that is dispatched while `drain()` is already running. `sync()` records final failures as dead letters, but that write can fail too (`nestjs-resilience`, `dlq-record-final-failure`), so every dispatched promise ends in the `.catch`. Tests that call `drain()` do not reveal a missing `.catch`, because `Promise.allSettled` handles the rejection: without it, a spec that dispatched and drained passed cleanly, and one that dispatched without draining, like production, ended with Vitest's `Unhandled Rejection` error; in the app, `main.ts`'s handler would log it as fatal and exit. With the `.catch`, both specs passed. The log follows `nestjs-logging`: a fixed message, fields, the `Error` as the third argument, at `error` because the work is lost.

Reference: [NestJS – Testing: End-to-end testing](https://docs.nestjs.com/fundamentals/testing#end-to-end-testing)

---

### 3.2 Drive Retry Backoff With Fake Timers

**Impact: MEDIUM-HIGH** — Seconds of real waiting per test, and flaky results from random jitter

Retry code waits between attempts. In the probe, a call that failed twice under the production preset (`attempts: 3`, `backoff: { delay: '1s' }`, full jitter by default) took 430 to 711 ms of real time across three runs, a different figure every run. On fake timers the same call took 1.3 ms. Boot the app first, then call `vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })` in `beforeEach`. `@nestjs/resilience` 0.0.3 waits through the global `setTimeout`, and its circuit breakers and rate limits read `Date.now()`. Start the call without awaiting it, then `await vi.advanceTimersByTimeAsync(ms)` past the full backoff budget, then await the result. The async variant lets each failed attempt settle before the next timer fires. `vi.waitFor` does not speed up fake time. Under fake timers it moves the clock forward by `interval` (50 ms) once per real `interval`. With its 1 s default timeout it saw 2 of the 3 attempts and failed. Use it only to poll for work that finishes quickly in real time.

This tests retry behaviour the application already has. Which errors retry, how often and with which backoff is designed in `nestjs-resilience`.

**Incorrect (real backoff, or a sleep that guesses it):**

```typescript
it('retries a transient failure', async () => {
  downstream.push.mockRejectedValueOnce(unavailable()).mockResolvedValue('ok:p-1');
  const result = app.get(SyncService).sync('p-1');
  await new Promise((resolve) => setTimeout(resolve, 3_000)); // jitter makes this flaky, and it's slow
  expect(await result).toBe('ok:p-1');
}, 10_000);
```

**Correct (production preset, fake clock advanced past the backoff):**

```typescript
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DownstreamClient } from '../src/sync/downstream.client.js';
import { SyncService } from '../src/sync/sync.service.js';
import { createTestApp } from './support/test-app.js';

const unavailable = () => Object.assign(new Error('unavailable'), { status: 503 });
const downstream = { push: vi.fn<(id: string) => Promise<string>>() };
let app: NestExpressApplication;

beforeEach(async () => {
  downstream.push.mockReset();
  app = await createTestApp((builder) => builder.overrideProvider(DownstreamClient).useValue(downstream));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  return () => app.close();
});
afterEach(() => vi.useRealTimers());

it('retries transient failures with the production backoff', async () => {
  downstream.push.mockRejectedValueOnce(unavailable()).mockRejectedValueOnce(unavailable()).mockResolvedValue('ok:p-1');

  const result = app.get(SyncService).sync('p-1');
  await vi.advanceTimersByTimeAsync(60_000);

  await expect(result).resolves.toBe('ok:p-1');
  expect(downstream.push).toHaveBeenCalledTimes(3);
});

it('dead-letters after the last attempt', async () => {
  downstream.push.mockRejectedValue(unavailable());
  const sync = app.get(SyncService);

  const result = sync.sync('p-2');
  await vi.advanceTimersByTimeAsync(60_000);

  await expect(result).resolves.toBeUndefined();
  expect(sync.deadLetters).toContainEqual(expect.objectContaining({ id: 'p-2' }));
});
```

The app per test (`e2e-real-app-module`) also gives each test fresh circuit-breaker state, so a test that opens the breaker cannot fail the next one.

**Correct (alternative when the test is about something other than the retry timing: zero backoff):**

```typescript
import { RESILIENCE_MODULE_OPTIONS, type ResilienceModuleOptions } from '@nestjs/resilience';

app = await createTestApp((builder) =>
  builder
    .overrideProvider(DownstreamClient)
    .useValue(downstream)
    .overrideProvider(RESILIENCE_MODULE_OPTIONS)
    .useValue({
      presets: { downstream: { retry: { attempts: 3, backoff: { delay: 0 } } } },
    } satisfies ResilienceModuleOptions),
);
```

This works with `@nestjs/resilience` 0.0.3 and real timers: a call that failed twice and succeeded on the third attempt finished in 5.1 ms. `useValue` replaces the whole options object, including every preset and `defaults`, so the test no longer checks the production policy. Prefer fake timers whenever the attempt count, backoff or breaker behaviour is what you are testing.

Reference: [Vitest – vi.useFakeTimers](https://vitest.dev/api/vi#vi-usefaketimers), [Vitest – vi.advanceTimersByTimeAsync](https://vitest.dev/api/vi#vi-advancetimersbytimeasync)

---

## References

- https://docs.nestjs.com
- https://github.com/nestjs/nest
- https://typeorm.io
- https://github.com/typestack/class-validator
- https://github.com/goldbergyoni/nodebestpractices

---

*Generated by build-agents.ts on 2026-10-30*
