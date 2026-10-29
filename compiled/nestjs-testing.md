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

Testing NestJS apps with Vitest and `@nestjs/testing`. Use when writing unit tests for a provider or controller, e2e tests over HTTP with Supertest, or tests for retries, backoff and work that finishes after the response.

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
  for (let proto = token.prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key !== 'constructor' && !(key in mock)) mock[key] = vi.fn();
    }
  }
  return mock;
}
```

```typescript
// src/products/sync.dispatcher.spec.ts
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { autoMock } from '../../test/auto-mock.js';
import { SyncService } from '../sync.service.js';
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
});
```

`autoMock` mocks the methods of class tokens. String and symbol tokens, and methods whose return value the unit calls further, need a specific double (`unit-specific-doubles`). Unit specs sit next to their source as `*.spec.ts`.

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

`autoMock` has two gaps. First, it returns `{}` for string and symbol tokens. `@InjectRepository(Product)` is the string token `'ProductRepository'`, so the controller fails with `TypeError: this.products.create is not a function`. Second, every mocked method returns `undefined`. If the unit chains on a return value, such as `this.resilience.preset('downstream').execute(fn)`, the call throws. When the unit's own `catch` turns that error into a dead letter, the test gets `undefined` back and no error at all. For these tokens, write a factory that compares the token, returns the specific double, and passes every other token to `autoMock(token)`. A new constructor parameter then still gets mocked.

**Incorrect (matches one token and returns `undefined` for the rest):**

```typescript
const moduleRef = await Test.createTestingModule({ controllers: [ProductsController] })
  .useMocker((token) => {
    if (token === getRepositoryToken(Product)) return products;
  }) // Nest can't resolve dependencies of the ProductsController (ProductRepository, ?)
  .compile();
```

**Correct (specific double for the repository token, `autoMock` for everything else):**

```typescript
import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { autoMock } from '../../test/auto-mock.js';
import { Product } from '../product.entity.js';
import { SyncDispatcher } from './sync.dispatcher.js';
import { ProductsController } from './products.controller.js';

describe('ProductsController', () => {
  const products = {
    create: vi.fn((data: Partial<Product>) => data),
    save: vi.fn(async (data: Partial<Product>) => ({ id: 'id-1', ...data })),
  };
  let moduleRef: TestingModule;

  beforeEach(async () => {
    vi.clearAllMocks();
    moduleRef = await Test.createTestingModule({ controllers: [ProductsController] })
      .useMocker((token) => (token === getRepositoryToken(Product) ? products : autoMock(token)))
      .compile();
  });

  it('saves a new product at version 1', async () => {
    const created = await moduleRef.get(ProductsController).create({ sku: 'p-1' });

    expect(created).toEqual({ id: 'id-1', sku: 'p-1', version: 1 });
    expect(products.save).toHaveBeenCalledOnce();
  });

  it('hands the sync to the dispatcher', () => {
    moduleRef.get(ProductsController).sync('p-1');

    expect(vi.mocked(moduleRef.get(SyncDispatcher)).dispatch).toHaveBeenCalledWith('p-1');
  });
});
```

Keep the double in a local `const` so the test uses it with its real type, with no `moduleRef.get<…>(stringToken)` cast. Use the same pattern for a pass-through policy, so a service unit test runs the wrapped call directly:

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

`createNestApplication()` builds the app from the module graph, and `main.ts` never runs in a test. A pipe, filter, interceptor or guard registered with `app.useGlobal*()` in `main.ts` is missing from every e2e app. In the probe, with `ValidationPipe` only in `main.ts`, `POST /products { sku: 42 }` returned 201 and stored the number. With `APP_PIPE` it returned 400. Copying `app.useGlobalPipes(...)` into each suite tests the copy, which drifts from `main.ts`. Register global enhancers as `APP_PIPE` / `APP_FILTER` / `APP_INTERCEPTOR` / `APP_GUARD` providers in `AppModule`. In that form they can also inject dependencies. App settings that have no provider form, such as `setGlobalPrefix`, `enableCors`, `enableVersioning` and `enableShutdownHooks`, go into one exported `configureApp(app)`. `main.ts` and every e2e suite call it.

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

**Correct (enhancers in the module graph, the rest in `configureApp`):**

```typescript
// src/app.module.ts
import { Module, ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';

@Module({
  imports: [/* TypeOrmModule, ResilienceModule, … */],
  controllers: [ProductsController],
  providers: [
    { provide: APP_PIPE, useValue: new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }) },
    SyncService,
    DownstreamClient,
    SyncDispatcher,
  ],
})
export class AppModule {}
```

```typescript
// src/configure-app.ts
import type { INestApplication } from '@nestjs/common';

