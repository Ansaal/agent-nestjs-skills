---
title: Never Log Secrets or Personal Data; redact Is Only the Safety Net
impact: CRITICAL
impactDescription: Passwords, tokens and personal data copied into log storage with wide access and long retention
tags: logging, security, pii, secrets, redact, gdpr
---

## Never Log Secrets or Personal Data; redact Is Only the Safety Net

Logs are shipped, indexed, retained for months and readable by far more people than the database, so a secret or personal datum written once has leaked. That holds at every level: a `verbose` payload dump enabled for one afternoon is as permanent as an `error`. Log identifiers (`userId`, `orderId`), counts and outcomes, not the email, name, address, password, token, card or request body they belong to. `ConsoleLogger`'s `redact` option (`setup-json-console-logger`) masks listed keys at any depth, case-insensitively, in params and logged objects, without mutating them. It cannot mask what it cannot see: string messages, an error's message and its stack are written as they are, and personal data under a key not on the list (`email`) passes. The probe, with `redact: ['password', 'token', 'authorization', 'cookie']`:

```text
logger.debug('Login attempt', { email: 'ann@example.com', password: 'hunter2' })
{"level":"debug",...,"message":"Login attempt","context":"AuthService","params":{"email":"ann@example.com","password":"[REDACTED]"}}

logger.verbose('Outbound request', { headers: { Authorization: 'Bearer abc', accept: 'json' }, body: { user: { password: 'x', name: 'Ann' } } })
{"level":"verbose",...,"message":"Outbound request","context":"AuthService","params":{"headers":{"Authorization":"[REDACTED]","accept":"json"},"body":{"user":{"password":"[REDACTED]","name":"Ann"}}}}

logger.debug(`Login attempt with password hunter2`)
{"level":"debug",...,"message":"Login attempt with password hunter2","context":"AuthService"}

logger.error('Login failed', Object.assign(new Error('token abc rejected'), { token: 'abc' }))
{"level":"error",...,"message":"Login failed","context":"AuthService","error":{"name":"Error","message":"token abc rejected","stack":"Error: token abc rejected\n    at ...","token":"[REDACTED]"}}
```

**Incorrect (request body, email and credentials logged):**

```typescript
this.logger.verbose('Create user payload', { body: input }); // email, name; password only masked by luck of the key name
this.logger.debug(`Login attempt for ${email} with token ${token}`); // string message: never redacted
```

**Correct (identifiers only; redact configured as the net):**

```typescript
// users.service.ts
this.logger.debug('Creating user');
// ...
this.logger.debug('User created', { userId: user.id });

// main.ts
logger: new ConsoleLogger({ json: true, redact: ['password', 'token', 'authorization', 'cookie'] }),
```

An e2e test can assert that nothing a request carried reached the log with a `CapturingLogger`: `logs.assertNotLogged(mentions('hunter2'))`, where `mentions()` (`test-quiet-and-capture`) walks the message, params, stack and error, including its `cause` chain and `AggregateError.errors`. `JSON.stringify(entry.args)` is not enough: it serializes an `Error` as `{}`, so a secret inside an error message passed that check in the probe. Error messages built from input (`Invalid email ann@example.com`) carry the data into `error.message`; build them from identifiers too.

Reference: [OWASP Logging Cheat Sheet – Data to exclude](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html#data-to-exclude)
