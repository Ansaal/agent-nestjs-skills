---
title: Issue and Verify Short-Lived JWT Access Tokens
impact: CRITICAL
impactDescription: Forged, stale or over-privileged tokens accepted
tags: security, jwt, authentication, tokens, passport
---

## Issue and Verify Short-Lived JWT Access Tokens

Use `@nestjs/jwt` to sign access tokens and `@nestjs/passport` with `passport-jwt` to verify them. Read every required setting with `ConfigService.getOrThrow()`, so a missing secret stops the app at startup instead of failing at the first `sign()`; `get()` returns `undefined`, and an `undefined` issuer or audience silently turns that check off. Keep tokens short-lived and the payload to identifiers. `JwtStrategy.validate()` loads the user on every request, so deactivation, demotion and "sign out everywhere" take effect immediately. This rule covers access tokens only. Refresh tokens need their own atomic rotation contract (hashed one-time secrets, expiry and revocation checks, single-use replacement, family revocation on reuse); a `save()` of a hashed random string is not one, so don't issue refresh tokens until you implement that contract in full.

**Incorrect (hardcoded secret, sensitive payload, no user check):**

```typescript
@Module({
  imports: [
    JwtModule.register({
      secret: 'my-secret-key', // Exposed in code
      signOptions: { expiresIn: '7d' }, // Too long
    }),
  ],
})
export class AuthModule {}

async login(user: User): Promise<{ accessToken: string }> {
  const payload = {
    sub: user.id,
    email: user.email, // personal data, readable by anyone holding the token
    roles: user.roles, // stays valid after the user is demoted
  };
  return { accessToken: this.jwtService.sign(payload) };
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.get('JWT_SECRET'), // undefined when unset; issuer/audience never checked
    });
  }

  async validate(payload: any): Promise<any> {
    return payload; // No validation of user existence
  }
}
```

**Correct (validated settings, identifier-only payload, user loaded per request):**

```typescript
// auth/auth.module.ts
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { UsersModule } from '../users/users.module.js';
import { AuthService } from './auth.service.js';
import { JwtStrategy } from './jwt.strategy.js';

@Module({
  imports: [
    UsersModule,
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService], // ConfigModule.forRoot({ isGlobal: true }) in AppModule
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: {
          algorithm: 'HS256',
          expiresIn: '15m', // Short-lived access tokens
          issuer: config.getOrThrow<string>('JWT_ISSUER'),
          audience: config.getOrThrow<string>('JWT_AUDIENCE'),
        },
      }),
    }),
  ],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
```

```typescript
// auth/auth.service.ts
/** Identifiers only: no roles, no personal data. Roles are read from the database per request. */
export interface AccessTokenPayload {
  sub: string;
  ver: number;
}

@Injectable()
export class AuthService {
  constructor(private readonly jwt: JwtService) {}

  /** Call only after the credentials have been verified. */
  async issueAccessToken(user: User): Promise<{ accessToken: string; expiresIn: number }> {
    const payload: AccessTokenPayload = { sub: user.id, ver: user.tokenVersion };
    return { accessToken: await this.jwt.signAsync(payload), expiresIn: 900 };
  }
}
```

```typescript
// users/users.repository.ts (arch-use-repository-pattern): the read that authorizes
/** Committed state only: waits behind an open transaction instead of reading its uncommitted rows. */
findCommittedById(id: string): Promise<User | null> {
  return this.transactions.run((manager) => manager.findOneBy(User, { id }));
}
```

```typescript
// auth/jwt.strategy.ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UsersRepository } from '../users/users.repository.js';
import type { AccessTokenPayload } from './auth.service.js';
import type { AuthenticatedUser } from './authenticated-request.js';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly users: UsersRepository,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
      issuer: config.getOrThrow<string>('JWT_ISSUER'),
      audience: config.getOrThrow<string>('JWT_AUDIENCE'),
      algorithms: ['HS256'],
    });
  }

  /** Runs after the signature and expiry check; its return value becomes request.user. */
  async validate(payload: AccessTokenPayload): Promise<AuthenticatedUser> {
    // Committed read: a role change inside another request's open transaction is not visible until it commits
    const user = await this.users.findCommittedById(payload.sub);
    // Deleted, deactivated, or signed out everywhere (tokenVersion bumped) since the token was issued
    if (!user?.isActive || user.tokenVersion !== payload.ver) throw new UnauthorizedException();
    return { id: user.id, roles: user.roles, plan: user.plan };
  }
}
```

Without `JWT_SECRET`, `main.ts` stopped during `NestFactory.create` with `{"level":"error",…,"message":"Configuration key \"JWT_SECRET\" does not exist","context":"ExceptionHandler",…}` and exit code 1. `validate()` decides authorization, so it reads through `TransactionRunner.run()` (`nestjs-typeorm` rule `orm-atomic-writes`): a plain repository read on better-sqlite3 runs inside whatever transaction is open on the shared connection. In the probe, a member's token called an `@Roles(['admin'])` route while another transaction had set the user's roles to `['admin']` and then rolled back: with `findById` the request answered 200, with `findCommittedById` it waited for the rollback and answered 403. `tokenVersion` is an integer column incremented on password change, "sign out everywhere" and account recovery; comparing it is exact, where comparing `iat` (whole seconds) with a password-change timestamp misjudges tokens issued in the same second. `AuthenticatedUser` and the global `JwtAuthGuard` that runs this strategy are in `security-use-guards`. Secrets come from the environment or a secret manager, never from source; for HS256 use at least 32 random bytes.

Reference: [NestJS Authentication: Passport JWT](https://docs.nestjs.com/recipes/passport#implementing-passport-jwt), [OWASP JSON Web Token Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_for_Java_Cheat_Sheet.html)
