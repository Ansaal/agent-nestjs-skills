---
title: Write ESM Import Specifiers and Module Paths
impact: CRITICAL
impactDescription: Prevents TS2307 compile errors and __dirname crashes at runtime
tags: esm, imports, import-meta, top-level-await, nodenext
---

## Write ESM Import Specifiers and Module Paths

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
