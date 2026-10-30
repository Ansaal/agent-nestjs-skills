---
title: Throw HTTP Exceptions from Services
impact: HIGH
impactDescription: Keeps controllers thin and simplifies error handling
tags: error-handling, exceptions, services
---

## Throw HTTP Exceptions from Services

It's acceptable (and often preferable) to throw `HttpException` subclasses from services in HTTP applications. This keeps controllers thin and allows services to communicate appropriate error states. For truly layer-agnostic services, use domain exceptions that map to HTTP status codes.

**Incorrect (return error objects instead of throwing):**

```typescript
// Return error objects instead of throwing
@Injectable()
export class UsersService {
  async findById(id: string): Promise<{ user?: User; error?: string }> {
    const user = await this.repo.findOne({ where: { id } });
    if (!user) {
      return { error: 'User not found' }; // Controller must check this
    }
    return { user };
  }
}

@Controller('users')
export class UsersController {
  @Get(':id')
  async findOne(@Param('id') id: string) {
    const result = await this.usersService.findById(id);
    if (result.error) {
      throw new NotFoundException(result.error);
    }
    return result.user;
  }
}
```

**Correct (throw exceptions directly from service):**

```typescript
// Throw exceptions directly from service
@Injectable()
export class UsersService {
  constructor(private readonly usersRepo: UsersRepository) {}

  async findById(id: string): Promise<User> {
    const user = await this.usersRepo.findById(id);
    if (!user) throw new NotFoundException('User not found'); // no client input echoed (security-sanitize-output)
    return user;
  }

  async create(dto: CreateUserDto): Promise<User> {
    try {
      return await this.usersRepo.insert({ email: dto.email, name: dto.name });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('Email already registered');
      throw error;
    }
  }

  async update(id: string, dto: UpdateUserDto): Promise<User> {
    const user = await this.usersRepo.update(id, dto); // null when no row matched
    if (!user) throw new NotFoundException('User not found');
    return user;
  }
}

// Controller stays thin
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get(':id')
  findOne(@Param() params: UserIdParamDto): Promise<User> {
    return this.usersService.findById(params.id);
  }

  @Post()
  create(@Body() dto: CreateUserDto): Promise<User> {
    return this.usersService.create(dto);
  }
}

// For layer-agnostic services, use domain exceptions
export class EntityNotFoundException extends Error {
  constructor(
    readonly entity: string,
    readonly id: string,
  ) {
    super(`${entity} not found`);
  }
}

// Map to HTTP in an exception filter (error-use-exception-filters)
@Catch(EntityNotFoundException)
export class EntityNotFoundFilter extends BaseExceptionFilter {
  override catch(exception: EntityNotFoundException, host: ArgumentsHost): void {
    super.catch(new NotFoundException(exception.message, { cause: exception }), host);
  }
}
```

`UsersRepository` writes through `TransactionRunner` (`arch-use-repository-pattern`); the duplicate check is the unique index, not a pre-read (`nestjs-typeorm` rule `orm-unique-violation`). In the probe a duplicate email answered `409 {"message":"Email already registered","error":"Conflict","statusCode":409}` and `PATCH` on an unknown id answered 404.

Reference: [NestJS Exception Filters](https://docs.nestjs.com/exception-filters)
