# DatoCMS content migrations

Generate editable TypeScript migrations from content differences between DatoCMS environments or projects. Review the actual CMA calls, edit them if needed, then apply with destination checks, dependency planning, and final verification.

The plugin adds `content:diff` and `content:apply` to the unmodified DatoCMS CLI. Generate and execute content migrations through these plugin commands. Native `migrations:new --autogenerate` and `migrations:run` remain the separate schema migration workflow.

## Setup

Requires Node.js 22.13+ on the 22.x line, or Node.js 24+. Node 22 may print an experimental SQLite warning to stderr.

No custom CLI build or native migration-runner extension is required. When testing an unreleased plugin, install its local package or tarball in place of the registry plugin below.

Install both packages in the project containing your migrations, and register that local plugin with the CLI:

```sh
npm install --save-dev datocms @datocms/cli-plugin-content-diff
npx datocms plugins:link ./node_modules/@datocms/cli-plugin-content-diff
```

The generated TypeScript imports `@datocms/cli-plugin-content-diff/migration`. That import must resolve from the migration file. Installing a CLI plugin only with `plugins:install`, in a separate CLI plugin directory, does not necessarily make it available to the project's migration scripts.

Use the CLI's existing profiles, linked-project OAuth authentication, token environment variables, or `--api-token`.

## Generate and review

```sh
npx datocms content:diff syncContent \
  --source=staging \
  --destination=primary
```

This creates a native-style file such as `migrations/content/1791200000_syncContent.ts` and its sibling `1791200000_syncContent.content/` directory. The default directory is the `content/` subdirectory of the destination profile's `migrations.directory`, resolved relative to the configuration file, or `./migrations/content`. This keeps content scripts outside native schema migration discovery. The optional name defaults to `contentMigration`.

`--output=./review/content.ts` chooses an exact filename. `--output=./review` chooses a directory and keeps automatic timestamped naming. Existing scripts and companion directories are never overwritten.

A small generated migration contains readable operations like this:

```ts
import { join } from 'node:path';
import type { Client } from 'datocms/lib/cma-client-node';
import { defineContentMigration } from '@datocms/cli-plugin-content-diff/migration';

export default defineContentMigration(
  {
    baseline: join(__dirname, '1791200000_syncContent.content'),
    allowTemporarySchemaChanges: false,
  },
  async (client: Client): Promise<void> => {
    await client.items.update('AbCdEfGhIjKlMnOpQrStUv', {
      summary: { en: 'Updated procurement guidance.' },
    });
  },
);
```

**The TypeScript calls define the intended changes.** Apply records those calls locally, rebuilds the complete desired state and dependency plan, and checks it before submitting content writes. Editing a payload changes what will be applied. A field omitted from an update keeps its destination value. Records the script does not mention are preserved.

The supplied client supports the content operations the planner can prove safe; unsupported methods or properties are rejected. Creates need explicit portable IDs so links, blocks, and later operations can refer to the same identities. Record changes must stay within the model scope selected during generation. Align source and destination schemas before generating a content migration.

Generated migrations are **trusted executable Node.js code**. Only calls made through the supplied recording client follow the managed content workflow. Arbitrary imports, filesystem access, and other code are not sandboxed.

### Generation options

`--source` accepts an environment ID or `primary`; `--destination` defaults to `primary`. Generation captures both complete managed namespaces, including expanded current and published blocks, and checks consistency. Model selection limits intended changes, while other content supplies dependency and preservation evidence.

| Flag | Default | Behavior |
| --- | --- | --- |
| `--item-types=article,page` | `all` | Select regular model API keys for changes. |
| `--uploads=referenced` | `referenced` | Include assets referenced by selected content, or use `all`. |
| `--include-deletions` | Off | Emit safe destination-only deletions within scope. |
| `--allow-partial` | Off | Allow only proven isolated skips and their dependency closure. |
| `--allow-temporary-schema-changes` | Off | Permit planning supported temporary validator/default changes. |
| `--verification=versions` | `versions` | Choose version-based or full consistency checks. |
| `--concurrency=8` | `8` | Bound independent requests to 1–16. |
| `--chunk-bytes=1048576` | `1048576` | Target TypeScript part size, from 1 to 16,776,192 bytes; never split an operation. |

