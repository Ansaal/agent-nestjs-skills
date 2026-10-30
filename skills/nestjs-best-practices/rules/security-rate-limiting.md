---
title: Implement Rate Limiting
impact: HIGH
impactDescription: Protects against abuse and ensures fair resource usage
tags: security, rate-limiting, throttler, protection
---

## Implement Rate Limiting

Use `@nestjs/throttler` to limit request rates per client, stricter on credential and email-sending endpoints than on reads. In `@nestjs/throttler` 6, per-user limits are configuration, not guard overrides: `limit` and `ttl` accept a function of the `ExecutionContext`, and `getTracker` decides who is counted. `ThrottlerGuard` has no `getLimit()` hook: in the probe, a subclass `getLimit()` returning 1000 was called 0 times, and the fourth request against the configured limit of 3 answered 429. Counting per user needs `request.user`, so the throttler guard runs after the authentication guard. The default storage is in-process memory: with several instances, every instance counts separately; use a shared storage (Redis) there.

**Incorrect (no limits on sensitive endpoints; a limit hook that doesn't exist):**

```typescript
@Controller('auth')
export class AuthController {
  @Post('login')
  login(@Body() dto: LoginDto): Promise<TokenResponse> {
    return this.authService.login(dto); // Attackers can brute-force credentials
  }
}

@Injectable()
export class CustomThrottlerGuard extends ThrottlerGuard {
  protected async getLimit(context: ExecutionContext): Promise<number> {
    return context.switchToHttp().getRequest().user?.isPremium ? 1000 : 200; // never called
  }
}
```

**Correct (resolvable limit and tracker, guard after authentication):**

```typescript
// auth/throttling.ts
import type { ExecutionContext } from '@nestjs/common';
import type { AuthenticatedRequest } from './authenticated-request.js';

const requestOf = (context: ExecutionContext) => context.switchToHttp().getRequest<AuthenticatedRequest>();

/** Requests per minute: premium accounts 1000, other accounts 200, anonymous callers 50. */
export function limitFor(context: ExecutionContext): number {
  const { user } = requestOf(context);
  if (!user) return 50;
  return user.plan === 'premium' ? 1000 : 200;
}

/** Signed-in callers are counted per account, anonymous callers per IP. */
export function trackerFor(_req: Record<string, unknown>, context: ExecutionContext): string {
  const request = requestOf(context);
  return request.user ? `user:${request.user.id}` : `ip:${request.ip}`;
}
```

```typescript
// app.module.ts
@Module({
  imports: [
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: limitFor }],
      getTracker: trackerFor,
    }),
  ],
  providers: [
    // Global guards run in this order: authenticate, authorize, then throttle per account
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}

// Stricter limits per endpoint
@Controller('auth')
export class AuthController {
  @Public()
  @Post('login')
  @Throttle({ default: { limit: 5, ttl: 60_000 } }) // 5 attempts per minute
  login(@Body() dto: LoginDto): Promise<TokenResponse> {
    return this.authService.login(dto);
  }

  @Public()
  @Post('forgot-password')
  @Throttle({ default: { limit: 3, ttl: 3_600_000 } }) // 3 per hour
  forgotPassword(@Body() dto: ForgotPasswordDto): Promise<void> {
    return this.authService.sendResetEmail(dto.email);
  }
}

// No throttling for probes
@Controller('health')
export class HealthController {
  @Public()
  @SkipThrottle()
  @Get()
  check(): { status: string } {
    return { status: 'ok' };
  }
}
```

With `@nestjs/throttler` 6.7.1, the sixth `POST /auth/login` within a minute answered 429; an anonymous `GET` route answered 200 for the 50th request and 429 for the 51st, while a signed-in member made 60 requests to an authenticated route with no 429 and got `X-RateLimit-Limit: 200`. `@SkipThrottle()` `GET /health` never answered 429. Counters are per route and tracker. Behind a reverse proxy, `request.ip` is the proxy's address unless Express's `trust proxy` is set to the proxy hop count in `configureApp()`; without it every anonymous caller shares one counter. A per-IP login limit slows credential stuffing only partly; also count failed attempts per account in the login service. `AuthenticatedRequest`, `JwtAuthGuard` and `@Public()` are in `security-use-guards`.

Reference: [NestJS Throttler](https://docs.nestjs.com/security/rate-limiting)
