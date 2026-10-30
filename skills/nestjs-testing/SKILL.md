---
name: nestjs-testing
description: Testing NestJS apps with Vitest and `@nestjs/testing`. Use when writing unit tests for a provider or controller, e2e tests over HTTP with Supertest (`createTestApp()`, `configureApp()`, per-test database isolation), tests for work that finishes after the response, or tests that exercise existing retry/backoff behaviour on fake timers. To design or configure the retry policy itself, load `nestjs-resilience`.
license: MIT
metadata:
  author: Ansaal
  version: "1.0.0"
---

# NestJS Testing

How to test a Nest app. A unit test compiles one provider and lets `useMocker()` mock every dependency. An e2e test boots the real `AppModule` over HTTP through `createTestApp()`, one app and one fresh database per test, and fakes only what leaves the process. Time-dependent and fire-and-forget code runs on fake timers and awaitables, never on sleeps. Verified 2026-10-29 against NestJS 12.3.2 (@nestjs/testing 12.3.2), Vitest 5.0.5, supertest 7.3.1, @nestjs/resilience 0.0.3, TypeORM 1.1.2 with better-sqlite3 12.11.1, class-validator 0.15.1, ESLint 10.13.0 with typescript-eslint 8.72.1, on Node 24.22.2.

Vitest configuration (unplugin-swc, `include` globs, the one `test.env`) and the lint config are `nestjs-setup`. The test database settings (`:memory:`, migrations, `retryAttempts: 0`) are `nestjs-typeorm`. Retry presets and dead letters are `nestjs-resilience`. Other skills extend the e2e boot through `createTestApp(override, options)` instead of building their own app.

## Rules
| Prefix | Section | Impact |
|--------|---------|--------|
| `unit-` | Unit Tests | HIGH |
| `e2e-` | E2E Tests | CRITICAL |
| `async-` | Time and Async Work | MEDIUM-HIGH |

### 1. Unit Tests (HIGH)

- `unit-automock-dependencies` - One provider per testing module; `useMocker(autoMock)` from `test/auto-mock.ts`; typed mocks via `vi.mocked(moduleRef.get(Dep))`
- `unit-specific-doubles` - Match the token for non-class tokens and chained return values; delegate every other token to `autoMock`
- `unit-scoped-providers` - `resolve()` for request/transient-scoped providers; `REQUEST`/`INQUIRER` through `overrideProvider()`

### 2. E2E Tests (CRITICAL)

- `e2e-real-app-module` - `test/*.e2e-spec.ts` boots `AppModule` through `test/support/test-app.ts` `createTestApp(override?, { logger? })`, which closes an app whose boot fails, one app per test (`beforeEach` returns `() => app.close()`), overrides only outbound boundaries, default-import `supertest`
- `e2e-global-enhancers-as-providers` - Global pipes, filters, interceptors and guards as `APP_*` providers; shared settings in `configureApp(app: NestExpressApplication)`; `enableShutdownHooks()` and body limits are not shared defaults

### 3. Time and Async Work (MEDIUM-HIGH)

- `async-fake-timers` - Retry backoff runs on `vi.useFakeTimers({ toFake: [...] })` + `vi.advanceTimersByTimeAsync()`, not on real time
- `async-drain-side-effects` - Work that finishes after the response exposes `drain()`; the test awaits it

Read `rules/<id>.md` for the rule's reasoning and examples.
