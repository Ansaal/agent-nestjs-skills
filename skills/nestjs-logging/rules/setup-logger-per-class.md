---
title: Give Each Class a `new Logger(ClassName.name)`
impact: HIGH
impactDescription: Lines that skip the app's JSON format, level threshold and masking
tags: logging, logger, context, console
---

## Give Each Class a `new Logger(ClassName.name)`

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
