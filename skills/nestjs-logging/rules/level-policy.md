---
title: Pick the Level by Who Has to Act on the Line
impact: HIGH
impactDescription: Production output drowned in per-request lines; alerts on handled conditions
tags: logging, log-levels, debug, verbose, policy
---

## Pick the Level by Who Has to Act on the Line

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
