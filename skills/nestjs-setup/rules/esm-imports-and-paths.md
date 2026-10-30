---
title: Write ESM Import Specifiers and Module Paths
impact: CRITICAL
impactDescription: Prevents TS2307 compile errors and __dirname crashes at runtime
tags: esm, imports, import-meta, top-level-await, nodenext, main-ts
---

## Write ESM Import Specifiers and Module Paths

Under `nodenext`, a relative import names the emitted file, so it ends in `.js` even though the source is `.ts`; without the suffix TypeScript 6 reports `error TS2307: Cannot find module './app.module' or its corresponding type declarations.` The same applies to deep imports into packages that have no `exports` map, e.g. `supertest/types.js` (the `nest new` e2e spec imports `supertest/types` and fails `tsc` with TS2307). ES modules have no `__dirname`; `tsc` accepts it because `@types/node` declares it globally, and the app crashes at runtime with `ReferenceError: __dirname is not defined in ES module scope`. Use `import.meta.dirname`. ESM entry points allow top-level await, so `main.ts` awaits `NestFactory.create` and `listen` directly, without a `bootstrap()` wrapper.

App settings that tests need too (global prefix, static assets) belong in `configureApp()`, which `main.ts` and the e2e helper `createTestApp()` both call (`nestjs-testing`, `e2e-global-enhancers-as-providers`). `main.ts` adds only what a test app must not have: the process handlers, the production logger, `enableShutdownHooks()` and `listen()`.

**Incorrect (CommonJS habits, settings only in the entry point):**

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

**Correct (`src/configure-app.ts`, shared with the e2e tests):**

```typescript
import type { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'node:path';

/** Settings with no provider form that production and tests share; main.ts and createTestApp() call this. */
export function configureApp(app: NestExpressApplication): NestExpressApplication {
  return app.setGlobalPrefix('api').useStaticAssets(join(import.meta.dirname, '..', 'public'));
}
```

**Correct (`src/main.ts`):**

```typescript
import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './configure-app.js';

// Logger options, log level and .env loading: nestjs-logging (setup-json-console-logger).
const logger = new ConsoleLogger({ json: true, redact: ['password', 'token', 'authorization', 'cookie'] });
const toError = (thrown: unknown): Error => (thrown instanceof Error ? thrown : new Error(String(thrown)));
process.on('uncaughtException', (thrown) => {
  logger.fatal('Uncaught exception', { source: 'process' }, toError(thrown));
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.fatal('Unhandled rejection', { source: 'process' }, toError(reason));
  process.exit(1);
});

const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger });
configureApp(app);
app.enableShutdownHooks();
await app.listen(process.env.PORT ?? 3000);
```

`import.meta.dirname` is the directory of the module that evaluates it: `dist/` after `nest build`, `src/` under Vitest, so `join(import.meta.dirname, '..', 'public')` reaches the same folder in both. In the probe, `GET /hello.txt` returned the file from the e2e suite and from `node dist/main.js`. The handlers are registered before `create()` and log through the same unbuffered logger the app uses, so a failure at any point is written before the exit: a rejection of the string `'boom'` in the built app printed `{"level":"fatal",…,"message":"Unhandled rejection","error":{"name":"Error","message":"boom",…},"params":{"source":"process"}}` and exited 1. `enableShutdownHooks()` stays in `main.ts`; tests close their app with `app.close()`, which runs the same lifecycle hooks.

Reference: [NestJS migration guide – ESM](https://docs.nestjs.com/migration-guide)
