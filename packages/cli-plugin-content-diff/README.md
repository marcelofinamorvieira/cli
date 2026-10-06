# DatoCMS content migrations

Generate editable TypeScript migrations from content differences between DatoCMS environments or projects. Generation plans dependency order and emits actual CMA calls. Apply checks the destination and executes the script as written against the real CMA client.

The plugin adds `content:diff` and `content:apply` to the unmodified DatoCMS CLI. It does not change native schema migrations or write their migration receipts.

## Setup

Requires Node.js 22.13+ on the 22.x line, or Node.js 24+. Node 22 may print an experimental SQLite warning to stderr. SQLite is local temporary storage; it requires no separate server or account.

Install both packages in the project containing your migrations and register the local plugin:

```sh
npm install --save-dev datocms @datocms/cli-plugin-content-diff
npx datocms plugins:link ./node_modules/@datocms/cli-plugin-content-diff
```

For an unreleased plugin, install its local package or tarball instead of the registry version. Generated scripts import `@datocms/cli-plugin-content-diff/migration`, so the package must resolve from the migration directory. Installing only with `plugins:install` in a separate CLI data directory is insufficient for those imports.

Use native profiles, linked-project OAuth, token environment variables, or `--api-token`. Authentication uses public CLI utilities and SDK APIs.

## Generate

```sh
npx datocms content:diff syncContent --source=staging --destination=primary
```

Generation checks schema compatibility before capturing content. It reads complete managed namespaces once into temporary SQLite, including current and published values, expanded blocks, schedules, assets and folders. It performs no post-capture verification pass. Keep both environments' content and schemas unchanged during generation using external write controls; the plugin does not acquire an environment lock.

The planner determines required changes, dependencies, publication cycles, ordering and any explicitly authorized temporary field settings. It then writes those execution steps into TypeScript. Assets are created before records; record operations follow the generated dependency order. Model selection limits changes, while other captured content supplies dependency and preservation evidence.

Output is a timestamped file such as `migrations/content/1791200000_syncContent.ts` and its sibling `1791200000_syncContent.content/` directory. The default directory is the `content/` subdirectory of the destination profile's migration directory, or `./migrations/content`. Existing output is never overwritten.

| Flag | Default | Behavior |
| --- | --- | --- |
| `--output` | Timestamped file | Choose an exact `.ts` path or an output directory. |
| `--item-types=article,page` | `all` | Select regular model API keys for changes. |
| `--uploads=referenced` | `referenced` | Include referenced assets, or use `all`. |
| `--include-deletions` | Off | Include safe destination-only deletions within scope. |
| `--allow-partial` | Off | Permit only proven isolated skips and dependent skips. |
| `--allow-temporary-schema-changes` | Off | Permit supported temporary validator/default changes. |
| `--concurrency=8` | `8` | Maximum concurrent generation requests, from 1 to 16. |
| `--chunk-bytes=1048576` | `1048576` | Target TypeScript part size; individual operations are never split. |

For separate projects, select both profiles:

```sh
npx datocms content:diff syncContent \
  --source=main --destination=main \
  --source-profile=source-project --destination-profile=target-project
```

The projects must have compatible managed schemas and public IDs. Captures run concurrently for separate projects. `--source-api-token` and `--destination-api-token` override their respective authentication; paired profiles cannot be combined with `--profile` or `--api-token`.

## Review and edit the script

A small migration contains ordinary awaited CMA calls:

```ts
import { join } from 'node:path';
import {
  type ContentMigrationClient,
  defineContentMigration,
} from '@datocms/cli-plugin-content-diff/migration';

export default defineContentMigration(
  { baseline: join(__dirname, '1791200000_syncContent.content') },
  async (client: ContentMigrationClient): Promise<void> => {
    await client.items.update('AbCdEfGhIjKlMnOpQrStUv', {
      summary: { en: 'Updated procurement guidance.' },
    });
  },
);
```

Each call executes immediately against the selected environment and returns the real CMA result. The plugin does not simulate the script, record intended content, or rebuild a plan during apply. `defineContentMigration` attaches the baseline declaration and manages outstanding requests; it returns a callable migration function. `ContentMigrationClient` uses public SDK method and response types for the methods supported by generated scripts and their parts.

Edits change what is sent to the CMA. Authors must keep edited operations in a valid order and update any related publication, schedule, or temporary-schema steps. The CMA validates actual writes. There is no automatic reordering or promise that an arbitrary edited script reproduces the originally generated result. Await every call.

Large migrations contain sequential TypeScript parts in the companion directory. Parts run in disposable Node processes to release compiled code and compiler subprocesses. Calls from a part are forwarded immediately to the real CMA client; this is execution, not a local simulation. The bridge supports the declared client methods and returns their real server responses.

TypeScript loads through public `tsx` APIs. Run from the project directory so its tsconfig/path aliases apply, or set `TSX_TSCONFIG_PATH`. Generated comments identify models, records and phases. Each part uses project Prettier settings and must fit within 16 MiB, including headers.

Scripts, imports and formatter configuration are trusted executable Node code, not a sandbox. Independently constructed clients and other side effects are outside the supplied client's request lifecycle.

## Companion files

Keep the `.ts` file and its same-named `.content` directory together. Apply, preflight and repair all bind to that sibling directory. The companion holds checksummed schema/project bindings, original destination guards, original values for changed identities, repair settings, and required original asset binaries. It is not an executable mutation plan or saved run progress. The TypeScript contains the operations to execute.

Edit TypeScript, including parts when present. Preserve baseline metadata and binary files. Checksums detect corruption and incomplete copies, not deliberate tampering by someone who can replace the checksums too. Artifacts contain project content, not authentication credentials.

