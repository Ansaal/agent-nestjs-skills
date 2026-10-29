---
title: Run E2E Tests Against the Real AppModule Over HTTP
impact: CRITICAL
impactDescription: Green e2e suites that never exercise the real module graph, routes or migrations
tags: testing, e2e, supertest, overrideProvider, AppModule
---

## Run E2E Tests Against the Real AppModule Over HTTP

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
