---
name: nestjs-testing
description: Testing NestJS apps with Vitest and `@nestjs/testing`. Use when writing unit tests for a provider or controller, e2e tests over HTTP with Supertest, or tests for retries, backoff and work that finishes after the response.
license: MIT
metadata:
  author: Ansaal
  version: "1.0.0"
---

# NestJS Testing

How to test a Nest app. A unit test compiles one provider and lets `useMocker()` mock every dependency. An e2e test boots the real `AppModule` over HTTP and fakes only what leaves the process. Time-dependent and fire-and-forget code runs on fake timers and awaitables, never on sleeps. Verified 2026-10-29 against NestJS 12.3.2 (@nestjs/testing 12.3.2), Vitest 5.0.5, supertest 7.3.1, @nestjs/resilience 0.0.3, TypeORM 1.1.2 with better-sqlite3 12.11.1, class-validator 0.15.1 on Node 22.21.

Vitest configuration (unplugin-swc, `include` globs, test `env`) is `nestjs-setup`. The test database settings (`:memory:`, migrations, `retryAttempts: 0`) are `nestjs-typeorm`. Retry presets and dead letters are `nestjs-resilience`.

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

- `e2e-real-app-module` - `test/*.e2e-spec.ts` imports `AppModule`, overrides only outbound boundaries, `await app.init()`, `afterAll(() => app.close())`, default-import `supertest`
- `e2e-global-enhancers-as-providers` - Global pipes, filters, interceptors and guards as `APP_*` providers; other app settings in a shared `configureApp()`

### 3. Time and Async Work (MEDIUM-HIGH)

- `async-fake-timers` - Retry backoff runs on `vi.useFakeTimers({ toFake: [...] })` + `vi.advanceTimersByTimeAsync()`, not on real time
- `async-drain-side-effects` - Work that finishes after the response exposes `drain()`; the test awaits it

Read `rules/<id>.md` for the rule's reasoning and examples.
