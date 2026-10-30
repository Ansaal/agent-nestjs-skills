---
title: Silence the App Logger in Tests and Assert Logs with CapturingLogger
impact: MEDIUM
impactDescription: Expected failures printed as errors in green runs; log levels left untested
tags: logging, testing, vitest, capturinglogger, nest-log-level, e2e
---

## Silence the App Logger in Tests and Assert Logs with CapturingLogger

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
