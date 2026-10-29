# NestJS Best Practices (Ansaal fork)

Personal fork of [Kadajett/agent-nestjs-skills](https://github.com/Kadajett/agent-nestjs-skills) (MIT). Every deviation from upstream is listed in [`UPSTREAM.md`](UPSTREAM.md).

---

## Installation

Install this skill using [skills](https://github.com/vercel-labs/skills):

```bash
# GitHub shorthand
npx skills add Ansaal/agent-nestjs-skills

# Install globally (available across all projects)
npx skills add Ansaal/agent-nestjs-skills --global

# Install for specific agents
npx skills add Ansaal/agent-nestjs-skills -a claude-code -a cursor
```

### Supported Agents

- Claude Code
- OpenCode
- Codex
- Cursor
- Antigravity
- Roo Code

## Skills

| Skill | Use it for |
|-------|-----------|
| `nestjs-best-practices` | Architecture, DI, errors, security, performance, API design (upstream rules) |
| `nestjs-fdd` | Planning a feature or app with Feature-Driven Development, one Nest module per feature set |
| `nestjs-setup` | Newest Nest version, Node, ESM, SWC builder, Vitest configuration |
| `nestjs-testing` | Unit tests with `useMocker()` auto-mocking, e2e tests with Supertest |
| `nestjs-typeorm` | `@nestjs/typeorm` data source, migrations, transactions |
| `nestjs-resilience` | `@nestjs/resilience`, idempotency, dead-letter handling |

## Structure

- `skills/<skill>/` - An installable skill (this is what `skills add` copies into your project)
  - `SKILL.md` - Skill entry point and quick reference
  - `rules/` - Individual rule files (one per rule), for rule-based skills
    - `_sections.md` - Sections: number, name, filename prefix, impact, description
    - `_template.md` - Template for creating new rules (in `nestjs-best-practices`)
    - `area-description.md` - Individual rule files
- `scripts/` - Build scripts and utilities
- `metadata.json` - Document metadata (version, organization, date, references)
- __`compiled/<skill>.md`__ - Compiled output per rule-based skill (generated); a single-file copy for tools without skill support
- `AGENTS.md` - Instructions for agents editing this repository

## Getting Started

1. Install dependencies:
   ```bash
   cd scripts && npm install
   ```

2. Build `compiled/<skill>.md` from rules:
   ```bash
   npm run build
   # or
   ./scripts/build.sh
   ```

## Creating a New Rule

1. Copy `skills/nestjs-best-practices/rules/_template.md` to `skills/<skill>/rules/<prefix>-description.md`
2. Use a prefix declared in that skill's `rules/_sections.md` (`## <n>. <Name> (<prefix>)`); a new prefix needs a new section there
3. Fill in the frontmatter and content
4. Ensure you have clear examples with explanations
5. Run the build script to regenerate `compiled/<skill>.md`; it fails on a rule without frontmatter or with an undeclared prefix

## Rule File Structure

Each rule file should follow this structure:

```markdown
---
title: Rule Title Here
impact: MEDIUM
impactDescription: Optional description
tags: tag1, tag2, tag3
---

## Rule Title Here

Brief explanation of the rule and why it matters.

**Incorrect (description of what's wrong):**

```typescript
// Bad code example
```

**Correct (description of what's right):**

```typescript
// Good code example
```

Optional explanatory text after examples.

Reference: [NestJS Documentation](https://docs.nestjs.com)


## File Naming Convention

- Files starting with `_` are special (excluded from build)
- Rule files: `area-description.md` (e.g., `arch-avoid-circular-deps.md`)
- Section is automatically inferred from filename prefix
- Rules are sorted alphabetically by filename within each section
- IDs (e.g., 1.1, 1.2) are auto-generated during build

## Impact Levels

| Level | Description |
|-------|-------------|
| CRITICAL | Violations cause runtime errors, security vulnerabilities, or architectural breakdown |
| HIGH | Significant impact on reliability, security, or maintainability |
| MEDIUM-HIGH | Notable impact on quality and developer experience |
| MEDIUM | Moderate impact on code quality and best practices |
| LOW-MEDIUM | Minor improvements for consistency and maintainability |

## Scripts

- `npm run build` (in scripts/) - Compile rules into `compiled/<skill>.md`

## Contributing

When adding or modifying rules:

1. Use the correct filename prefix for your section
2. Follow the `_template.md` structure
3. Include clear bad/good examples with explanations
4. Add appropriate tags
5. Run the build script to regenerate `compiled/<skill>.md`
6. Rules are automatically sorted by filename - no need to manage numbers!

## Acknowledgments

- Forked from [Kadajett/agent-nestjs-skills](https://github.com/Kadajett/agent-nestjs-skills) by Kadajett (MIT)
- Inspired by the [Vercel React Best Practices](https://github.com/vercel-labs/agent-skills) skill structure
- Compatible with [skills](https://github.com/vercel-labs/skills) for easy installation across coding agents

## Compatible Agents

These NestJS skills work with:

- [Claude Code](https://claude.ai/code) - Anthropic's official CLI
- [AdaL](https://sylph.ai/adal) - Self-evolving AI coding agent with MCP support

