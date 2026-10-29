---
name: nestjs-resilience
description: Resilience for NestJS calls to downstream dependencies with `@nestjs/resilience` and `@nestjs/idempotency`. Use when adding retries, timeouts, circuit breakers or fallbacks, handling calls that still fail after retries, calling a dependency after a database write, or deduplicating client retries and webhook redeliveries.
license: MIT
metadata:
  author: Ansaal
  version: "1.0.0"
---

# NestJS Resilience

How a Nest app calls slow or failing dependencies: one `@nestjs/resilience` preset per dependency, decorators on entrypoints, policy objects in services, a dead-letter record for every call that exhausts its retries, downstream calls dispatched after commit, and the right deduplication for each kind of duplicate request. Verified 2026-10-29 against NestJS 12.3.2, @nestjs/resilience 0.0.3, @nestjs/idempotency 0.0.3, TypeORM 1.1.2 with better-sqlite3 12.11.1, Vitest 5.0.5.

Project setup (ESM, SWC, Vitest) is `nestjs-setup`; transactions, migrations and unique-violation handling are `nestjs-typeorm`; tests with fake dependencies and fake timers are `nestjs-testing`.

## Rules
| Prefix | Section | Impact |
|--------|---------|--------|
| `resilience-` | Resilience Policies | CRITICAL |
| `dlq-` | Dead Letters | HIGH |
| `idempotency-` | Idempotency | HIGH |

### 1. Resilience Policies (CRITICAL)

- `resilience-module-presets` - Pin the package; register `ResilienceModule` once with one preset per dependency; `attempts` counts the first call; 4xx errors are not retried
- `resilience-entrypoint-decorators` - Resilience decorators go on controller, resolver and message handlers; a retried POST needs `@Retry({ idempotent: true })`
- `resilience-service-policy` - Services call dependencies through a policy object created once, passing the attempt's `signal`; retry only repeat-safe calls, at one layer
- `resilience-dispatch-after-commit` - Call downstream dependencies after the transaction commits, and answer without waiting when the contract allows it

### 2. Dead Letters (HIGH)

- `dlq-record-final-failure` - Record every call that exhausts its retries in an injectable dead-letter store; log retries from `ResilienceEvents.events$`

### 3. Idempotency (HIGH)

- `idempotency-client-keys` - `@Idempotent()` for client-facing mutations and for webhooks whose duplicates may get the first response replayed
- `idempotency-processed-events` - A processed-events row in the state-change transaction when the contract defines its own duplicate response

Read `rules/<id>.md` for the rule's reasoning and examples.
