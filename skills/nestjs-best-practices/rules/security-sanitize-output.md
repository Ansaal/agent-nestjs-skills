---
title: Sanitize Output to Prevent XSS
impact: HIGH
impactDescription: XSS vulnerabilities can compromise user sessions and data
tags: security, xss, sanitization, html, helmet
---

## Sanitize Output to Prevent XSS

While NestJS APIs typically return JSON (which browsers don't execute), XSS risks exist when rendering HTML, storing user content, or when frontend frameworks improperly handle API responses. Sanitize user-generated HTML before storage, keep client input out of messages, and send a Content-Security-Policy. Under the project's NodeNext ESM setup, `sanitize-html` is a default import: `import * as sanitizeHtml` fails to type-check with `TS2349: This expression is not callable` (`sanitize-html` 2.18.1, `@types/sanitize-html` 2.16.2).

**Incorrect (storing raw HTML without sanitization):**

```typescript
// Store raw HTML from users
@Injectable()
export class CommentsService {
  async create(dto: CreateCommentDto): Promise<Comment> {
    // User can inject: <script>steal(document.cookie)</script>
    return this.repo.save({
      content: dto.content, // Raw, unsanitized
      authorId: dto.authorId, // and the author is whatever the client claims
    });
  }
}

// Return HTML without sanitization
@Controller('pages')
export class PagesController {
  @Get(':slug')
  @Header('Content-Type', 'text/html')
  async getPage(@Param('slug') slug: string): Promise<string> {
    const page = await this.pagesService.findBySlug(slug);
    // If page.content contains user input, XSS is possible
    return `<html><body>${page.content}</body></html>`;
  }
}

// Reflect user input in errors
@Get(':id')
async findOne(@Param('id') id: string): Promise<User> {
  const user = await this.repo.findOne({ where: { id } });
  if (!user) {
    // XSS if id contains malicious content and error is rendered
    throw new NotFoundException(`User ${id} not found`);
  }
  return user;
}

// Sanitizer in a transform without a type guard: an array body field throws a TypeError -> 500
@Transform(({ value }) => sanitizeHtml(value, { allowedTags: [] }))
title: string;
```

**Correct (sanitize content, guard transforms, send a CSP):**

```typescript
// comments/comments.service.ts: sanitize HTML before storage
import { Injectable } from '@nestjs/common';
import sanitizeHtml from 'sanitize-html';
import { TransactionRunner } from '../database/transaction-runner.js';
import { Comment } from './comment.entity.js';

export const COMMENT_HTML: sanitizeHtml.IOptions = {
  allowedTags: ['b', 'i', 'em', 'strong', 'a', 'p', 'br'],
  allowedAttributes: { a: ['href', 'title'] },
  allowedSchemes: ['http', 'https', 'mailto'],
};

@Injectable()
export class CommentsService {
  constructor(private readonly transactions: TransactionRunner) {}

  create(authorId: string, dto: CreateCommentDto): Promise<Comment> {
    const content = sanitizeHtml(dto.content, COMMENT_HTML);
    return this.transactions.run((manager) => manager.save(Comment, { authorId, content }));
  }
}

// comments/comments.controller.ts: the author is the authenticated user, not a body field
@Post()
create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateCommentDto): Promise<Comment> {
  return this.comments.create(user.id, dto);
}
```

```typescript
// posts/create-post.dto.ts: sanitize in the DTO; non-strings pass through to @IsString()
import { Transform } from 'class-transformer';
import { IsString, MaxLength } from 'class-validator';
import sanitizeHtml from 'sanitize-html';
import { COMMENT_HTML } from '../comments/comments.service.js';

const stripAllHtml = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? sanitizeHtml(value, { allowedTags: [], allowedAttributes: {} }) : value;

export class CreatePostDto {
  @IsString()
  @MaxLength(1000)
  @Transform(stripAllHtml)
  title: string;

  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? sanitizeHtml(value, COMMENT_HTML) : value))
  content: string;
}
```

```typescript
// Fixed error messages; the param is validated before use
@Get(':id')
findOne(@Param() params: UserIdParamDto): Promise<User> {
  return this.usersService.findById(params.id); // throws NotFoundException('User not found')
}
```

```typescript
// src/configure-app.ts (nestjs-testing): middleware has no provider form, so main.ts and e2e apps share it here
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';

export function configureApp(app: NestExpressApplication): NestExpressApplication {
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https:'],
        },
      },
    }),
  );
  return app.setGlobalPrefix('api');
}
```

In the probe, a comment `hi <script>steal()</script><b>there</b>` was stored as `hi <b>there</b>` with the token's user as author. `CreatePostDto` turned `<b>Hi</b><script>x()</script>` into `Hi` and `<p onclick="x()">ok <a href="javascript:x()">l</a></p>` into `<p>ok <a>l</a></p>`; an array `title` answered 400 (`title must be a string`) where the unguarded transform answered 500. Every response carried `content-security-policy: default-src 'self';…;script-src 'self';…`. Transforms run before validation, so each one returns non-strings unchanged (`security-validate-all-input`). Nest serializes returned objects as `application/json`; set `Content-Type: text/html` only on routes that render escaped HTML.

Reference: [OWASP XSS Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html)
