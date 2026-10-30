# NestJS Logging

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

Logging in NestJS with the built-in `ConsoleLogger` in JSON mode. Use when setting up the app logger or log levels, adding `Logger` calls to a class, choosing a level (error, warn, log, debug, verbose), logging errors, retries or payloads, keeping secrets and personal data out of logs, adding a request id to log lines, or silencing and asserting logs in tests.

---

## Table of Contents

1. [Logger Setup](#1-logger-setup) — **HIGH**
   - 1.1 [Pass a JSON ConsoleLogger to NestFactory.create and Set Levels with NEST_LOG_LEVEL](#11-pass-a-json-consolelogger-to-nestfactory-create-and-set-levels-with-nest-log-level)
   - 1.2 [Give Each Class a `new Logger(ClassName.name)`](#12-give-each-class-a-new-logger-classname-name-)
   - 1.3 [Stamp Every Record with the Request Id from AsyncLocalStorage](#13-stamp-every-record-with-the-request-id-from-asynclocalstorage)
2. [Log Levels](#2-log-levels) — **HIGH**
   - 2.1 [Pick the Level by Who Has to Act on the Line](#21-pick-the-level-by-who-has-to-act-on-the-line)
   - 2.2 [Log a Retry at warn and Only the Final Failure at error](#22-log-a-retry-at-warn-and-only-the-final-failure-at-error)
3. [Log Content](#3-log-content) — **HIGH**
   - 3.1 [Pass the Error Object, Not Its Stack or Message](#31-pass-the-error-object-not-its-stack-or-message)
   - 3.2 [Never Log Secrets or Personal Data; redact Is Only the Safety Net](#32-never-log-secrets-or-personal-data-redact-is-only-the-safety-net)
   - 3.3 [Fixed Message, Fields in One Params Object](#33-fixed-message-fields-in-one-params-object)
4. [Logs in Tests](#4-logs-in-tests) — **MEDIUM**
   - 4.1 [Silence the App Logger in Tests and Assert Logs with CapturingLogger](#41-silence-the-app-logger-in-tests-and-assert-logs-with-capturinglogger)

---

## 1. Logger Setup

**Section Impact: HIGH**

### 1.1 Pass a JSON ConsoleLogger to NestFactory.create and Set Levels with NEST_LOG_LEVEL

**Impact: HIGH** — Startup lines in the wrong format, unparseable records, every level on in production

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

---

### 1.2 Give Each Class a `new Logger(ClassName.name)`

**Impact: HIGH** — Lines that skip the app's JSON format, level threshold and masking

A `Logger` from `@nestjs/common` holds no output of its own: every call is forwarded to the logger the app was created with (`setup-json-console-logger`), so the line gets the JSON format, the `NEST_LOG_LEVEL` threshold and `redact`, and its `context` names the class. Forwarding happens per call, so a `Logger` constructed before `NestFactory.create()` ran still writes JSON. `console.log` and a `new ConsoleLogger()` inside a class bypass all of it. With the app logger set to JSON and `logLevels: ['warn']`, the probe printed:

```text
[Nest] 95155  - 10/29/2026, 4:10:52 PM     LOG [DirectConsoleLogger] Batch processed { batchId: 'b1' }
{"level":"warn","pid":95155,"timestamp":1793315452098,"message":"Retrying failed call","context":"ClassLogger","params":{"attempt":1}}
Batch processed { batchId: 'b1' }
```

The `new ConsoleLogger('DirectConsoleLogger')` line came out as text despite the level threshold, the `console.log` line has no level or context at all, and only the `new Logger('ClassLogger')` warn line followed the app's settings (its `log` call was filtered out). `ConsoleLogger` is not a provider either: injecting it fails bootstrap with `Nest can't resolve dependencies of the BatchProcessor (?). Please make sure that the argument ConsoleLogger at index [0] is available in the BadModule module.` Use `ClassName.name` rather than a string literal so the context follows renames; an event subscriber that logs for a whole subsystem may use a fixed name such as `new Logger('Resilience')`.

**Incorrect (console, ad-hoc ConsoleLogger, logger injected as a provider):**

```typescript
@Injectable()
export class BatchProcessor {
  private readonly logger = new ConsoleLogger('BatchProcessor'); // ignores the app logger

  constructor(private readonly appLogger: ConsoleLogger) {} // not a provider: bootstrap fails to resolve it

  async process(batchId: string, rows: { sku: string }[]) {
    console.log('processing batch', batchId);
  }
}
```

**Correct (`src/batches/batch.processor.ts`):**

```typescript
import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class BatchProcessor {
  private readonly logger = new Logger(BatchProcessor.name);

  async process(batchId: string, rows: { sku: string }[]): Promise<number> {
    const startedAt = performance.now();
    for (const row of rows) {
      this.logger.debug('Row imported', { batchId, sku: row.sku });
    }
    this.logger.log('Batch processed', {
      batchId,
      rows: rows.length,
      durationMs: Math.round(performance.now() - startedAt),
    });
    return rows.length;
  }
}
```

Output at `NEST_LOG_LEVEL=log`: `{"level":"log","pid":92721,"timestamp":1793315346395,"message":"Batch processed","context":"BatchProcessor","params":{"batchId":"b1","rows":2,"durationMs":0}}`; the `Row imported` lines appear only at `debug`. Which level to pick is `level-policy`.

Reference: [NestJS Logger – Using the logger for application logging](https://docs.nestjs.com/techniques/logger#using-the-logger-for-application-logging)

---

### 1.3 Stamp Every Record with the Request Id from AsyncLocalStorage

**Impact: MEDIUM** — Lines of concurrent requests cannot be told apart

Concurrent requests interleave their lines; a `requestId` field on every record lets one request's flow be filtered out, including lines written deep inside services and by framework subscribers. No extra package is needed: Node's `AsyncLocalStorage` carries the id through every `await`, a middleware opens the store per request, and a `ConsoleLogger` subclass adds the field in `getJsonLogObject()`, the protected hook that builds each JSON record. Services keep calling `new Logger(ClassName.name)` and pass no id. The id is taken from an incoming `x-request-id` header when it looks like an id, so a caller's trace continues, otherwise generated, and echoed in the response. Lines written outside a request (startup, timers, queue consumers) have no store and no field.

**Incorrect (id threaded through every call, or a request-scoped logger):**

```typescript
async create(input: CreateUserInput, requestId: string) {
  this.logger.debug(`[${requestId}] Creating user`); // every signature changes; lines in other classes lack the id
}
// or: @Injectable({ scope: Scope.REQUEST }) on the logger, which makes every consumer request-scoped
```

**Correct (`src/logging/request-context.ts`):**

```typescript
import { AsyncLocalStorage } from 'node:async_hooks';

/** Holds the id of the request being handled; empty outside a request (startup, timers). */
export const requestContext = new AsyncLocalStorage<{ requestId: string }>();
```

**Correct (`src/logging/request-id.middleware.ts`):**

```typescript
import { randomUUID } from 'node:crypto';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { requestContext } from './request-context.js';

const SAFE_ID = /^[\w-]{1,64}$/;

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.get('x-request-id');
    const requestId = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader('x-request-id', requestId);
    // Everything the request does from here, async continuations included, sees this store.
    requestContext.run({ requestId }, next);
  }
}
```

**Correct (`src/logging/app-logger.ts`, used in `main.ts` instead of `ConsoleLogger`):**

```typescript
import { ConsoleLogger } from '@nestjs/common';
import { requestContext } from './request-context.js';

/** ConsoleLogger whose JSON records carry the id of the request that wrote them. */
export class AppLogger extends ConsoleLogger {
  protected override getJsonLogObject(...args: Parameters<ConsoleLogger['getJsonLogObject']>) {
    const record = super.getJsonLogObject(...args);
    const requestId = requestContext.getStore()?.requestId;
    return requestId ? { ...record, requestId } : record;
  }
}
```

```typescript
// app.module.ts
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('{*path}'); // '*path' skips GET /
  }
}
// main.ts: logger: new AppLogger({ json: true, redact: ['password', 'token', 'authorization', 'cookie'] })
```

`'{*path}'` makes the wildcard optional, so the middleware also runs for `/`: `GET /` answered with a generated `x-request-id: a47da69a-39aa-4187-9c3a-b743ed75db90` and its `debug` line carried the same id, while with `forRoutes('*path')` the `GET /` response had no `x-request-id` header. A request sent with `x-request-id: req-43` produced, among others, a retry event from the `@nestjs/resilience` subscriber and the final failure, both carrying the id: `{"level":"warn",...,"message":"Retrying call","context":"Resilience","error":{"name":"CarrierError","message":"The carrier answered with status 503",...},"params":{"source":"OrderSyncService.push","attempt":1,"delayMs":2},"requestId":"req-43"}`. The unhandled-exception line Nest writes itself carried the generated id too: `{"level":"error",...,"message":"Unexpected state","context":"ExceptionsHandler","error":{...},"requestId":"fe7581f9-4040-43dc-b8f4-16e393fe8534"}`. Work picked up later from a queue or a table runs outside the request's store; save the id with the job if the trace must follow it.

Reference: [Node.js – AsyncLocalStorage](https://nodejs.org/api/async_context.html#class-asynclocalstorage)

---

## 2. Log Levels

**Section Impact: HIGH**

### 2.1 Pick the Level by Who Has to Act on the Line

**Impact: HIGH** — Production output drowned in per-request lines; alerts on handled conditions

Production runs at `NEST_LOG_LEVEL=log` (`setup-json-console-logger`), so everything at `log` and above is stored, shipped and paid for, and `warn`/`error` are what dashboards and alerts read. Every example in every skill follows this policy:

| Level | Use for | Examples |
|-------|---------|----------|
| `fatal` / `error` | Needs attention: the operation failed for good | A call failed after its last retry, an unhandled exception, the app cannot start |
| `warn` | Degraded but handled | A retry, a fallback answer, a circuit-breaker state change |
| `log` (Nest's "info") | Events that affect more than one request, or may matter later; keep these small | Startup, a batch or job processed, a lock lost, a dead letter written |
| `debug` | Tracing the flow | Per-request steps: "Creating user", "Order pushed" |
| `verbose` | Data | Request and response payloads, rows read |

A line written for every request is `debug`, never `log`: at `log` it multiplies with traffic and buries the events that matter. Payloads go to `verbose` only, so they appear only when someone turns them on, and even there secrets and personal data are never logged (`content-no-secrets-or-pii`). An expected outcome a client caused (a validation failure, a 404, a duplicate) is not an `error`; the response carries it, and a `debug` line is the most it needs. Retries and final failures are `level-retry-warn-final-error`.

**Incorrect (per-request steps at `log`, payload dumped, duplicate as an error):**

```typescript
async create(input: CreateUserInput) {
  this.logger.log(`Creating user ${JSON.stringify(input)}`); // every request, at log, with the password
  if (this.emailTaken(input.email)) {
    this.logger.error('Email already registered'); // the client's mistake, answered with 409
    throw new ConflictException('Email already registered');
  }
  // ...
  this.logger.log('User created');
}
```

**Correct (`src/users/users.service.ts`, per-request steps at `debug`):**

```typescript
import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable, Logger } from '@nestjs/common';

export interface CreateUserInput {
  email: string;
  password: string;
  name: string;
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);
  private readonly users = new Map<string, { id: string; email: string; name: string }>();

  async create(input: CreateUserInput): Promise<{ id: string }> {
    this.logger.debug('Creating user');
    if ([...this.users.values()].some((user) => user.email === input.email)) {
      throw new ConflictException('Email already registered');
    }
    const user = { id: randomUUID(), email: input.email, name: input.name };
    this.users.set(user.id, user);
    this.logger.debug('User created', { userId: user.id });
    return { id: user.id };
  }
}
```

**Correct (`src/carrier/carrier.client.ts`, the payload at `verbose`):**

```typescript
async pushOrder(order: OrderSnapshot, signal: AbortSignal): Promise<{ trackingId: string }> {
  // ... the HTTP call
  this.logger.verbose('Carrier response', { orderId: order.id, response });
  return response;
}
```

At `NEST_LOG_LEVEL=log` a user creation and a successful carrier push wrote nothing; the batch import in `setup-logger-per-class` wrote its one `Batch processed` line. At `>=verbose` the same requests wrote `{"level":"debug",...,"message":"User created","context":"UsersService","params":{"userId":"35c64524-c904-4bee-8935-1ee10dd07a7e"}}` and `{"level":"verbose",...,"message":"Carrier response","context":"CarrierClient","params":{"orderId":"ord_2","response":{"trackingId":"trk_ord_2"}}}`.

Reference: [NestJS Logger – Log levels](https://docs.nestjs.com/techniques/logger#basic-customization)

---

### 2.2 Log a Retry at warn and Only the Final Failure at error

**Impact: HIGH** — Alerts fire on failures that recovered; the failure that needs a human hides among them

A failed attempt that will be retried is degraded but handled: `warn`. Only the outcome that nobody will retry is `error`, logged once, by the code that gives up, with the `Error` object attached (`content-errors-as-objects`). Logging every attempt at `error` makes a recovered call indistinguishable from a lost one: a batch processor that logged `` `Punch batch ${batch.id} failed on attempt ${batch.attempts}/${MAX_ATTEMPTS} (${status}): ${message}` `` at `error` for every attempt, including those it re-polls and may still recover, filled a test run with `ERROR [PunchBatchProcessor] …` lines. Retries themselves belong to `@nestjs/resilience` (`nestjs-resilience`); its `ResilienceEvents.events$` stream emits a `retry` event per failed attempt and a state event per breaker transition, so one subscriber logs all of them at `warn`. When the final failure is recorded as a dead letter (`nestjs-resilience`, `dlq-record-final-failure`), the dead-letter record is what someone acts on and the line saying it was written is `log`; without a dead letter, the final failure is `error`.

**Incorrect (every attempt an error, final failure logged as text without the error):**

```typescript
this.resilienceEvents.events$.subscribe((event) => {
  if (event.type === 'retry') this.logger.error(`attempt ${event.attempt} failed: ${String(event.error)}`);
});
// ...
} catch (error) {
  this.logger.error(`Order ${order.id} push failed: ${String(error)}`); // no stack, no code, id inside the text
}
```

**Correct (`src/carrier/resilience.logger.ts`, registered in the providers of `AppModule`):**

```typescript
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ResilienceEvents } from '@nestjs/resilience';

@Injectable()
export class ResilienceLogger implements OnModuleInit {
  private readonly logger = new Logger('Resilience');

  constructor(private readonly resilienceEvents: ResilienceEvents) {}

  onModuleInit() {
    this.resilienceEvents.events$.subscribe((event) => {
      switch (event.type) {
        case 'retry': {
          // Normalise once: the event's error is whatever the call threw.
          const err = event.error instanceof Error ? event.error : new Error(String(event.error));
          this.logger.warn('Retrying call', { source: event.source, attempt: event.attempt, delayMs: event.delayMs }, err);
          break;
        }
        case 'circuit-open':
        case 'circuit-half-open':
        case 'circuit-closed':
          this.logger.warn('Circuit state changed', { policy: event.policy, from: event.from, to: event.to });
          break;
      }
    });
  }
}
```

**Correct (`src/carrier/order-sync.service.ts`, the final failure once, at `error`):**

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { ResilienceService, type ResiliencePolicy } from '@nestjs/resilience';
import { CarrierClient, type OrderSnapshot } from './carrier.client.js';

@Injectable()
export class OrderSyncService {
  private readonly logger = new Logger(OrderSyncService.name);
  private readonly carrierPolicy: ResiliencePolicy;

  constructor(
    resilience: ResilienceService,
    private readonly carrier: CarrierClient,
  ) {
    this.carrierPolicy = resilience.preset('carrier');
  }

  async push(order: OrderSnapshot): Promise<boolean> {
    this.logger.debug('Pushing order to carrier', { orderId: order.id, lines: order.lines.length });
    try {
      const { trackingId } = await this.carrierPolicy.execute(
        ({ signal }) => this.carrier.pushOrder(order, signal),
        { source: 'OrderSyncService.push' },
      );
      this.logger.debug('Order pushed', { orderId: order.id, trackingId });
      return true;
    } catch (error) {
      // Retries are exhausted: the order did not reach the carrier.
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error('Order push failed', { orderId: order.id }, err);
      return false;
    }
  }
}
```

With the `carrier` preset at `retry: { attempts: 3 }` and a carrier down for three calls, one push wrote two `warn` lines and one `error` line, each with the structured `error` (stacks shortened):

```text
{"level":"warn","pid":50728,"timestamp":1793334286422,"message":"Retrying call","context":"Resilience","error":{"name":"CarrierError","message":"The carrier answered with status 503","stack":"…","status":503,"code":"CARRIER_UNAVAILABLE"},"params":{"source":"OrderSyncService.push","attempt":1,"delayMs":2}}
{"level":"warn","pid":50728,"timestamp":1793334286425,"message":"Retrying call","context":"Resilience","error":{"name":"CarrierError","message":"The carrier answered with status 503","stack":"…","status":503,"code":"CARRIER_UNAVAILABLE"},"params":{"source":"OrderSyncService.push","attempt":2,"delayMs":9}}
{"level":"error","pid":50728,"timestamp":1793334286437,"message":"Order push failed","context":"OrderSyncService","error":{"name":"CarrierError","message":"The carrier answered with status 503","stack":"…","status":503,"code":"CARRIER_UNAVAILABLE"},"params":{"orderId":"ord_1"}}
```

The retry line carries `status` and `code` because the error is the third argument; copied into params as `error.message`, they and the stack were gone. The same subscriber is `nestjs-resilience`'s `dlq-record-final-failure`, where the final failure is recorded as a dead letter and logged at `log`.

A job runner that retries on its own (a batch re-polled from a table) follows the same split: `warn` while `attempts < maxAttempts`, `error` (or `log` plus a dead letter) on the last one.

Reference: [NestJS Resilience – Observe breaker transitions](https://docs.nestjs.com/reliability/resilience#observe-breaker-transitions)

---

## 3. Log Content

**Section Impact: HIGH**

### 3.1 Pass the Error Object, Not Its Stack or Message

**Impact: HIGH** — Error records without the error's name, code, status or cause

In JSON mode, `ConsoleLogger` pulls the first `Error` out of the arguments and serializes it into an `error` field: `name`, `message`, `stack`, the error's own primitive properties (`code`, `status`), and recursively its `cause` (an error with `{ cause }` logged `"cause":{"name":"Error","message":"socket hang up","stack":"...","code":"ECONNRESET"}`) and the `errors` of an `AggregateError`. The older `logger.error(message, error.stack)` form still works but keeps only the stack string; `String(error)` or `error.message` in the text keeps neither stack nor code. The order of the params object and the error does not matter. A caught value is `unknown`; pass it as is when the code you call throws `Error`s, but know that a thrown string in last position is read as the context: `logger.error('Order push failed', { orderId: 'ord_1' }, 'plain string thrown')` wrote `"context":"plain string thrown"`. Probe output for one error with `code = 'ECONNREFUSED'` (stack shortened):

```text
logger.error('Carrier call failed', err.stack)
{"level":"error",...,"message":"Carrier call failed","context":"Probe","stack":"Error: connect ECONNREFUSED 127.0.0.1:443\n    at file:///.../scratch.mjs:5:13\n    ..."}

logger.error('Carrier call failed', { orderId: 'ord_1', attempts: 3 }, err)
{"level":"error",...,"message":"Carrier call failed","context":"Probe","error":{"name":"Error","message":"connect ECONNREFUSED 127.0.0.1:443","stack":"Error: connect ECONNREFUSED 127.0.0.1:443\n    at file:///.../scratch.mjs:5:13\n    ...","code":"ECONNREFUSED"},"params":{"orderId":"ord_1","attempts":3}}

logger.error(err)
{"level":"error",...,"message":"connect ECONNREFUSED 127.0.0.1:443","context":"Probe","error":{"name":"Error","message":"connect ECONNREFUSED 127.0.0.1:443","stack":"...","code":"ECONNREFUSED"}}
```

In text mode the error prints as Node's inspect output, stack and own properties included: `ERROR [OrderSyncService] Error: The carrier answered with status 503 … { code: 'CARRIER_UNAVAILABLE' } { orderId: 'ord_1' }`. Nest's own `ExceptionsHandler` uses the same field for unhandled exceptions: `{"level":"error",...,"message":"Unexpected state","context":"ExceptionsHandler","error":{"name":"Error","message":"Unexpected state","stack":"Error: Unexpected state\n    at UsersController.boom (...)"}}`, so an exception that reaches the framework needs no extra log line before it is rethrown.

**Incorrect (stack string, text-only error, log-and-rethrow):**

```typescript
} catch (error) {
  this.logger.error('Order push failed', (error as Error).stack); // no code, no status, no cause
  this.logger.error(`Order ${order.id} push failed: ${String(error)}`); // no stack at all
  throw error; // ExceptionsHandler logs it again
}
```

**Correct (message, params, then the caught value):**

```typescript
} catch (error) {
  // Retries are exhausted: the order did not reach the carrier.
  const err = error instanceof Error ? error : new Error(String(error));
  this.logger.error('Order push failed', { orderId: order.id }, err);
  return false;
}
```

A caught value is `unknown`; normalise it once so the record always has an `error` field. A thrown string passed as is logged `"stack":"socket closed"` and no `error`; wrapped in `new Error(String(error))` it logged `"error":{"name":"Error","message":"socket closed","stack":"…"}`. The full service and the level choice are in `level-retry-warn-final-error`. Log an error where it is handled for the last time; code that rethrows leaves the logging to whoever catches it last, or to Nest's `ExceptionsHandler`. `error.message` and `error.stack` are written as they are, never redacted (`content-no-secrets-or-pii`).

Reference: [NestJS Logger – JSON logging](https://docs.nestjs.com/techniques/logger#json-logging)

---

### 3.2 Never Log Secrets or Personal Data; redact Is Only the Safety Net

**Impact: CRITICAL** — Passwords, tokens and personal data copied into log storage with wide access and long retention

Logs are shipped, indexed, retained for months and readable by far more people than the database, so a secret or personal datum written once has leaked. That holds at every level: a `verbose` payload dump enabled for one afternoon is as permanent as an `error`. Log identifiers (`userId`, `orderId`), counts and outcomes, not the email, name, address, password, token, card or request body they belong to. `ConsoleLogger`'s `redact` option (`setup-json-console-logger`) masks listed keys at any depth, case-insensitively, in params and logged objects, without mutating them. It cannot mask what it cannot see: string messages, an error's message and its stack are written as they are, and personal data under a key not on the list (`email`) passes. The probe, with `redact: ['password', 'token', 'authorization', 'cookie']`:

```text
logger.debug('Login attempt', { email: 'ann@example.com', password: 'hunter2' })
{"level":"debug",...,"message":"Login attempt","context":"AuthService","params":{"email":"ann@example.com","password":"[REDACTED]"}}

logger.verbose('Outbound request', { headers: { Authorization: 'Bearer abc', accept: 'json' }, body: { user: { password: 'x', name: 'Ann' } } })
{"level":"verbose",...,"message":"Outbound request","context":"AuthService","params":{"headers":{"Authorization":"[REDACTED]","accept":"json"},"body":{"user":{"password":"[REDACTED]","name":"Ann"}}}}

logger.debug(`Login attempt with password hunter2`)
{"level":"debug",...,"message":"Login attempt with password hunter2","context":"AuthService"}

logger.error('Login failed', Object.assign(new Error('token abc rejected'), { token: 'abc' }))
{"level":"error",...,"message":"Login failed","context":"AuthService","error":{"name":"Error","message":"token abc rejected","stack":"Error: token abc rejected\n    at ...","token":"[REDACTED]"}}
```

**Incorrect (request body, email and credentials logged):**

```typescript
this.logger.verbose('Create user payload', { body: input }); // email, name; password only masked by luck of the key name
this.logger.debug(`Login attempt for ${email} with token ${token}`); // string message: never redacted
```

**Correct (identifiers only; redact configured as the net):**

```typescript
// users.service.ts
this.logger.debug('Creating user');
// ...
this.logger.debug('User created', { userId: user.id });

// main.ts
logger: new ConsoleLogger({ json: true, redact: ['password', 'token', 'authorization', 'cookie'] }),
```

An e2e test can assert that nothing a request carried reached the log with a `CapturingLogger`: `logs.assertNotLogged(mentions('hunter2'))`, where `mentions()` (`test-quiet-and-capture`) walks the message, params, stack and error, including its `cause` chain and `AggregateError.errors`. `JSON.stringify(entry.args)` is not enough: it serializes an `Error` as `{}`, so a secret inside an error message passed that check in the probe. Error messages built from input (`Invalid email ann@example.com`) carry the data into `error.message`; build them from identifiers too.

Reference: [OWASP Logging Cheat Sheet – Data to exclude](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html#data-to-exclude)

---

### 3.3 Fixed Message, Fields in One Params Object

**Impact: HIGH** — Lines that cannot be filtered or grouped by field; values that escape redaction

`ConsoleLogger` (`structuredParams` on by default) treats a plain object passed after the message as metadata and, in JSON mode, writes it to the record's `params` key, while the message stays a fixed string that groups identical events. Values interpolated into the message can only be found by text search, and `redact` never masks a string message (`content-no-secrets-or-pii`). An object passed as the message is not params either: it is serialized as a nested `message` object. Several plain objects are merged into one `params`. Write `this.logger.<level>('Fixed message', { field: value })`; never build the message with `+` or a template string from data. Probe output for each form:

```text
logger.warn('Retrying carrier call', { attempt: 1, delayMs: 200 })
{"level":"warn","pid":88658,"timestamp":1793315191688,"message":"Retrying carrier call","context":"Probe","params":{"attempt":1,"delayMs":200}}

logger.warn({ message: 'Retrying carrier call', attempt: 1, delayMs: 200 })
{"level":"warn","pid":88658,"timestamp":1793315191688,"message":{"message":"Retrying carrier call","attempt":1,"delayMs":200},"context":"Probe"}

logger.log('User ' + 42 + ' created')
{"level":"log","pid":88658,"timestamp":1793315191689,"message":"User 42 created","context":"Probe"}

logger.log('two objects', { a: 1 }, { b: 2 })
{"level":"log","pid":88658,"timestamp":1793315191689,"message":"two objects","context":"Probe","params":{"a":1,"b":2}}
```

In text mode (`json` off, as in tests) the params print after the message: `LOG [BatchProcessor] Batch processed { batchId: 'b1', rows: 1, durationMs: 1 }`. Keep the default `params` key: `flattenParams: true` spreads the fields into the record's root, and fields named like the record's own keys are dropped silently. `log('Batch processed', { batchId: 'b1', level: 'high', message: 'x' })` wrote `{"level":"log",...,"message":"Batch processed","context":"Probe","batchId":"b1"}`.

**Incorrect (data in the message, object as the message):**

```typescript
this.logger.log(`Batch ${batchId} processed: ${rows.length} rows in ${durationMs} ms`);
this.logger.log({ message: 'Stock reconciled', skus: 3 });
```

**Correct:**

```typescript
this.logger.log('Batch processed', { batchId, rows: rows.length, durationMs });
this.logger.log('Stock reconciled', { skus: 3 });
```

Use stable camelCase field names across the codebase (`orderId`, `userId`, `durationMs`, `attempt`) so one query finds every line about an order. Errors are passed as objects, not as fields (`content-errors-as-objects`).

Reference: [NestJS Logger – JSON logging](https://docs.nestjs.com/techniques/logger#json-logging)

---

## 4. Logs in Tests

**Section Impact: MEDIUM**

### 4.1 Silence the App Logger in Tests and Assert Logs with CapturingLogger

**Impact: MEDIUM** — Expected failures printed as errors in green runs; log levels left untested

`Test.createTestingModule().compile()` installs `TestingLogger` from `@nestjs/testing`, which drops `log`, `warn`, `debug` and `verbose` but prints `error` and `fatal`. A test that provokes a failure on purpose then prints it into a passing run, stack and all:

```text
[Nest] 94098  - 10/29/2026, 4:09:40 PM   ERROR [OrderSyncService] Order push failed { orderId: 'ord_1' }
[Nest] 94098  - 10/29/2026, 4:09:40 PM   ERROR [OrderSyncService] CarrierError: The carrier answered with status 503
    at CarrierClient.pushOrder (/private/tmp/nestjs-logging-probe/src/carrier/carrier.client.ts:24:69)
    ...
```

Unit tests that construct a class directly use the default `ConsoleLogger` with every level on (`DEBUG [BatchProcessor] Row imported { batchId: 'b1', sku: 'A' }`). Both read `NEST_LOG_LEVEL`, so one line in the Vitest config silences them, and `NEST_LOG_LEVEL=error pnpm test` brings the output back while debugging (it did in the probe, printing the two lines above again). The Vitest config itself is `nestjs-setup`'s `vitest-swc-configs`.

A test that cares about a log line asserts it instead of reading output: `CapturingLogger` (exported by `@nestjs/testing` 12.3.2) records every call with `level`, `context`, `message`, `params`, `error` and `stack`, prints nothing unless `print: true`, and ignores `NEST_LOG_LEVEL`, so it captures every level in a silenced run. Passed as the app's logger through `createTestApp(override, { logger: logs })` (`nestjs-testing`'s helper), it becomes the logger every `Logger` instance forwards to, the `Resilience` subscriber's included. That turns the level policy (`level-policy`, `level-retry-warn-final-error`) into a tested contract. A failed assertion lists what was captured:

```text
Error: Expected a log entry matching { level: 'error', context: 'OrderSyncService', params: { orderId: 'ord_9' } }, but none of the 4 captured entries matched.
Captured entries:
  DEBUG [OrderSyncService] Pushing order to carrier { orderId: 'ord_1', lines: 1 }
  WARN [Resilience] Retrying call { source: 'OrderSyncService.push', attempt: 1, delayMs: 0 }
  WARN [Resilience] Retrying call { source: 'OrderSyncService.push', attempt: 2, delayMs: 1 }
  ERROR [OrderSyncService] Order push failed { orderId: 'ord_1' }
```

**Incorrect (expected errors printed, logs checked by spying on the console):**

```typescript
const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile(); // TestingLogger prints errors
const spy = vi.spyOn(process.stdout, 'write'); // couples the test to the text format
```

**Correct (`vitest.config.ts`, the `test.env` entry):**

```typescript
env: {
  // Silences ConsoleLogger and TestingLogger; NEST_LOG_LEVEL=error pnpm test shows errors again.
  NEST_LOG_LEVEL: process.env.NEST_LOG_LEVEL || 'fatal',
},
```

**Correct (`test/orders.e2e-spec.ts`):**

```typescript
import type { NestExpressApplication } from '@nestjs/platform-express';
import { type CapturedLog, CapturingLogger } from '@nestjs/testing';
import request from 'supertest';
import { createTestApp } from './support/test-app.js';

/** True when `text` appears in any string the entry prints: message, params, stack, or an error with its own fields, `cause` chain and `AggregateError.errors`. Cycle-safe. */
const mentions = (text: string) => (entry: CapturedLog) => {
  const seen = new WeakSet<object>();
  const visit = (value: unknown): boolean => {
    if (typeof value === 'string') return value.includes(text);
    if (typeof value !== 'object' || value === null || seen.has(value)) return false;
    seen.add(value);
    const parts = Object.values(value);
    if (value instanceof Error) parts.push(value.message, value.stack, value.cause);
    if (value instanceof AggregateError) parts.push(value.errors);
    return parts.some(visit);
  };
  return [entry.message, entry.params, entry.stack, entry.error].some(visit);
};

describe('Orders (e2e)', () => {
  let logs: CapturingLogger;
  let app: NestExpressApplication;

  // A fresh app and logger per test: one test's entries never reach the next.
  beforeEach(async () => {
    logs = new CapturingLogger();
    app = await createTestApp(undefined, { logger: logs });
    return () => app.close();
  });

  it('logs retries at warn and the final failure at error, with the error attached', async () => {
    await request(app.getHttpServer())
      .post('/orders/ord_1/sync')
      .send({ lines: [{ sku: 'A', quantity: 1 }] })
      .expect(201)
      .expect({ pushed: false });

    const retries = logs.filter({ level: 'warn', context: 'Resilience', message: 'Retrying call' });
    expect(retries).toHaveLength(2);
    expect(retries[0].error?.message).toBe('The carrier answered with status 503');
    const failure = logs.assertLogged({ level: 'error', context: 'OrderSyncService', params: { orderId: 'ord_1' } });
    expect(failure.error?.message).toBe('The carrier answered with status 503');
  });

  it('keeps request data out of the log and per-request steps below log', async () => {
    await request(app.getHttpServer())
      .post('/users')
      .send({ email: 'ann@example.com', password: 'hunter2', name: 'Ann' })
      .expect(201);

    logs.assertNotLogged(mentions('hunter2'));
    logs.assertNotLogged(mentions('ann@example.com'));
    logs.assertNotLogged({ level: 'log', context: 'UsersService' });
  });
});
```

In the probe the carrier fake failed its first three calls (`CARRIER_FAILS=3` in the same `test.env`), so the run was silent and both tests passed. `mentions()` walks the values a record prints instead of `JSON.stringify(entry.args)`, which serializes an `Error` as `{}` and throws on a cycle. `ConsoleLogger` prints an error's `cause`, so the walk follows it: `new Error('outer', { cause: new Error('token hunter2') })` and an `AggregateError` holding `new Error('pw hunter2')` each failed `assertNotLogged(mentions('hunter2'))` with `1 matched`, and a self-referencing params object and error passed without throwing.

Reference: [NestJS Testing](https://docs.nestjs.com/fundamentals/testing)

---

## References

- https://docs.nestjs.com
- https://github.com/nestjs/nest
- https://typeorm.io
- https://github.com/typestack/class-validator
- https://github.com/goldbergyoni/nodebestpractices

---

*Generated by build-agents.ts on 2026-10-30*
