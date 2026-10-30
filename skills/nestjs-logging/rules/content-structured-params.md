---
title: Fixed Message, Fields in One Params Object
impact: HIGH
impactDescription: Lines that cannot be filtered or grouped by field; values that escape redaction
tags: logging, structured-logging, json, params
---

## Fixed Message, Fields in One Params Object

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
