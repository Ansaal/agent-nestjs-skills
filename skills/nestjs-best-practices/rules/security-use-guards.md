---
title: Use Guards for Authentication and Authorization
impact: HIGH
impactDescription: Enforces access control before handlers execute
tags: security, guards, authentication, authorization, passport
---

## Use Guards for Authentication and Authorization

Guards decide whether a request reaches its handler. They run after middleware and before interceptors and pipes, which makes them the place for access control. Authenticate with Passport's `AuthGuard('jwt')`, so `JwtStrategy.validate()` (`security-auth-jwt`) loads the current user from the database on every request, and authorize from that server-side user. Roles copied into a token stay valid for the token's lifetime after the user is demoted or deactivated.

**Incorrect (manual checks; or a guard that trusts the token's claims):**

```typescript
// Manual auth checks in every handler
@Controller('admin')
export class AdminController {
  @Get('users')
  async getUsers(@Request() req) {
    if (!req.user) throw new UnauthorizedException();
    if (!req.user.roles.includes('admin')) throw new ForbiddenException();
    return this.adminService.getUsers();
  }
}

// Verified payload used as the user: roles come from the token, the user is never looked up
@Injectable()
export class JwtAuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    request.user = await this.jwtService.verifyAsync(extractBearer(request)); // { sub, roles: ['admin'] }
    return true;
  }
}
```

**Correct (Passport guard, roles from the database user, declarative decorators):**

```typescript
// auth/authenticated-request.ts
import type { Request } from 'express';
import type { Role } from '../users/user.entity.js';

/** What JwtStrategy.validate() puts on request.user: loaded from the database on every request. */
export interface AuthenticatedUser {
  id: string;
  roles: Role[];
  plan: 'free' | 'premium';
}

export type AuthenticatedRequest = Request & { user?: AuthenticatedUser };
```

```typescript
// auth/public.decorator.ts, auth/roles.decorator.ts, auth/current-user.decorator.ts
export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const Roles = Reflector.createDecorator<Role[]>();

/** The user JwtStrategy.validate() loaded for this request. */
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): AuthenticatedUser => {
  const { user } = context.switchToHttp().getRequest<AuthenticatedRequest>();
  if (!user) throw new UnauthorizedException(); // only reachable on a @Public() route
  return user;
});
```

```typescript
// auth/jwt-auth.guard.ts
import { type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC } from './public.decorator.js';

/** Authenticates through JwtStrategy, so request.user is the current database user. */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  override canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    return isPublic || super.canActivate(context);
  }
}

// auth/roles.guard.ts
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride(Roles, [context.getHandler(), context.getClass()]);
    if (!required?.length) return true;
    const { user } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    return !!user && required.some((role) => user.roles.includes(role));
  }
}
```

```typescript
// app.module.ts providers: global guards run in the order listed
{ provide: APP_GUARD, useClass: JwtAuthGuard },
{ provide: APP_GUARD, useClass: RolesGuard },

// admin/admin.controller.ts
@Controller('admin')
@Roles(['admin']) // Applied to all routes
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('users')
  getUsers(): Promise<User[]> {
    return this.adminService.getUsers();
  }

  @Delete('users/:id')
  deleteUser(@CurrentUser() admin: AuthenticatedUser, @Param() params: UserIdParamDto): Promise<void> {
    return this.adminService.deleteUser(params.id, admin.id);
  }
}

@Controller('health')
export class HealthController {
  @Public() // no authentication
  @Get()
  check(): { status: string } {
    return { status: 'ok' };
  }
}
```

Every route is authenticated unless marked `@Public()`. In the probe, a token issued while the user was `admin` read `GET /admin/users` with 200; after the database row was changed to `['member']`, the same unexpired token answered `403 {"message":"Forbidden resource",…}`, and after `isActive = false` or a `tokenVersion` bump it answered 401. Without a token the route answered 401 and `@Public()` `GET /health` 200. `RolesGuard` covers coarse roles; access to a specific resource (is this the order's owner?) is checked in the service against the stored row. `PassportModule`, `JwtStrategy` and the token payload are in `security-auth-jwt`; the throttler guard goes after these two (`security-rate-limiting`). To replace a global guard in a test, register it with `useExisting` (`nestjs-testing` rule `e2e-global-enhancers-as-providers`).

Reference: [NestJS Authentication: Enable authentication globally](https://docs.nestjs.com/recipes/passport#enable-authentication-globally), [NestJS Guards](https://docs.nestjs.com/guards)
