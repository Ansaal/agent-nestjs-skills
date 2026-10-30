---
title: Use Exception Filters for Error Handling
impact: HIGH
impactDescription: Consistent, centralized error handling
tags: error-handling, exception-filters, consistency
---

## Use Exception Filters for Error Handling

Never catch exceptions and manually format error responses in controllers. Throw exceptions and let filters turn them into responses. Custom filters map specific error types; one catch-all logs every failed request. Filters extend `BaseExceptionFilter` and hand it an `HttpException`, so the body is Nest's `getResponse()` (validation messages included) and every filter answers in the same shape. Log levels and call shape: `nestjs-logging`.

**Incorrect (manual error handling in controllers):**

```typescript
// Manual error handling in controllers
@Controller('users')
export class UsersController {
  @Get(':id')
  async findOne(@Param('id') id: string, @Res() res: Response) {
    try {
      const user = await this.usersService.findById(id);
      if (!user) {
        return res.status(404).json({
          statusCode: 404,
          message: 'User not found',
        });
      }
      return res.json(user);
    } catch (error) {
      return res.status(500).json({
        statusCode: 500,
        message: 'Internal server error',
      });
    }
  }
}
```

**Incorrect (catch-all that rebuilds the body from `exception.message`):**

```typescript
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    const message = exception instanceof HttpException ? exception.message : 'Internal server error';
    host.switchToHttp().getResponse<Response>().status(status).json({ statusCode: status, message });
    // A ValidationPipe 400 answers "Bad Request Exception": the violations live in getResponse()
  }
}
```

**Correct (exceptions in code, filters that delegate the response to `BaseExceptionFilter`):**

```typescript
// Throw built-in or custom HTTP exceptions; no response handling in controllers
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get(':id')
  findOne(@Param() params: UserIdParamDto): Promise<User> {
    return this.usersService.findById(params.id); // throws NotFoundException
  }
}
```

```typescript
// errors/filters.ts
import { type ArgumentsHost, Catch, HttpException, HttpStatus, InternalServerErrorException, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { Request } from 'express';

export class DomainException extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: HttpStatus = HttpStatus.UNPROCESSABLE_ENTITY,
  ) {
    super(message);
  }
}

/** Domain errors are expected outcomes: mapped to their status, not logged. */
@Catch(DomainException)
export class DomainExceptionFilter extends BaseExceptionFilter {
  override catch(exception: DomainException, host: ArgumentsHost): void {
    const body = { statusCode: exception.status, code: exception.code, message: exception.message };
    super.catch(new HttpException(body, exception.status, { cause: exception }), host);
  }
}

/** Logs every failed request once; Nest's BaseExceptionFilter writes the response. */
@Catch()
export class AllExceptionsFilter extends BaseExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  override catch(exception: unknown, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<Request>();
    // Unknown errors answer a generic 500; the original stays in `cause` and in the log
    const httpException =
      exception instanceof HttpException ? exception : new InternalServerErrorException(undefined, { cause: exception });
    const statusCode = httpException.getStatus();
    const fields = { method: request.method, path: request.path, statusCode };

    if (statusCode >= 500) {
      const err = exception instanceof Error ? exception : new Error(String(exception));
      this.logger.error('Request failed', fields, err);
    } else {
      this.logger.debug('Request rejected', fields);
    }
    super.catch(httpException, host); // body = getResponse(): validation messages survive
  }
}
```

```typescript
// app.module.ts providers: APP_FILTER, so e2e apps get them too (nestjs-testing e2e-global-enhancers-as-providers).
// Nest tries the last-listed filter first and runs only the first whose @Catch matches: the catch-all goes first.
{ provide: APP_FILTER, useClass: AllExceptionsFilter },
{ provide: APP_FILTER, useClass: DomainExceptionFilter },
{ provide: APP_FILTER, useClass: HttpClientExceptionFilter }, // nestjs-http-client request-exception-filter
```

Measured through the real `AppModule` with the `ValidationPipe` as `APP_PIPE`: `{ name: 42 }` answered `400 {"message":["name must be a string"],"error":"Bad Request","statusCode":400}`; `NotFoundException('User not found')` kept its body; a plain `Error` answered `500 {"message":"Internal Server Error","statusCode":500}` and logged one `error` `Request failed` with the fields and the error; a `DomainException` answered `422 {"statusCode":422,"code":"ORDER_SHIPPED",…}`. An `HttpNetworkError` answered `502` and an `HttpTimeoutError` `504` through `HttpClientExceptionFilter`, which logs those itself. With the catch-all listed last, the same `HttpNetworkError` answered `500`: the catch-all matched first and the gateway mapping never ran. Wrapping unknown errors in `InternalServerErrorException` keeps `BaseExceptionFilter` from logging them a second time under `ExceptionsHandler`. `HttpClientExceptionFilter` and `toHttpException()` are owned by `nestjs-http-client`.

Reference: [NestJS Exception Filters](https://docs.nestjs.com/exception-filters)