For separate projects, select both profiles:

```sh
npx datocms content:diff syncContent \
  --source=main --destination=main \
  --source-profile=source-project \
  --destination-profile=target-project
```

The projects must have compatible managed schemas and public IDs. Both captures run concurrently because the projects have separate API rate limits. `--source-api-token` and `--destination-api-token` override their respective profile authentication. Paired profiles cannot be combined with `--profile` or `--api-token`.

### What the companion directory contains

Keep the `.ts` file and its `.content` directory together. The companion stores a checksummed baseline: schema and project bindings, guards for all destination identities, complete original values for content changed at generation, exact source validity evidence, and required asset binaries. Intended values come from the TypeScript; the companion contains no authoritative desired-content plan.

Large migrations put actual CMA calls in TypeScript parts inside the companion directory. The entrypoint executes each part through a disposable worker, so compiled modules do not accumulate across the entire migration. One large operation may exceed the target part size. Every emitted TypeScript file must fit within 16 MiB including headers; oversized operations or files fail generation without leaving partial output.

Edit the TypeScript, including parts when present. Keep baseline metadata and binaries unchanged. Checksums detect corruption and incomplete copies, not deliberate tampering by someone who can also replace the checksums. Artifacts contain project content and exclude client authentication credentials.

### Validation after edits

Unedited generated values reuse exact captured validity evidence, including invalid drafts and supported new records linking to each other. Edited values without matching evidence are checked with CMA validation endpoints before writes; these calls do not save content.

Some edited values cannot be proven against the current destination: references to records that exist only in the future migration, changed or new uploads, or nested/default behavior that would validate a different value. Such edits are refused rather than assigned an invented validity result. This limitation does not reject an unchanged generated dependency cycle whose exact source evidence is available.

Invalid drafts can be preserved where the model permits them. Writes that require temporary validators or default suppression need explicit authorization. Field settings are restored afterwards; DatoCMS determines the final validity flags.

## Apply

```sh
npx datocms content:apply ./migrations/content/1791200000_syncContent.ts \
  --profile=target-project
```

Apply checks the companion, destination project/schema, and complete baseline, executes the TypeScript against the local recorder, and rebuilds its safety plan. It applies into a new isolated destination fork by default and reports its environment ID. It never promotes the fork automatically. `--destination=ENVIRONMENT_ID` selects another destination only if it satisfies the same project, schema, and baseline checks.

| Flag | Behavior |
| --- | --- |
| `--in-place` | Write directly into the destination environment. |
| `--allow-primary` | Additionally authorize primary writes; requires `--in-place` or `--repair`. |
| `--keep-failed-fork` | Keep a fork created by this apply after failure. |
| `--schedule-window=120` | Refuse schedules falling due within this many minutes; `0` disables this check. |
| `--repair` | Restore eligible schedules and temporary field settings after an interrupted in-place run. |
| `--fast-fork` | Use DatoCMS's fast fork, making the destination read-only while it copies. |
| `--verification=versions` | Use version-based checks, or `full` to reread all records. |
| `--allow-temporary-schema-changes` | Authorize supported temporary changes required by the rebuilt plan. |
| `--concurrency=8` | Bound independent requests to 1–16; dependent writes retain their required order. |

Only records being written have their schedules cancelled and later restored to the exact intended future dates. Other schedules are left alone. The schedule window includes existing destination schedules and intended schedules. Temporary field settings are restored before success. On failure, an owned fork is deleted unless explicitly retained; pre-existing environments are never deleted.

### Keep schema and content execution separate

