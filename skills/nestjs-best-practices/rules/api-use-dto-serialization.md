---
title: Use DTOs and Serialization for API Responses
impact: MEDIUM
impactDescription: Response DTOs prevent accidental data exposure and ensure consistency
tags: api, dto, serialization, class-transformer
---

## Use DTOs and Serialization for API Responses

Never return entities as the response contract. Declare a response DTO per shape and let one global `ClassSerializerInterceptor` turn whatever the handler returns into that DTO. The DTO must be deny-by-default: `@Expose()` alone does not hide anything. `plainToInstance(Dto, user)` copies every property of `user`, and `instanceToPlain` then emits all of them, so a DTO without a class-level `@Exclude()` leaks `passwordHash` the day someone adds it to the entity.

**Incorrect (entity returned directly; DTO with `@Expose()` only):**

```typescript
@Get(':id')
findOne(@Param('id', ParseUUIDPipe) id: string): Promise<User> {
  return this.usersService.findById(id); // { id, email, passwordHash, ... }
}

export class UserResponseDto {
  @Expose() id: string;
  @Expose() email: string;
}

@Get(':id')
async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<UserResponseDto> {
  return plainToInstance(UserResponseDto, await this.usersService.findById(id));
  // {"id":"u1","email":"a@x.io","name":"Ann","passwordHash":"h","createdAt":"1970-01-01T00:00:00.000Z"}
}
```

**Correct (deny-by-default DTOs, one global serializer):**

```typescript
// users/user-response.dto.ts
import { Exclude, Expose } from 'class-transformer';

/** Class-level @Exclude(): only the properties declared with @Expose() reach the client. */
@Exclude()
export class UserResponseDto {
  @Expose() id: string;
  @Expose() email: string;
  @Expose() name: string;
}

@Exclude()
export class UserAdminDto extends UserResponseDto {
  @Expose({ groups: ['admin'] }) createdAt: Date;
}
```

```typescript
// app.module.ts
import { ClassSerializerInterceptor, Module } from '@nestjs/common';
import { APP_INTERCEPTOR, Reflector } from '@nestjs/core';

@Module({
  providers: [
    {
      provide: APP_INTERCEPTOR,
      inject: [Reflector],
      // Default for every route: a class instance without a response DTO serializes to {} instead of every column.
      useFactory: (reflector: Reflector) => new ClassSerializerInterceptor(reflector, { excludeExtraneousValues: true }),
    },
  ],
})
export class AppModule {}
```

```typescript
// users/users.controller.ts
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get(':id')
  @SerializeOptions({ type: UserResponseDto })
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<UserResponseDto> {
    return this.users.findById(id); // the interceptor converts the entity to UserResponseDto
  }

  @Get(':id/admin')
  @UseGuards(AdminGuard)
  @SerializeOptions({ type: UserAdminDto, groups: ['admin'] })
  findOneForAdmin(@Param('id', ParseUUIDPipe) id: string): Promise<UserAdminDto> {
    return this.users.findById(id);
  }
}
```

Conversion lives in one place, the interceptor, so list and detail routes cannot diverge; handlers never call `plainToInstance` themselves. In the probe, a source object carrying `passwordHash` serialized to `{"id":"u1","email":"a@x.io","name":"Ann"}` through `UserResponseDto`, the admin route added `createdAt`, and the same DTO without the `admin` group omitted it. A class instance returned from a route with no `@SerializeOptions` serialized to `{}`. The interceptor only converts class instances: a plain object literal returned without `@SerializeOptions({ type })` passes through unchanged, so declare the type on every route.

The interceptor is an `APP_INTERCEPTOR` provider, not `app.useGlobalInterceptors()` in `main.ts`, so e2e apps built from `AppModule` serialize the same way (`nestjs-testing` rule `e2e-global-enhancers-as-providers`); input validation goes the same way as an `APP_PIPE` (`api-use-pipes`).

Reference: [NestJS Serialization](https://docs.nestjs.com/techniques/serialization)
