# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is the DatoCMS CLI - a monorepo containing CLI tools for managing DatoCMS projects, environments, and schemas. It includes:

- `datocms` (`packages/cli/`): Main CLI package with environment management, migrations, and maintenance commands
- `@datocms/cli` (`packages/cli-legacy/`): Legacy scoped alias that just depends on `datocms`
- `@datocms/cli-plugin-wordpress`: WordPress import functionality
- `@datocms/cli-plugin-contentful`: Contentful import functionality
- `@datocms/cli-plugin-content-diff`: Editable TypeScript content migrations between environments or projects (`content:diff` and `content:apply`)
- `@datocms/cli-utils`: Shared utilities and base commands

## Architecture

The packages live under `packages/` and are **npm workspaces**. **Turborepo** runs the builds, deriving the order from the dependencies between packages, and **Changesets** handles versioning and the changelogs.

### Key Components

**CLI Core (`packages/cli/`)**:
- Built on oclif framework for CLI command structure
- Commands organized by topic: `environments`, `migrations`, `maintenance`, `profile`
- Uses `environments-diff` utility for schema synchronization between environments
- Migration system with timestamped files in `migrations/` directory

**Plugin Architecture**:
- WordPress and Contentful plugins extend base functionality
- Both plugins follow similar patterns with step-based imports and validation
- Base command classes in `cli-utils` provide shared functionality

**Common Patterns**:
- All packages use TypeScript with strict configuration
- Commands extend base classes from `@datocms/cli-utils`
- API interactions through DatoCMS REST clients
- Step-based processing for complex operations (imports, migrations)

## Development Commands

```bash
# Initial setup
npm install
npm run build

# Development workflow
npm run format     # Format and fix code with Biome
npm run lint       # Check code quality with Biome
npm run build      # Build all packages, in dependency order, via Turborepo
npm run test       # Run every package's tests via Turborepo

# Releasing
npx changeset        # Describe a change, in the PR that makes it
npm run release      # Build, test, version, publish, tag, release notes
npm run release:next # The same, under the `next` dist-tag
```

Changes worth mentioning in a release need a changeset committed alongside them
(`npx changeset`); see `.changeset/README.md`. Note that `changeset version`
runs no npm lifecycle hooks, so anything that used to hang off one — the
`oclif readme` regeneration, in particular — lives in `toolchain/release.mjs`,
which is this repo's `beforeCommit` hook into the shared
[`@datocms/release-toolchain`](https://github.com/datocms/release-toolchain).

### Individual Package Commands

Each package supports:
```bash
cd packages/cli
npm run build    # TypeScript compilation
npm run test     # Mocha tests
npm run prepack  # Build + generate oclif manifest
```

## Testing

- Uses **Mocha** with TypeScript support via `ts-node`
- Test files follow pattern `test/**/*.test.ts`
- Each package manages its own tests; `npm test` at the root runs them
  through Turborepo, after building what they depend on
- The WordPress and Contentful import suites talk to live APIs and create real
  DatoCMS projects, which they delete afterwards. They need a `.env` at the root
  (see `.env.sample`) and, for WordPress, `docker compose up` in its package.
  `npm test` runs them, and so does `npm run release` — a release cannot be cut
  without that setup. Each prerequisite is checked in a `before` hook that says
  what is missing and how to fix it, so a misconfiguration fails as itself
  rather than as a 401 halfway through an import
- `packages/cli`'s suite needs nothing, and neither does
  `packages/cli-plugin-content-diff`'s

## Code Quality

- **Biome** for linting and formatting (configured in `biome.json`)
- **Husky** + **lint-staged** for pre-commit hooks
- TypeScript strict mode enabled
- Uses single quotes, space indentation
- Ignores generated `lib/` directories

## Migration System

The CLI includes a migration system (`packages/cli/src/commands/migrations/`) for timestamped scripts:
- Timestamped migration files (format: `TIMESTAMP_description.ts`)
- Use `datocms migrations:new` to create migrations; `--autogenerate` captures schema changes only
- Use `datocms content:diff NAME` to generate editable content migrations containing actual CMA calls
- Use `datocms migrations:run` for schema migrations and `content:apply SCRIPT.ts` for content migrations. Generated content scripts live in the `content/` subdirectory of the configured migrations directory.
- Content migrations keep immutable destination baseline evidence (no binaries) in a sibling `.content` directory; assets are copied from their source URLs with an MD5 check. Generation compiles the dependency plan into directly executable TypeScript; apply checks the destination baseline and executes real CMA calls without local validation or replanning. Content migrations never make temporary schema changes. Invalid source records cannot be diffed: generation fails on any record it would write that the source CMA reports invalid, except invalid drafts in models with draft mode and invalid draft saving
- Large content migrations split into parts under `.content/parts/`, which the main script runs in-process through `runMigrationPart`
- Generated imports require the content plugin as a resolvable project dependency. Preserve the tracking-model projection, one-shot execution, and fork cleanup contracts documented in the plugin README and `docs/design.md`

## Content diff boundary

Keep content diff entirely within `@datocms/cli-plugin-content-diff`. It must work with the unmodified DatoCMS CLI and published shared utilities. Do not change, override, or patch native CLI commands or add content-specific contracts to `cli-utils`; generation and execution belong to `content:diff` and `content:apply`.