/** App-level settings that have no provider form; main.ts and every e2e suite call this. */
export function configureApp(app: INestApplication): INestApplication {
  return app.setGlobalPrefix('api').enableShutdownHooks();
}
```

```typescript
// src/main.ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp } from './configure-app.js';

const app = configureApp(await NestFactory.create(AppModule));
await app.listen(process.env.PORT ?? 3000);
```

To replace a global enhancer in a suite, such as an auth guard, register it as `{ provide: APP_GUARD, useExisting: ApiKeyGuard }` plus `ApiKeyGuard` as a plain provider. Then `overrideProvider(ApiKeyGuard).useValue({ canActivate: () => true })` replaces it. With `useClass`, the test has no token to override.

Reference: [NestJS – Pipes: Global scoped pipes](https://docs.nestjs.com/pipes#global-scoped-pipes), [NestJS – Testing: Overriding globally registered enhancers](https://docs.nestjs.com/fundamentals/testing#overriding-globally-registered-enhancers)

---

### 2.2 Run E2E Tests Against the Real AppModule Over HTTP

**Impact: CRITICAL** — Green e2e suites that never exercise the real module graph, routes or migrations

An e2e test shows that the app works once it is wired together: module imports, global enhancers, routes, serialization and migrations. Put each suite in `test/<feature>.e2e-spec.ts` and import the real `AppModule`. Use `overrideProvider()` only for providers that leave the process, such as outbound HTTP clients, message brokers and mailers. In-process providers stay real, and so does the database: every app instance gets a fresh migrated SQLite `:memory:` database (that setup is in `nestjs-typeorm`). `createNestApplication()` does not initialize the app. Call `await app.init()` before the first request, and call `app.close()` in `afterAll` so the connection closes and shutdown hooks run. In ESM, Supertest is a default import. `import * as request from 'supertest'` fails at the first call with `TypeError: (0 , __vite_ssr_import_0__) is not a function`.

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

**Correct (real `AppModule`, outbound client overridden):**

```typescript
// test/products.e2e-spec.ts
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';
import { DownstreamClient } from '../src/downstream.client.js';

describe('Products (e2e)', () => {
  const downstream = { push: vi.fn(async (id: string) => `ok:${id}`) };
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DownstreamClient)
      .useValue(downstream)
      .compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
  });

  afterAll(() => app.close());

  it('POST /api/products stores the product', async () => {
    const res = await request(app.getHttpServer()).post('/api/products').send({ sku: 'p-1' }).expect(201);

    expect(res.body).toMatchObject({ sku: 'p-1', version: 1 });
  });

  it('POST /api/products rejects an invalid body', async () => {
    await request(app.getHttpServer()).post('/api/products').send({ sku: 42 }).expect(400);
  });
});
```

The 400 comes from the `ValidationPipe` that `AppModule` registers. `configureApp()` applies the global prefix that `main.ts` also uses (`e2e-global-enhancers-as-providers`).

Reference: [NestJS – Testing: End-to-end testing](https://docs.nestjs.com/fundamentals/testing#end-to-end-testing)

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
// src/products/sync.dispatcher.ts
import { Injectable } from '@nestjs/common';
import { SyncService } from '../sync.service.js';

@Injectable()
export class SyncDispatcher {
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly sync: SyncService) {}

  /** Fire-and-forget: the HTTP response does not wait for the sync. */
  dispatch(id: string): void {
    const job = this.sync.sync(id).finally(() => this.pending.delete(job));
    this.pending.add(job);
  }

  /** Resolves once every dispatched sync has settled (tests, graceful shutdown). */
  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }
}
```