This format is incompatible with the earlier simulated-migration format. Regenerate old scripts and companions before applying them.

## Apply

```sh
npx datocms content:apply ./migrations/content/1791200000_syncContent.ts
```

Apply validates companion integrity, destination project/schema, permissions and the complete original destination baseline. By default it creates an isolated destination fork, verifies its baseline, and executes the script against that fork. It reports the resulting environment ID and never promotes it automatically.

| Flag | Behavior |
| --- | --- |
| `--preflight-only` | Check artifacts, destination baseline, permissions and options without executing the migration or creating a fork. |
| `--fork-name=content-review` | Choose the new fork's name; existing names are refused. |
| `--destination=ENVIRONMENT_ID` | Select a destination satisfying the recorded project/schema/baseline binding. |
| `--in-place` | Execute directly in the destination. |
| `--allow-primary` | Additionally authorize primary writes; required for primary in-place execution or repair. |
| `--keep-failed-fork` | Retain a confirmed owned fork after failure. |
| `--allow-temporary-schema-changes` | Authorize generated temporary validator/default changes. |
| `--schedule-window=120` | Refuse existing schedules due within this many minutes; `0` disables the check. |
| `--fast-fork` | Use DatoCMS's fast fork, which blocks destination writes while copying. |
| `--verification=versions` | Choose version-based or full destination capture checks. |
| `--concurrency=8` | Bound preflight capture requests; execution follows the script's written order. |
| `--repair` | Conservatively restore original field settings and eligible original schedules after interrupted in-place execution. |

`--preflight-only` replaces `--dry-run`. It does not execute migration callbacks, preview edited operations, validate arbitrary new payloads, or promise they will succeed. Preflight checks the script file without evaluating its imports or top-level code. Any displayed generated counts describe the original generation, not later edits. A later apply repeats destination checks.

The destination baseline protects against content changes made after generation. Execution does not compare its result with an obsolete desired-state copy or perform apply-time replanning. Script authors own edited logic and any additional assertions they need. Stop competing writes during execution; there is no atomic transaction around the entire migration.

## Interruptions and repair

Generation and execution are one-shot operations, with no pause, resume, checkpoints, or saved execution progress. Temporary SQLite/staging state is removed on completion or failure. Keep completed scripts and companions.

Cooperative interruption stops new supported requests and drains submitted requests before cleanup. A confirmed owned fork is removed after failure unless explicitly retained. A failed fork request with an unconfirmed identity never grants cleanup ownership. SIGKILL and machine shutdown cannot run cleanup.

Generated temporary field settings are restored through guarded cleanup. Conservative repair reads the sibling companion directly, never evaluates the TypeScript module, and never reconstructs edited intent. It restores a field only when its settings match the recorded temporary state, and an original missing future schedule only when the record still matches the original content. It cannot infer desired schedules from edited code or resume content writes. Ambiguous states require manual review.

```sh
npx datocms content:apply ./migrations/content/1791200000_syncContent.ts \
  --repair --destination=main --allow-primary
```

## Native schema migrations

Keep content scripts under `migrations/content/` and execute them with `content:apply`. Use native `migrations:run` for schema migrations. Run schema changes before generating the content diff. The plugin preserves validated schema-migration tracking records and does not participate in the native pending-migration queue.

## Supported behavior and limits

- Current and published content, nested blocks, structured text, typed references, ordering, workflows, assets, folders, and schedules are planned together. Folder sibling positions and unique names are checked before writes.
- Supported publication cycles use provisional direct links followed by republication. In-place execution can briefly expose a record without those links and add an extra published version. Cycles that cannot be broken safely, including some cycles entirely inside blocks or structured text, are rejected or isolated by partial mode. Required-link relaxation needs temporary-schema authorization.
- Unsafe block ownership changes or recreation that silently substitutes defaults are refused. Writes cannot reproduce unsafe SDK file/gallery metadata, including reserved `__proto__`, `__itemTypeId`, and metadata objects with `type: "item"`; such values can remain unchanged. Opaque JSON field text retains its ordinary meaning.
- Integer fields, integer defaults, and integer-valued validator settings must stay within JavaScript's safe range, ±9,007,199,254,740,991. Floating-point fields retain normal number semantics.
- Ordered destination records retain their positions unless intentionally changed. Conflicting final positions in the same sortable/tree sibling group are fatal; partial mode does not bypass an ordering conflict.
- IDs or asset URLs embedded in arbitrary JSON/text are not typed dependencies. Referenced-asset selection and deletion protection cannot infer those relationships.
- New records/uploads belong to the account or token running the migration. Version history, original creators, and read-only timestamps are not copied. Writable `created_at` and `first_published_at` are preserved where supported.
- Content writes can trigger configured webhooks. Forks carry schedules that may run even before promotion. Fast forks temporarily block writes and may interfere with schedules due during the copy; plan an appropriate quiet window.
- The complete destination namespace is checked even for a small edit. Unpaginated schema, folder, and reference endpoints remain API-side limits. SQLite working data and staged assets can require substantial temporary disk space.

Both commands support `--json` and standard CLI logging flags. Authentication credentials are redacted from request logs and surfaced errors. The diff JSON result contains `scriptPath`, source/destination environment IDs, and change counts. JSON failures preserve `keptForkEnvironmentId` for an intentionally retained owned fork and `unconfirmedForkEnvironmentId` when creation could not be acknowledged. Unconfirmed environments are never automatically deleted.

## Development

```sh
npm run build
npm run typecheck
npm test
npm run package:check
```

Tests cover generated execution order, real CMA results, edited scripts, baseline integrity, plugin boundaries, interruption, repair and cleanup. Synthetic scale measurements and previous live runs of the retired execution architecture do not establish full-transfer throughput for this direct execution version.
