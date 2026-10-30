---
title: Park Timers in Tests and Call the Job's Work Method
impact: HIGH
impactDescription: Jobs started by app.init() fire mid-test against the test's data; waiting for a tick makes tests slow and flaky
tags: schedule, testing, vitest, e2e, interval, environment
---

## Park Timers in Tests and Call the Job's Work Method

`app.init()` in an e2e test arms every job (`lifecycle-register-once`). A 5 s poll then fires inside a slow test and processes rows the test has not finished arranging, or races the test's own call. Sleeping until the timer fires is slower still and fails on a loaded CI machine.

Give each env-driven delay a `<JOB>_POLL_MS` test value in `test.env` that no test outlives (`3600000`, one hour; at most 2 147 483 647, see `job-delay-from-env`). `test.env` is applied before the test files import the app; `process.env` assignments in the test file or in `beforeAll` come too late, because the delay was read at import. Then call the job's work method directly and await what it returns (`job-thin-entrypoint`). A cron at a fixed hour such as 02:00 Berlin does not need parking; a seconds-level `CronExpression` does: read its expression from the environment the same way.

The one `vitest.config.ts`, with the keys other skills add, is `nestjs-setup`; booting `AppModule` through `createTestApp()` is `nestjs-testing`.

**Incorrect (waits for the real timer; races it if the poll is short):**

```typescript
it('processes received batches', async () => {
  await batches.save([{ id: 'b-1' }, { id: 'b-2' }]);
  await new Promise((resolve) => setTimeout(resolve, 6_000)); // one 5 s tick, hopefully
  expect(await batches.findBy({ status: 'PROCESSED' })).toHaveLength(2);
}, 10_000);
```

**Correct (the key this skill adds to `test.env` in `vitest.config.ts`, one per env-driven timer):**

```typescript
// The batch interval is armed by app.init() but never fires during a test.
BATCH_POLL_MS: '3600000',
```

**Correct (`test/batches.e2e-spec.ts`: the test runs the work itself):**

```typescript
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DataSource, type Repository } from 'typeorm';
import { BatchHandler } from '../src/batches/batch-handler.js';
import { Batch } from '../src/batches/batch.entity.js';
import { BatchProcessor } from '../src/batches/batch.processor.js';
import { TransactionRunner } from '../src/database/transaction-runner.js';
import { createTestApp } from './support/test-app.js';

describe('Process pending batches', () => {
  let app: NestExpressApplication;
  let batches: Repository<Batch>;

  beforeEach(async () => {
    app = await createTestApp(); // arms 'batches:process' at BATCH_POLL_MS=3600000: it never fires here
    batches = app.get(DataSource).getRepository(Batch);
    return () => app.close(); // stops the interval
  });

  const arrange = (...ids: string[]) =>
    app.get(TransactionRunner).run((manager) => manager.insert(Batch, ids.map((id) => ({ id }))));
  // The test runs the work itself instead of waiting for the timer.
  const processPending = () => app.get(BatchProcessor).processPending();

  it('marks every received batch processed', async () => {
    await arrange('b-1', 'b-2');

    await expect(processPending()).resolves.toBe(2);

    expect(await batches.findBy({ status: 'PROCESSED' })).toHaveLength(2);
  });

  it('does nothing on an empty tick', async () => {
    await expect(processPending()).resolves.toBe(0);
  });

  it('retries a failed batch on the next run and gives up after the third attempt', async () => {
    await arrange('b-ok', 'b-bad');
    app.get(BatchHandler).failIds.add('b-bad');

    await expect(processPending()).resolves.toBe(1);
    await processPending();
    await processPending();

    expect(await batches.findOneByOrFail({ id: 'b-bad' })).toMatchObject({ status: 'FAILED', attempts: 3 });
    expect(await batches.findOneByOrFail({ id: 'b-ok' })).toMatchObject({ status: 'PROCESSED', attempts: 1 });
  });
});
```

`BatchHandler` here is the probe's stand-in with a `failIds` set; in a real suite, replace the outbound dependency with `overrideProvider()` as `nestjs-testing` describes. That the timer itself is wired to `processPending()` is checked once, with fake timers (`test-schedule-and-wiring`).

Reference: [Vitest – test.env](https://vitest.dev/config/#env), [NestJS – Testing](https://docs.nestjs.com/fundamentals/testing)
