---
title: Use Pipes for Input Transformation
impact: MEDIUM
impactDescription: Pipes ensure clean, validated data reaches your handlers
tags: api, pipes, validation, transformation
---

## Use Pipes for Input Transformation

Use the built-in pipes (`ParseUUIDPipe`, `ParseIntPipe`, `ParseEnumPipe`, `ParseArrayPipe`, `DefaultValuePipe`) for parameters, a custom pipe for a parsing rule the built-ins lack, and one global `ValidationPipe` for DTOs. A pipe or `@Transform` receives whatever the client sent: a repeated query key (`?search=a&search=b`) arrives as an array, and a JSON body field can be any type. Transforms run before class-validator, so a transform that calls string methods unguarded turns that input into a 500: `@Transform(({ value }) => value?.toLowerCase())` answered `?search=a&search=b` with `500 Internal server error` and logged `TypeError: value?.toLowerCase is not a function`. Check the type, and either throw `BadRequestException` (pipes) or return the value unchanged for the validators to reject (DTOs).

**Incorrect (manual parsing; unguarded transforms; validation only in `main.ts`):**

```typescript
@Get()
findAll(@Query('page') page: string, @Query('limit') limit: string): Promise<User[]> {
  return this.usersService.findAll(parseInt(page) || 1, parseInt(limit) || 10); // ?page=abc silently becomes 1
}

export class FindProductsDto {
  @IsOptional()
  @Transform(({ value }) => value?.toLowerCase()) // array input: TypeError, 500
  @IsString()
  search?: string;
}

// main.ts — e2e apps built from AppModule run without it
app.useGlobalPipes(new ValidationPipe({ transform: true, transformOptions: { enableImplicitConversion: true } }));
```

**Correct (built-in and custom pipes):**

```typescript
@Controller('users')
export class UsersController {
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<UserResponseDto> {
    return this.users.findOne(id);
  }

  @Get()
  findAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
  ): Promise<UserResponseDto[]> {
    return this.users.findAll(page, limit);
  }
}
```

```typescript
// common/pipes.ts
import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';

/** Query/param values are strings, string arrays (repeated keys) or undefined; reject everything but one string. */
@Injectable()
export class ParseDatePipe implements PipeTransform<unknown, Date> {
  transform(value: unknown): Date {
    const date = typeof value === 'string' ? new Date(value) : new Date(Number.NaN);
    if (Number.isNaN(date.getTime())) throw new BadRequestException('Expected an ISO 8601 date');
    return date;
  }
}

@Injectable()
export class NormalizeEmailPipe implements PipeTransform<unknown, string | undefined> {
  transform(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw new BadRequestException('Expected a single email');
    return value.trim().toLowerCase();
  }
}
```

```typescript
@Get('reports')
findReports(@Query('from', ParseDatePipe) from: Date, @Query('to', ParseDatePipe) to: Date): Promise<ReportDto[]> {
  return this.reports.findBetween(from, to);
}

@Get('products')
findByIds(
  @Query('ids', new ParseArrayPipe({ items: String, separator: ',' })) ids: string[],
  @Query('email', NormalizeEmailPipe) email: string | undefined,
): Promise<ProductDto[]> {
  return this.products.findByIds(ids, email);
}

@Get('items/:id')
findItem(
  @Param('id', new ParseIntPipe({ exceptionFactory: () => new BadRequestException('id must be an integer') })) id: number,
): Promise<ItemDto> {
  return this.items.findOne(id);
}
```

**Correct (DTO with guarded transforms, global `ValidationPipe` as `APP_PIPE`):**

```typescript
import { Transform, Type } from 'class-transformer';
import { IsArray, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class FindProductsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 10;

  // Transforms run before validation: touch strings only, leave anything else for @IsString to reject
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsString()
  search?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.split(',') : value))
  @IsArray()
  @IsString({ each: true })
  categories?: string[];
}
```

```typescript
// app.module.ts
@Module({
  providers: [
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    },
  ],
})
export class AppModule {}
```

Probe results: `?from=2026-01-01&from=2026-01-02` → `400 Expected an ISO 8601 date`; `?email=a@x.io&email=b@x.io` → `400 Expected a single email`; `?search=a&search=b` → `400 ["search must be a string"]`; `?search=ABC&categories=a,b&page=2` → `{"page":2,"limit":10,"search":"abc","categories":["a","b"]}`; `?page=x` → 400; `/items/abc` → `400 id must be an integer`. Conversion is explicit (`@Type(() => Number)`), not `enableImplicitConversion`, which also converts a number sent for a string field into a string that passes `@IsString()` (`security-validate-all-input`). `ParseArrayPipe` is Nest's; don't shadow it with a custom class of the same name. HTML sanitization is `security-sanitize-output`. `APP_PIPE` puts validation in the module graph, so e2e apps validate like production (`nestjs-testing` rule `e2e-global-enhancers-as-providers`).

Reference: [NestJS Pipes](https://docs.nestjs.com/pipes)
