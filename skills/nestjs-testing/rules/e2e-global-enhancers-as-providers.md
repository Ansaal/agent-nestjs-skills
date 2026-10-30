---
title: Register Global Enhancers as APP_* Providers
impact: CRITICAL
impactDescription: E2E tests run without the production validation, error mapping and guards
tags: testing, e2e, APP_PIPE, APP_FILTER, APP_INTERCEPTOR, APP_GUARD, main.ts, configureApp
---

## Register Global Enhancers as APP_* Providers

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
