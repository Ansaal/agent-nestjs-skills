---
title: Pass a JSON ConsoleLogger to NestFactory.create and Set Levels with NEST_LOG_LEVEL
impact: HIGH
impactDescription: Startup lines in the wrong format, unparseable records, every level on in production
tags: logging, consolelogger, json, nest-log-level, redact, main
---

## Pass a JSON ConsoleLogger to NestFactory.create and Set Levels with NEST_LOG_LEVEL

Nest's built-in `ConsoleLogger` writes one JSON record per line with `json: true`; no logging library or hand-written `LoggerService` is needed. Each record has `level`, `pid`, `timestamp` (epoch ms), `message`, `context`, and, when present, `params`, `error` and `stack`: `{"level":"log","pid":92721,"timestamp":1793315343105,"message":"Nest application successfully started","context":"NestApplication"}`. `colors` defaults to off and `compact` to on in JSON mode; `timestamp` and `prefix` only apply to text mode. Pass the logger in the `NestFactory.create()` options so the framework's own startup lines use it too. `app.useLogger()` after `create()` comes too late: the probe printed `[Nest] 94999 - 10/29/2026, 4:10:46 PM LOG [InstanceLoader] DiscoveryModule dependencies initialized +5ms` in text before the JSON logger took over. Do not use `bufferLogs: true` with `useLogger()` either: a `Logger` call made while the buffer is attached is lost on `process.exit` (a rejection raised during `create()` exited 1 with no output), whereas direct calls on the `ConsoleLogger` instance bypass any buffer.

Leave `logLevels` unset and let the environment decide: without it, `ConsoleLogger` reads `NEST_LOG_LEVEL` on the first level check, as a threshold (`log` enables `log`, `warn`, `error`, `fatal`), a threshold expression (`>=debug`) or a list (`warn,error` enables the listed levels plus every level above the highest one, so `fatal` too). Unset, every level is on, verbose payloads included, so `main.ts` sets the production default itself. An invalid value logs `Invalid NEST_LOG_LEVEL value "none". Expected a log level ("warn"), a comma-separated list ("warn,error") or a threshold (">=warn"). Every log level is enabled instead.` The same variable silences test runs (`test-quiet-and-capture`). `redact` masks keys in params and logged objects (`content-no-secrets-or-pii`).

**Incorrect (hand-written JSON logger, text startup lines, fixed level list):**

```typescript
// main.ts
const app = await NestFactory.create(AppModule, {
  logger: process.env.NODE_ENV === 'production' ? ['error', 'warn', 'log'] : ['error', 'warn', 'log', 'debug', 'verbose'],
});
app.useLogger(new JsonLogger()); // custom LoggerService doing console.log(JSON.stringify(...)); startup already printed as text
```

**Correct (`src/main.ts`):**

```typescript
import 'reflect-metadata';
import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './configure-app.js';

// ConfigModule reads .env during create(), after ConsoleLogger needs the level: load it first.
// Values already in the process environment win; a missing .env (production) is fine.
try {
  process.loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
// Threshold read by ConsoleLogger: 'log' enables log, warn, error, fatal. `||=` also replaces an empty value.
process.env.NEST_LOG_LEVEL ||= 'log';

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

`NEST_LOG_LEVEL` is read by `ConsoleLogger`, not through `ConfigModule`, and `ConfigModule.forRoot()` loads `.env` only while `create()` builds the modules, after the default above would already have been set. Node's `process.loadEnvFile()` reads `.env` first; it does not override variables the process already has. In the probe, `.env` with `NEST_LOG_LEVEL=debug` printed `debug` lines; `NEST_LOG_LEVEL=warn` in the process environment with the same `.env` printed none; without a `.env` the app started at `log` (`loadEnvFile()` throws `ENOENT`, which the `catch` ignores). The handlers are registered before `create()` and call the same instance with the shared shape (message, fields, `Error`); they use a `source` field rather than a context argument, because the instance's default context would also label the app's context-less `Logger` calls. A rejected promise, a rejected string and a thrown string each wrote one line to stderr and exited 1: `{"level":"fatal",…,"message":"Unhandled rejection","error":{"name":"Error","message":"boom","stack":"…","cause":{"name":"Error","message":"inner",…}},"params":{"source":"process"}}`. `configureApp()` holds the settings tests share (`e2e-global-enhancers-as-providers` in `nestjs-testing`); `enableShutdownHooks()` stays here. Run with `NEST_LOG_LEVEL=debug` to trace one environment, or `>=verbose` to see payloads; nothing else changes. To add a request id to every record, swap `ConsoleLogger` for the subclass in `setup-request-id`.

Reference: [NestJS Logger – JSON logging](https://docs.nestjs.com/techniques/logger#json-logging)