```typescript
// test/sync-dispatch.e2e-spec.ts (app built as in e2e-real-app-module)
it('POST /api/products/:id/sync pushes after the 202', async () => {
  await request(app.getHttpServer()).post('/api/products/p-1/sync').expect(202);

  await app.get(SyncDispatcher).drain();

  expect(downstream.push).toHaveBeenCalledWith('p-1');
});

it('drain() combines with fake timers when the side effect retries', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  downstream.push.mockClear().mockRejectedValueOnce(Object.assign(new Error('unavailable'), { status: 503 }));

  await request(app.getHttpServer()).post('/api/products/p-2/sync').expect(202);
  const drained = app.get(SyncDispatcher).drain();
  await vi.advanceTimersByTimeAsync(60_000);
  await drained;
  vi.useRealTimers();

  expect(downstream.push).toHaveBeenCalledTimes(2);
});
```

The `while` loop also waits for work that is dispatched while `drain()` is already running. `SyncService.sync()` never rejects, because it records a dead letter instead. That keeps the fire-and-forget promise from becoming an unhandled rejection.

Reference: [NestJS – Testing: End-to-end testing](https://docs.nestjs.com/fundamentals/testing#end-to-end-testing)

---

### 3.2 Drive Retry Backoff With Fake Timers

**Impact: MEDIUM-HIGH** — Seconds of real waiting per test, and flaky results from random jitter

Retry code waits between attempts. In the probe, the production preset (`attempts: 3`, `backoff: { delay: '1s' }`, full jitter by default) cost 2.7 s of real time per test. On fake timers the same test took 2 ms. In beforeEach, call `vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })`. `@nestjs/resilience` 0.0.3 waits through the global `setTimeout`, and its circuit breakers and rate limits read `Date.now()`. Start the call without awaiting it, then `await vi.advanceTimersByTimeAsync(ms)` past the full backoff budget, then await the result. The async variant lets each failed attempt settle before the next timer fires. `vi.waitFor` does not speed up fake time. Under fake timers it moves the clock forward by `interval` (50 ms) once per real `interval`. With its 1 s default timeout it saw 2 of the 3 attempts and failed. Use it only to poll for work that finishes quickly in real time.

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
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { DownstreamClient } from '../src/downstream.client.js';
import { SyncService } from '../src/sync.service.js';

const unavailable = () => Object.assign(new Error('unavailable'), { status: 503 });
const downstream = { push: vi.fn<(id: string) => Promise<string>>() };
let app: INestApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DownstreamClient)
    .useValue(downstream)
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();
});
afterAll(() => app.close());

beforeEach(() => {
  downstream.push.mockReset();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
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

**Correct (alternative when the test is about something other than the retry timing: zero backoff):**

```typescript
import { RESILIENCE_MODULE_OPTIONS, type ResilienceModuleOptions } from '@nestjs/resilience';

const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
  .overrideProvider(DownstreamClient)
  .useValue(downstream)
  .overrideProvider(RESILIENCE_MODULE_OPTIONS)
  .useValue({ presets: { downstream: { retry: { attempts: 3, backoff: { delay: 0 } } } } } satisfies ResilienceModuleOptions)
  .compile();
```

This works with `@nestjs/resilience` 0.0.3 and real timers: a call that failed twice and succeeded on the third attempt finished in 4 ms. `useValue` replaces the whole options object, including every preset and `defaults`, so the test no longer checks the production policy. Prefer fake timers whenever the attempt count, backoff or breaker behaviour is what you are testing.

Reference: [Vitest – vi.useFakeTimers](https://vitest.dev/api/vi#vi-usefaketimers), [Vitest – vi.advanceTimersByTimeAsync](https://vitest.dev/api/vi#vi-advancetimersbytimeasync)

---

## References

- https://docs.nestjs.com
- https://github.com/nestjs/nest
- https://typeorm.io
- https://github.com/typestack/class-validator
- https://github.com/goldbergyoni/nodebestpractices

---

*Generated by build-agents.ts on 2026-10-29*
