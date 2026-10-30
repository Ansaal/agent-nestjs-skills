---
title: Use ConfigModule for Environment Configuration
impact: LOW-MEDIUM
impactDescription: Proper configuration prevents deployment failures
tags: devops, configuration, environment, validation
---

## Use ConfigModule for Environment Configuration

Read configuration through `@nestjs/config`, validate every variable once at startup, and give consumers typed access that cannot return `undefined`. Scattered `process.env` reads fail late (`parseInt(undefined)` is `NaN`, a typo is `undefined`) and differ between services. An untyped `ConfigService.get<number>('app.port')` is `number | undefined` under `strict`, so returning it as `number` does not compile, and casting it away moves the failure to runtime. Database settings are not part of this rule: TypeORM reads them in the one `src/data-source.ts` shared by the CLI and `forRootAsync` (`nestjs-typeorm` rule `orm-single-data-source`); a second inline `TypeOrmModule.forRootAsync({ type: 'postgres', … })` here would drift from what migrations run against.

**Incorrect (direct env access; untyped getters):**

```typescript
@Injectable()
export class MailService {
  private readonly apiKey = process.env.MAIL_API_KEY || 'default'; // a typo or a missing variable goes unnoticed
}

@Injectable()
export class AppService {
  constructor(private readonly config: ConfigService) {}

  getPort(): number {
    return this.config.get<number>('app.port'); // TS2322: Type 'number | undefined' is not assignable to type 'number'
  }
}
```

**Correct (`config/env.validation.ts`):**

```typescript
import Joi from 'joi';

/** Every variable the app reads, as the validated (converted, defaulted) values. */
export interface Env {
  NODE_ENV: 'development' | 'production' | 'test';
  PORT: number;
  REDIS_URL: string;
  JWT_SECRET: string;
  MAIL_API_KEY: string;
  MAIL_FROM: string;
  SHUTDOWN_DRAIN_MS: number;
}

export const envSchema = Joi.object<Env, true>({
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  PORT: Joi.number().port().default(3000),
  REDIS_URL: Joi.string().uri({ scheme: ['redis', 'rediss'] }).required(),
  JWT_SECRET: Joi.string().min(32).required(),
  MAIL_API_KEY: Joi.string().required(),
  MAIL_FROM: Joi.string().email().required(),
  SHUTDOWN_DRAIN_MS: Joi.number().integer().min(0).default(10_000), // micro-use-health-checks
});
```

**Correct (`config/mail.config.ts`):**

```typescript
import { registerAs } from '@nestjs/config';

/** Namespaced settings for one feature; runs after validation, so the variables are present. */
export const mailConfig = registerAs('mail', () => ({
  apiKey: process.env.MAIL_API_KEY ?? '',
  from: process.env.MAIL_FROM ?? '',
}));
```

**Correct (`app.module.ts`):**

```typescript
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { envSchema } from './config/env.validation.js';
import { mailConfig } from './config/mail.config.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [mailConfig],
      validationSchema: envSchema,
    }),
  ],
})
export class AppModule {}
```

**Correct (typed access):**

```typescript
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService, type ConfigType } from '@nestjs/config';
import type { Env } from '../config/env.validation.js';
import { mailConfig } from '../config/mail.config.js';

@Injectable()
export class TokenService {
  // `true`: the schema guarantees every key, so get() returns Env[K], never undefined
  constructor(private readonly config: ConfigService<Env, true>) {}

  secret(): string {
    return this.config.get('JWT_SECRET', { infer: true });
  }

  port(): number {
    return this.config.get('PORT', { infer: true });
  }
}

@Injectable()
export class MailService {
  constructor(@Inject(mailConfig.KEY) private readonly mail: ConfigType<typeof mailConfig>) {}

  sender(): string {
    return this.mail.from;
  }
}
```

`@nestjs/config` 12.0.1 validates `validationSchema` through Standard Schema and defaults Joi to `abortEarly: false, allowUnknown: true`, so one start reports every problem; Joi 18.3.1 implements the interface. `ConfigModule.forRoot()` is async and runs when `AppModule` is imported, so `main.ts` fails before `NestFactory.create` resolves. With four bad variables the probe failed with `Config validation error: REDIS_URL: "REDIS_URL" must be a valid uri with a scheme matching the redis|rediss pattern` followed by one line each for `JWT_SECRET` (too short), `MAIL_API_KEY` and `MAIL_FROM` (required). With valid values and no `PORT`, `config.get('PORT', { infer: true })` returned the number `3000` (the validated, converted value; `process.env.PORT` stays a string), and the injected `mailConfig` returned `noreply@example.com`. The `?? ''` in `mailConfig` only satisfies the compiler; validation has already guaranteed both variables. Secrets come from the environment or a secret store, never from committed `.env` files.

Reference: [NestJS Configuration](https://docs.nestjs.com/techniques/configuration)
