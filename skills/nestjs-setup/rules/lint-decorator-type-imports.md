---
title: Keep Injected Classes as Value Imports
impact: CRITICAL
impactDescription: Prevents a lint autofix from deleting the DI token while typecheck, build and lint stay green
tags: eslint, consistent-type-imports, import-type, decorator-metadata, dependency-injection
---

## Keep Injected Classes as Value Imports

Nest DI reads constructor types from `design:paramtypes`, which the compiler emits only when the class is imported as a value. `@typescript-eslint/consistent-type-imports` sees `AppService` used only in a type position (`constructor(private readonly appService: AppService)`) and, without type information, autofixes it to `import type { AppService }`. The import is then erased and the metadata says `undefined`. In the probe, `eslint --fix` with `tseslint.configs.recommended` (no `projectService`) rewrote the controller; `pnpm typecheck` and `nest build` still passed, and boot failed with `UnknownDependenciesException [Error]: Nest can't resolve dependencies of the AppController (?). Please make sure that the argument at index [0] is available in the current module.` Unit and e2e tests failed with the same error. With `parserOptions.projectService` (`lint-type-aware-flat-config`), the rule reads `emitDecoratorMetadata` + `experimentalDecorators` from `tsconfig.json` and leaves imports used in decorated signatures alone: the same `eslint --fix` kept `import { AppService } from './app.service.js';` and the app booted. The rule still converts imports that are types only. Do not set `verbatimModuleSyntax` either; Nest needs the elision that `isolatedModules` keeps (`esm-project-config`).

**Incorrect (rule on, no type information):**

```javascript
// eslint.config.mjs
import tseslint from 'typescript-eslint';

export default tseslint.config(tseslint.configs.recommended, {
  rules: { '@typescript-eslint/consistent-type-imports': 'error' },
});
```

```typescript
// after `eslint --fix`: compiles, boots into UnknownDependenciesException
import type { AppService } from './app.service.js';
```

**Correct (rule on only with `projectService`, injected class stays a value import):**

```javascript
// eslint.config.mjs (excerpt; full file in lint-type-aware-flat-config)
{
  languageOptions: {
    parserOptions: {
      projectService: { allowDefaultProject: ['eslint.config.mjs'] },
      tsconfigRootDir: import.meta.dirname,
    },
  },
  rules: { '@typescript-eslint/consistent-type-imports': 'error' },
}
```

```typescript
// src/app.controller.ts, unchanged by `eslint --fix`
import { Body, Controller, Get, Post } from '@nestjs/common';
import { AppService } from './app.service.js';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}
}
```

A project that lints without type information turns `consistent-type-imports` off.

Reference: [typescript-eslint – consistent-type-imports: Caveat: decorators](https://typescript-eslint.io/rules/consistent-type-imports/#caveat-decorators--experimentaldecorators-true--emitdecoratormetadata-true)
