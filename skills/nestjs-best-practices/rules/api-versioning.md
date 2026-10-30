---
title: Use API Versioning for Breaking Changes
impact: MEDIUM
impactDescription: Versioning allows you to evolve APIs without breaking existing clients
tags: api, versioning, breaking-changes, compatibility
---

## Use API Versioning for Breaking Changes

Use Nest's built-in versioning when a response or request contract changes incompatibly. Pick one strategy (URI, header or media type) for the whole API and enable it once in `configureApp()`, so production and every e2e app route the same way. Let the router select the handler with `version` / `@Version()`; each version's controller returns its own typed DTO, and the service underneath stays version-neutral. Version branching inside a service (`findOne(id, version): Promise<any>`) bypasses the router, accepts versions nobody supports, and hides each version's contract.

**Incorrect (breaking change in place; version selected by hand):**

```typescript
@Get(':id')
findOne(@Param('id') id: string): Promise<User> {
  // v1 clients expected { id, name, email }; now { id, firstName, lastName, emailAddress }
  return this.usersService.findOne(id);
}

@Get(':id')
findOne(@Param('id') id: string, @Headers('X-API-Version') version = '1'): Promise<any> {
  return this.usersService.findOne(id, version); // any version string reaches the service
}
```

**Correct (`src/configure-app.ts`):**

```typescript
import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';

/** Settings production and tests share; main.ts and createTestApp call this. */
export function configureApp(app: NestExpressApplication): NestExpressApplication {
  return app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' }); // /v1/users, /v2/users
}
```

Header (`{ type: VersioningType.HEADER, header: 'X-API-Version' }`) and media-type (`{ type: VersioningType.MEDIA_TYPE, key: 'v=' }`) versioning are alternatives to URI versioning, not additions: `enableVersioning` is called once.

**Correct (version-specific controllers over a version-neutral service):**

```typescript
import {
  Controller,
  Get,
  Injectable,
  NotFoundException,
  Param,
  UseInterceptors,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';
import type { Observable } from 'rxjs';

export interface User {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  createdAt: Date;
}

/** Version-neutral domain logic; knows nothing about response shapes. */
@Injectable()
export class UsersService {
  private readonly users = new Map<string, User>([
    ['u1', { id: 'u1', firstName: 'Ann', lastName: 'Lee', email: 'ann@x.io', createdAt: new Date(0) }],
  ]);

  async findOne(id: string): Promise<User> {
    const user = this.users.get(id);
    if (!user) throw new NotFoundException();
    return user;
  }
}

export interface UserV1Dto {
  id: string;
  name: string;
  email: string;
}

export interface UserV2Dto {
  id: string;
  firstName: string;
  lastName: string;
  emailAddress: string;
  createdAt: string;
}

/** Illustrative: announce the real date with the v2 release and keep it in one place. */
const V1_DEPRECATED_AT = new Date('2026-11-01T00:00:00Z');
const V1_SUNSET_AT = new Date('2027-11-01T00:00:00Z');

/** RFC 9745 Deprecation + RFC 8594 Sunset headers on every v1 response. */
@Injectable()
export class V1DeprecationInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const response = context.switchToHttp().getResponse<Response>();
    response.setHeader('Deprecation', `@${V1_DEPRECATED_AT.getTime() / 1000}`);
    response.setHeader('Sunset', V1_SUNSET_AT.toUTCString());
    response.setHeader('Link', '</v2/users>; rel="successor-version"');
    return next.handle();
  }
}

@Controller({ path: 'users', version: '1' })
@UseInterceptors(V1DeprecationInterceptor)
export class UsersV1Controller {
  constructor(private readonly users: UsersService) {}

  @Get(':id')
  async findOne(@Param('id') id: string): Promise<UserV1Dto> {
    const user = await this.users.findOne(id);
    return { id: user.id, name: `${user.firstName} ${user.lastName}`, email: user.email };
  }
}

@Controller({ path: 'users', version: '2' })
export class UsersV2Controller {
  constructor(private readonly users: UsersService) {}

  @Get(':id')
  async findOne(@Param('id') id: string): Promise<UserV2Dto> {
    const user = await this.users.findOne(id);
    return {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      emailAddress: user.email,
      createdAt: user.createdAt.toISOString(),
    };
  }
}
```

```typescript
// Routes that don't change between versions
@Controller({ path: 'status', version: VERSION_NEUTRAL })
export class StatusController {
  @Get()
  status(): { ok: true } {
    return { ok: true };
  }
}
```

Probe results: `GET /v1/users/u1` → `{"id":"u1","name":"Ann Lee","email":"ann@x.io"}` with `Deprecation: @1793491200` and `Sunset: Mon, 01 Nov 2027 00:00:00 GMT`; `GET /v2/users/u1` → the v2 shape without those headers; `/v3/users/u1` → 404; `/status` → 200 while `/v2/status` → 404. With URI versioning a versioned route exists only under its prefix, so unversioned `/users/u1` is 404; `defaultVersion` only assigns a version to controllers that declare none. The dates are illustrative: set them when v2 ships, give clients a migration window, and remove v1 only after its traffic is gone. Response DTOs and serialization: `api-use-dto-serialization`.

Reference: [NestJS Versioning](https://docs.nestjs.com/techniques/versioning)
