---
title: Validate All Input with DTOs and Pipes
impact: HIGH
impactDescription: First line of defense against attacks
tags: security, validation, dto, pipes, passwords
---

## Validate All Input with DTOs and Pipes

Validate every request body, query and route parameter with class-validator DTOs and one global `ValidationPipe`, registered as an `APP_PIPE` provider so e2e apps run it too (`nestjs-testing` rule `e2e-global-enhancers-as-providers`). Leave `enableImplicitConversion` off: it converts by the declared TypeScript type before validation, so `{ "name": 42 }` became `"42"` and passed `@IsString()` (201 in the probe). Convert query strings explicitly with `@Type(() => Number)`. `@Transform` also runs before validation, so a transform that assumes a string turns an array into a 500 (`value?.trim()` on `["a"]` did); guard each one with `typeof value === 'string'` and let the validators reject the rest.

**Incorrect (raw input; implicit conversion; unguarded transforms; composition rules):**

```typescript
@Controller('users')
export class UsersController {
  @Post()
  create(@Body() body: any) {
    return this.usersService.create(body); // body could contain anything
  }
}

// main.ts: missing from every e2e app, and converts 42 to "42" before @IsString() runs
app.useGlobalPipes(new ValidationPipe({ transform: true, transformOptions: { enableImplicitConversion: true } }));

export class CreateUserDto {
  @IsString()
  @Transform(({ value }) => value?.trim()) // ["a"] -> TypeError -> 500
  name: string;

  @MinLength(8)
  @MaxLength(100) // rejects long passphrases
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/) // "Passw0rd1" passes
  password: string;
}
```

**Correct (global `APP_PIPE`, explicit conversion, guarded transforms):**

```typescript
// app.module.ts providers
{ provide: APP_PIPE, useValue: new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }) },
```

```typescript
// users/users.dto.ts
import { Transform, Type } from 'class-transformer';
import { IsEmail, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const normalizeEmail = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

export class CreateUserDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(100)
  @Transform(trim)
  name: string;

  @IsEmail()
  @Transform(normalizeEmail)
  email: string;

  @IsInt()
  @Min(0)
  @Max(150)
  age: number;

  // Length only: no composition rules, passphrases welcome (NIST SP 800-63B-4)
  @IsString()
  @MinLength(15)
  @MaxLength(256)
  password: string;
}

export class FindUsersQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}

export class UserIdParamDto {
  @IsUUID('4')
  id: string;
}
```

```typescript
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  create(@Body() dto: CreateUserDto): Promise<User> {
    return this.usersService.create(dto);
  }

  @Get()
  findAll(@Query() query: FindUsersQueryDto): Promise<User[]> {
    return this.usersService.findAll(query); // query.limit is a number
  }

  @Get(':id')
  findOne(@Param() params: UserIdParamDto): Promise<User> {
    return this.usersService.findById(params.id); // params.id is a valid UUID
  }
}
```

In the probe, `name: ["a","b"]`, `name: 42`, an unknown property, `email: ["x"]` and `password: "Passw0rd1"` each answered 400 with the violations; `"  Ann  "` and `" Ann@X.test "` were stored as `Ann` and `ann@x.test`; a 200-character passphrase was accepted; `?limit=5` arrived as the number `5` and `?limit=abc` answered 400.

Passwords follow NIST SP 800-63B-4: at least 15 characters when the password is the only factor (8 with a second factor), no composition rules, long passphrases accepted. The upper bound only caps hashing work; hash with Argon2id (bcrypt ignores input past 72 bytes). The DTO can't know whether a password has leaked: in the service, reject passwords found in a breached-password list, such as the Have I Been Pwned range API, which takes only the first five hex characters of the SHA-1 hash. That outbound call is an HTTP client (`nestjs-http-client`).

Reference: [NestJS Validation](https://docs.nestjs.com/techniques/validation), [NIST SP 800-63B-4: Passwords](https://pages.nist.gov/800-63-4/sp800-63b.html#password)
