---
name: nestjs-best-practices
description: General NestJS architecture, dependency injection, error handling, security (authentication, authorization, input validation, rate limiting), API design (serialization, versioning, pipes, interceptors), performance and microservice patterns. Use when designing modules and providers, securing endpoints, shaping API contracts, or reviewing NestJS code for those concerns. For persistence, tests, toolchain, outbound HTTP, retries and idempotency, scheduled jobs, locks or logging, load the owning skill listed under Related Skills instead.
license: MIT
metadata:
  author: Kadajett
  version: "1.2.0"
---

# NestJS Best Practices

Comprehensive best practices guide for NestJS applications. Contains 34 rules across 9 categories, prioritized by impact to guide automated refactoring and code generation.

Verified 2026-10-30 against NestJS 12.3.2, TypeORM 1.1.2 with better-sqlite3 12.11.1, class-validator 0.15.1, class-transformer 0.5.1, @nestjs/config 12.0.1 with joi 18.3.1, @nestjs/passport 12.0.0 with passport-jwt 4.0.1, @nestjs/jwt 12.0.3, @nestjs/throttler 6.7.1, @nestjs/event-emitter 12.0.1, @nestjs/cache-manager 12.0.2 with cache-manager 7.2.9 and @keyv/redis 6.1.0, @nestjs/terminus 12.1.0, @nestjs/microservices 12.3.2, @nestjs/bullmq 12.0.0 with bullmq 6.5.1, @bull-board 9.10.5, ioredis 6.0.0, stripe 23.0.1, sanitize-html 2.18.1, helmet 8.3.0 and Redis 8.10.2 on Node 24.22.2. Examples for packages not listed here are unverified.

## Related Skills

These skills own their topics. Load them for that work; where an example here touches their topic, the owner wins and this skill only points to it:

- `nestjs-fdd` - planning a feature or app as feature sets and Nest modules
- `nestjs-setup` - versions, Node, ESM, SWC, Vitest configuration, ESLint and Prettier
- `nestjs-testing` - unit tests with `useMocker()` auto-mocking, e2e tests with Supertest
- `nestjs-typeorm` - TypeORM data source, migrations, transactions
- `nestjs-resilience` - retries, timeouts, circuit breakers, idempotency, dead-letter handling
- `nestjs-http-client` - outbound HTTP with `@nestjs/http-client`: named clients, timeouts, typed errors
- `nestjs-schedule` - cron, interval and timeout jobs with `@nestjs/schedule`
- `nestjs-locks` - distributed locks and job exclusion with `@nestjs/locks`
- `nestjs-logging` - logger setup (ConsoleLogger JSON), log level policy, structured fields, errors, logs in tests

## When to Apply

Reference these guidelines when:

- Designing NestJS modules, providers and their boundaries
- Implementing authentication and authorization
- Shaping API contracts: DTOs, serialization, versioning, pipes, interceptors
- Reviewing code for architecture and security issues
- Optimizing performance (caching, lazy loading, query shape)
- Building microservice and queue-based architectures

## Rule Categories by Priority

| Priority | Category | Impact | Prefix |
|----------|----------|--------|--------|
| 1 | Architecture | CRITICAL | `arch-` |
| 2 | Dependency Injection | CRITICAL | `di-` |
| 3 | Error Handling | HIGH | `error-` |
| 4 | Security | HIGH | `security-` |
| 5 | Performance | HIGH | `perf-` |
| 6 | Database & ORM | MEDIUM-HIGH | `db-` |
| 7 | API Design | MEDIUM | `api-` |
| 8 | Microservices | MEDIUM | `micro-` |
| 9 | DevOps & Deployment | LOW-MEDIUM | `devops-` |

## Quick Reference

### 1. Architecture (CRITICAL)

- `arch-avoid-circular-deps` - Avoid circular module dependencies
- `arch-feature-modules` - Organize by feature, not technical layer
- `arch-module-sharing` - Proper module exports/imports, avoid duplicate providers
- `arch-single-responsibility` - Focused services; one workflow service; client checkout key with insert-or-ignore, idempotent charge, guarded `markPaid` so one attempt confirms
- `arch-use-repository-pattern` - Abstract database logic for testability
- `arch-use-events` - Best-effort `emit()` after commit; one required listener per `emitAsync` event (or sequential calls), or an outbox

### 2. Dependency Injection (CRITICAL)

- `di-avoid-service-locator` - Avoid service locator anti-pattern
- `di-interface-segregation` - Interface Segregation Principle (ISP)
- `di-liskov-substitution` - One documented `PaymentGateway` contract (orderId as idempotency key) that Stripe and the mock both pass, shared contract suite
- `di-prefer-constructor-injection` - Constructor over property injection
- `di-scope-awareness` - Understand singleton/request/transient scopes
- `di-use-interfaces-tokens` - Use injection tokens for interfaces

### 3. Error Handling (HIGH)

- `error-use-exception-filters` - Filters extend `BaseExceptionFilter` and keep `getResponse()`; catch-all listed first
- `error-throw-http-exceptions` - Use NestJS HTTP exceptions
- `error-handle-async-errors` - Handle async errors properly

### 4. Security (HIGH)

- `security-auth-jwt` - Short-lived access tokens, `getOrThrow` settings, committed user read per request; refresh tokens out of scope
- `security-validate-all-input` - Validate with class-validator
- `security-use-guards` - Authentication and authorization guards
- `security-sanitize-output` - Prevent XSS attacks
- `security-rate-limiting` - Throttler 6 resolvable `limit`/`getTracker`, throttle after authentication

### 5. Performance (HIGH)

- `perf-async-hooks` - Proper async lifecycle hooks
- `perf-use-caching` - URL/per-principal keys (async `trackBy`), generation stored in the database and bumped in the write's transaction
- `perf-optimize-database` - Optimize database queries
- `perf-lazy-loading` - Lazy load modules for faster startup

### 6. Database & ORM (MEDIUM-HIGH)

Transactions, migrations and the data source are owned by `nestjs-typeorm`.

- `db-avoid-n-plus-one` - Avoid N+1 query problems

### 7. API Design (MEDIUM)

- `api-use-dto-serialization` - DTO and response serialization
- `api-use-interceptors` - Cross-cutting concerns
- `api-versioning` - API versioning strategies
- `api-use-pipes` - Input transformation with pipes

### 8. Microservices (MEDIUM)

- `micro-use-patterns` - Message and event patterns
- `micro-use-health-checks` - Health checks for orchestration
- `micro-use-queues` - BullMQ mechanics; colon-free job ids; failed jobs kept until dead-lettered; digest-compared board auth

### 9. DevOps & Deployment (LOW-MEDIUM)

- `devops-use-config-module` - Environment configuration
- `devops-graceful-shutdown` - Zero-downtime deployments

## How to Use

Read individual rule files for detailed explanations and code examples:

```
rules/arch-avoid-circular-deps.md
rules/security-validate-all-input.md
rules/_sections.md
```

Each rule file contains:
- Brief explanation of why it matters
- Incorrect code example with explanation
- Correct code example with explanation
- Additional context and references

## Full Compiled Document

For the complete guide with all rules expanded in a single document, see
[compiled/nestjs-best-practices.md in the repository](https://github.com/Ansaal/agent-nestjs-skills/blob/main/compiled/nestjs-best-practices.md).
