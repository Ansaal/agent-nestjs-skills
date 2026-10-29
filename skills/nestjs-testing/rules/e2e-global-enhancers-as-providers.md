---
title: Register Global Enhancers as APP_* Providers
impact: CRITICAL
impactDescription: E2E tests run without the production validation, error mapping and guards
tags: testing, e2e, APP_PIPE, APP_FILTER, APP_INTERCEPTOR, APP_GUARD, main.ts
---

## Register Global Enhancers as APP_* Providers

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
