---
name: nestjs-logging
description: Logging in NestJS with the built-in `ConsoleLogger` in JSON mode. Use when setting up the app logger or log levels, adding `Logger` calls to a class, choosing a level (error, warn, log, debug, verbose), logging errors, retries or payloads, keeping secrets and personal data out of logs, adding a request id to log lines, or silencing and asserting logs in tests.
license: MIT
metadata:
  author: Ansaal
  version: "1.0.0"
---

# NestJS Logging

How a Nest app logs: one `ConsoleLogger` with `json: true` passed to `NestFactory.create()`, levels set by `NEST_LOG_LEVEL`, a `new Logger(ClassName.name)` per class, one level policy for every line, fields in a params object, errors passed as objects, no secrets or personal data, a request id from `AsyncLocalStorage`, and silent test runs that assert logs with `CapturingLogger`. No logging library is needed. Verified 2026-10-29 against NestJS 12.3.2 (@nestjs/common, @nestjs/core, @nestjs/testing, @nestjs/platform-express), @nestjs/resilience 0.0.3, Vitest 5.0.5, TypeScript 6.0.3 on Node 24.22.2.

Project setup and the Vitest config are `nestjs-setup`; test structure and the e2e helper are `nestjs-testing`; retries, circuit breakers and dead letters are `nestjs-resilience`; outbound HTTP is `nestjs-http-client`; scheduled jobs are `nestjs-schedule`; locks are `nestjs-locks`. Their examples follow the level policy here.

## Rules

| Prefix | Section | Impact |
|--------|---------|--------|
| `setup-` | Logger Setup | HIGH |
| `level-` | Log Levels | HIGH |
| `content-` | Log Content | HIGH |
| `test-` | Logs in Tests | MEDIUM |

### 1. Logger Setup (HIGH)

- `setup-json-console-logger` - One `new ConsoleLogger({ json: true, redact })` passed to `NestFactory.create()`, never `bufferLogs`/`useLogger`; levels from `NEST_LOG_LEVEL`, `.env` loaded with `process.loadEnvFile()` before `main.ts` defaults it to `log`; process handlers registered before `create()` call the same instance as `fatal('…', { source: 'process' }, err)` and exit 1
- `setup-logger-per-class` - `private readonly logger = new Logger(ClassName.name)`; never `console.*`, an ad-hoc `ConsoleLogger` or an injected one
- `setup-request-id` - `AsyncLocalStorage` middleware on `forRoutes('{*path}')` (so `/` too) plus a `ConsoleLogger` subclass add `requestId` to every record

### 2. Log Levels (HIGH)

- `level-policy` - error/fatal: failed for good; warn: degraded but handled; log: events beyond one request, kept small; debug: per-request flow; verbose: data
- `level-retry-warn-final-error` - Retries and breaker changes at `warn` from `ResilienceEvents`, the error as third argument; the final failure once at `error` with the error, or `log` when a dead letter records it

### 3. Log Content (HIGH)

- `content-structured-params` - Fixed message plus one params object; no interpolated data, no object as the message
- `content-errors-as-objects` - Pass the caught error, not `.stack` or `String(error)`; log where it is handled last
- `content-no-secrets-or-pii` - Identifiers only, at every level; `redact` masks keys but never strings, error messages or stacks

### 4. Logs in Tests (MEDIUM)

- `test-quiet-and-capture` - `NEST_LOG_LEVEL: 'fatal'` in the Vitest env; a `CapturingLogger` passed to `createTestApp(override, { logger })` to assert levels and content, searching error messages and stacks for secrets

Read `rules/<id>.md` for the rule's reasoning and examples.