Use `migrations:run` for schema scripts and `content:apply SCRIPT.ts` for content scripts. Content execution owns its fork, authorization, interruption handling and cleanup entirely within the plugin. It does not create native migration receipts or participate in the native runner's pending-script queue.

Keep content scripts in the default `migrations/content/` subdirectory or another directory outside native script discovery. If `--output` points into the schema migration directory, move the generated script and its companion together before running schema migrations. Direct invocation of a content script through `migrations:run` is rejected before content execution; that runner may already have created its own fork and tracking model.

Run required schema migrations before generating the content diff, against the aligned environments. Subsequent schema or content changes can invalidate the captured baseline. Use the same `migrations.modelApiKey` as at generation: the plugin preserves existing, validated schema migration receipts by excluding their exact tracking-model identity from content synchronization. A missing, replaced or newly introduced tracking model fails the baseline checks.

Content application controls are flags on `content:apply`, including `--concurrency`, `--verification`, `--schedule-window` and `--allow-temporary-schema-changes`. Repair uses the script's optional `defineContentMigration` `concurrency` setting for reconstruction reads.

### Interruptions and repair

Generation and application are one-shot operations: no pause, resume, checkpoints, or saved execution progress. Temporary SQLite databases and staging files are removed on success or failure. Completed scripts and companions remain available for review.

SIGINT, SIGTERM, and SIGHUP stop queued work, drain submitted operations, and run restoration and cleanup. A pending CMA operation can delay cleanup. SIGKILL and machine shutdown cannot run cleanup; use a persistent terminal session for long runs.

Forced termination can leave owned `content-diff-*` temporary directories or `.content-migration-*` staging directories beside the output. Remove those only after confirming the run has stopped; they cannot be used to resume it.

After an interrupted in-place run, retain the exact script used for that run and execute:

```sh
npx datocms content:apply ./migrations/content/1791200000_syncContent.ts \
  --repair --destination=main --allow-primary --profile=target-project
```

Repair reconstructs the original baseline locally, replays the script to recover its intent, and restores only eligible field settings and schedules. It does not reapply record content or resume the failed run. Original-content records can receive their original schedules; records already matching the intended content can receive the intended schedules. Ambiguous states, expired schedules, and validity that would require saving a record are reported.

Automatic repair requires enough original evidence. If a script edit changed a previously unchanged identity whose original payload was not stored, its live guard may no longer allow reconstruction. Repair also refuses unrelated schema changes, changed migration-tracking identity, and edited validity that cannot be checked while temporary rules remain. Keep the original script and companion, and investigate reported refusals rather than repeatedly applying the migration.

## Concurrency and verification

DatoCMS provides no persistent public sandbox write freeze. Maintenance mode applies only to primary and is not an immutable snapshot or transaction. Capture checks, focused live guards, and final verification detect observed conflicts; another writer can still act between a check and its write. Stop competing writes for generation and execution.

`--verification=versions` uses current-version IDs and published-version timestamps to avoid rereading unchanged records. Changed versions are read fully and compared. `--verification=full` rereads every record in each consistency/final check and costs more requests.

Some native operations rewrite values without a new record version, including upload URL changes and schema-driven changes. Schema fingerprints catch managed schema changes, and apply forces full record checks when its asset changes require them. An unrelated writer's URL rewrite can still escape a version-based capture check. Full verification gives stronger reads but does not freeze the environment.

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

Both commands support `--json` and standard CLI logging flags. Authentication credentials are redacted from request logs and surfaced errors. The diff JSON result contains `scriptPath`, source/destination environment IDs, and change counts.

## Development

```sh
npm run build
npm run typecheck
npm test
npm run package:check
```

Tests cover generation, executable TypeScript edits, baseline integrity, recorded intent, dependency planning, plugin-only execution, execution, interruption, repair, and cleanup. Memory and throughput claims require separate measurements: an incremental apply on a populated project does not establish full-transfer throughput, and synthetic scale tests do not establish a 600,000-record live TypeScript migration.
