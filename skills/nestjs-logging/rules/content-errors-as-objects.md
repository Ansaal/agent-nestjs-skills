---
title: Pass the Error Object, Not Its Stack or Message
impact: HIGH
impactDescription: Error records without the error's name, code, status or cause
tags: logging, errors, stack-trace, json
---

## Pass the Error Object, Not Its Stack or Message

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
