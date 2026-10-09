# DatoCMS content migrations

Generate editable TypeScript migrations from the content differences between two DatoCMS environments or projects. `content:diff` compares the content, plans the dependency order and writes the result as ordinary CMA calls. `content:apply` checks that the destination still matches what generation saw, then runs the script against the real CMA client, in a new fork by default.

The plugin adds `content:diff` and `content:apply` to the unmodified DatoCMS CLI. It does not change native schema migrations or write their migration receipts.

## Setup

Requires Node.js 22.23.1+ on the 22.x line, or Node.js 24.18+, for the built-in `node:sqlite` module. Node 22 may print an experimental SQLite warning to stderr. SQLite is only local temporary storage; it needs no server or account.

Install both packages in the project that holds your migrations and register the plugin:

```sh
npm install --save-dev datocms @datocms/cli-plugin-content-diff
npx datocms plugins:link ./node_modules/@datocms/cli-plugin-content-diff
```

Generated scripts import `@datocms/cli-plugin-content-diff/migration`, so the package must resolve from the migration directory. Installing it only with `plugins:install`, in the CLI's own data directory, does not make those imports resolve.

Authentication follows the native CLI: `--api-token`, then the OAuth token of a project linked with `datocms link`, then the profile's token environment variable (`DATOCMS_API_TOKEN` for the default profile, `DATOCMS_<PROFILE>_PROFILE_API_TOKEN` otherwise, or the profile's `apiTokenEnvName`). The token must be able to read every model and every upload of the environments involved without restrictions; generation and the apply-time checks refuse with `UNPROVEN_FULL_ACCESS` otherwise. An API token's role must also be allowed to manage upload collections; account, organization and full-access admin tokens are exempt.

## Generate

```sh
npx datocms content:diff syncContent --source=staging --destination=primary
```

Generation resolves both environments, reads their schemas and refuses incompatible schemas before reading any content (see [Schema compatibility](#schema-compatibility)). It then reads both complete content namespaces once into temporary SQLite (current and published values, nested blocks, schedules, uploads and upload folders), plans the changes and writes the script. The plugin takes no lock on either environment: keep content and schemas unchanged while generation runs.

The configured schema-migration tracking model (the profile's `migrations.modelApiKey`, `schema_migration` by default) is left out of the comparison, and its exact ID is recorded so that apply can tell if it was replaced.

The output is a timestamped file such as `migrations/content/1791200000_syncContent.ts` next to its `1791200000_syncContent.content/` companion directory. The default directory is the `content/` subdirectory of the destination profile's migrations directory, or `./migrations/content`, so the native schema runner never picks the scripts up. Existing output is never overwritten.

| Argument or flag | Default | Behavior |
| --- | --- | --- |
| `NAME` | `contentMigration` | Migration name, camel-cased into the timestamped filename. |
| `--source` | Required | Source environment ID, or `primary`. |
| `--destination` | `primary` | Destination environment ID, or `primary`. |
| `--output` | Timestamped file in the default directory | A path ending in `.ts` names the exact file; a path without an extension, or an existing directory, is a directory for a timestamped file. Any other path is refused. |
| `--item-types=article,page` | `all` | Regular model API keys whose records the script may change. |
| `--uploads` | `referenced` | `referenced` manages the uploads that managed records reference in either environment, and the folders containing them (with their ancestors); `all` manages every upload and folder. |
| `--include-deletions` | Off | Delete destination-only records, uploads and folders within the scope, after the writes that drop references to them. |
| `--allow-partial` | Off | Skip content the script cannot reproduce, and the writes that need it, instead of failing. |
| `--concurrency` | `8` | Maximum concurrent independent requests, from 1 to 16. |
| `--chunk-bytes` | `1048576` | Target size of each TypeScript part and each baseline chunk file, up to 16 MiB minus 1 KiB (the cap of a companion file); a single operation is never split. |

The model selection limits which records the script changes. Unselected records are still read, because selected records may reference them and deletions must know what still points at a record.

For separate projects, select both profiles:

```sh
npx datocms content:diff syncContent \
  --source=main --destination=main \
  --source-profile=source-project --destination-profile=target-project
```

`--source-profile` and `--destination-profile` go together. `--source-api-token` and `--destination-api-token` override the token of their profile. Paired profiles cannot be combined with `--profile` or `--api-token`. The two projects are read concurrently, since they have separate rate limits. Records, uploads and folders are matched by ID, and the schema check requires the same model and field IDs on both sides, so this only works between projects whose schemas share their IDs: two projects whose schemas were built separately are refused as incompatible, even when they look identical.

### Schema compatibility

Generation compares structure only. Locales, the environment's timezone and its `improved_*`, `milliseconds_in_datetime` and `non_localized_focal_points` settings, and workflows (IDs and stage IDs) must match. Every selected model and every block model must exist in the destination with the same ID, API key, `block`, `singleton`, `sortable`, `tree`, draft mode and workflow, and the same fields compared by ID, API key, type and localization. Names, validators, default values, appearance and hints are ignored: the CMA validates every write when the script runs. Apply still checks a hash of the destination schema that includes some of these settings (see [Apply](#apply)).

Run schema migrations first, with native `migrations:run`, then generate the content diff.

### What the planner refuses

The plugin never predicts whether the CMA will accept a write. It refuses only what the generated script could not reproduce faithfully:

- values the SDK would corrupt when sending them back: an own `__proto__` key, `__itemTypeId`, or a metadata object with `type: "item"` in file or gallery values (`UNSUPPORTED_PAYLOAD_KEY`);
- publication cycles that leaving top-level `link`/`links` values out of a first publication cannot break (`PUBLICATION_CYCLE`);
- references to records created by the script whose containing field cannot be identified (`UNSUPPORTED_CREATION_REFERENCE`).

Without `--allow-partial` the first refusal fails generation (`UNSAFE_REQUESTED_CHANGE`). With it, the refused entry is skipped, along with the writes that reference a skipped new record and the deletions of anything a skipped entry still references. A skipped update keeps its record's destination state, so nothing that state references is deleted, but writes to other records that reference it go ahead. Each skipped entry is reported with its reason.

### Invalid source records

Invalid records cannot be diffed. The CMA only accepts an invalid record as a draft in a model with draft mode and "Save invalid drafts" enabled, so the script could not reproduce any other invalid record. After planning, and before writing any file, generation checks every source record the script would create or update against the source CMA's own verdict (`is_current_version_valid` and `is_published_version_valid`):

- an invalid published version always stops generation;
- an invalid current version stops it, unless the destination model has draft mode with "Save invalid drafts" enabled (the CMA applies the destination's setting when the script writes the draft).

Generation then fails with `INVALID_SOURCE_RECORDS`, listing the records (the first 20 in the message, all of them in the JSON `details.records`). Fix them in the source environment and run `content:diff` again. Records the script does not write are not checked, and `--allow-partial` does not skip them. The plugin evaluates no validators itself: it reads the source CMA's verdict, which the CMA updates in the background after a schema change, so a check right after a validation change can still see the previous verdict.

Integers outside JavaScript's safe range (±9,007,199,254,740,991) in record values are refused earlier, during capture, with `UNSUPPORTED_INTEGER_PRECISION`. They always fail generation, even with `--allow-partial`.

## Review and edit the script

A small migration holds ordinary awaited CMA calls:

```ts
import { join } from 'node:path';
import {
  type ContentMigrationClient,
  defineContentMigration,
} from '@datocms/cli-plugin-content-diff/migration';

export default defineContentMigration(
  { baseline: join(__dirname, '1791200000_syncContent.content') },
  async (client: ContentMigrationClient): Promise<void> => {
    // Update Article "Hello world" (AbCdEfGhIjKlMnOpQrStUv)
    await client.items.update('AbCdEfGhIjKlMnOpQrStUv', {
      title: 'Hello world',
      meta: { current_version: '1234567' },
    });
  },
);
```

`ContentMigrationClient` is the `@datocms/cma-client-node` `Client` (the client the DatoCMS CLI builds) bound to the environment being migrated. Every call runs immediately against the CMA and returns its real response. `defineContentMigration` attaches the baseline declaration to the callback. The script imports only the runtime helpers it uses: `defineContentMigration`, plus `runMigrationPart` and `reorderRecords` when needed.

Calls are emitted in this order, each with one comment naming the action, the model, the record title when there is one, and the ID:

1. folder creates (parents first) and updates;
2. upload creates, file replacements and metadata updates;
3. record creates. A create sends empty (`[]` for Modular Content and multiple-links fields, `null` otherwise) every field that references a record not created yet or, for models without draft mode (which publish on create), a record not published yet; the whole field is emptied, blocks and Structured Text included, and the publication or update phase writes the full value. Records that reference each other are created in an order that tries to leave out few such fields, and only fields referencing a record created later are emptied;
4. publications and unpublications, including the update that writes the published values before each publish, provisional first publications and the republications that break publication cycles, and tree moves (`parent_id`), so a record moves under its new parent before it is published there and leaves a parent before that parent is unpublished (a moved record that this run does not publish gets its draft changes in the same update, unless the update phase publishes them again);
5. updates of current drafts, workflow stages, `created_at` and `first_published_at`, each followed by a publish when it changes the fields of a published draft-mode record that has no unpublished changes in the source;
6. record, upload and folder deletions (folders deepest first);
7. one `client.uploadCollections.reorder([...])` when any folder changes, listing every final folder at its desired position;
8. one `reorderRecords(client, { model, parent, order })` per sortable or tree sibling group that gains records or whose order changes (a group that only loses records keeps its order and gets no call);
9. schedule changes, only for records whose schedules differ.

**Optimistic locking.** The first `items.update` of a record that already exists in the destination carries `meta: { current_version }` with the version recorded at generation, unless another write to that record comes first or an earlier tree move out of its sibling group renumbers it. If someone edits the record while the migration runs, the CMA rejects the update and apply reports `RECORD_CHANGED_DURING_APPLY` instead of overwriting the edit.

**Blocks.** Updates send only the fields that change. Inside a changed Modular Content, single block or Structured Text field, a block that keeps its ID in the same field and locale is sent as its bare ID when unchanged, or as `{ id, type: 'item', attributes }` with only its changed attributes; new blocks are sent in full with their block model.

**Uploads.** The companion stores no files. New uploads use `client.uploads.createFromUrl` and replaced files `client.uploads.updateFromUrl`, both fetching the original file from the source upload URL captured at generation, followed by an MD5 check that fails with `Asset <id> changed in the source since the diff generation. Please re-generate a diff to apply.` when the source file changed. The source uploads must therefore still exist when the script runs. Metadata-only changes use `client.uploads.update` with the changed attributes.

**Ordering.** Record creates send no `position`, and tree creates and moves send only `parent_id`. `reorderRecords` then lists the sibling group, refuses with `ORDERING_MEMBERS_DIFFER` when its members differ from `order` (naming the extra and missing IDs), moves only the out-of-place records to the positions the group already uses, reads the result back and fails with `ORDERING_NOT_APPLIED` if the order still differs after three passes. A group already in order costs one listing and no writes. Unchanged groups get no call.

**Editing.** Edits change what is sent to the CMA, and the CMA validates every write. Keep edited operations in a valid order (a unique value must be released before another record takes it; a referenced record must exist, and be published, before a published record links to it) and update any related publication, ordering and schedule calls. When you add or remove records of a sibling group, update its `order` list. Await every call.

**Large migrations.** When the script exceeds `--chunk-bytes`, its operations move into sequential parts in the companion's `parts/` directory and the main file runs them in order:

```ts
for (const part of ['000001.ts', '000002.ts'])
  await runMigrationPart(client, join(__dirname, '1791200000_syncContent.content', 'parts', part));
```

`runMigrationPart` loads each part in the same process through the same public `tsx` API as the main script, awaits its default export with the same client, and drops it from the module cache before the next part loads. `tsx` keeps each compiled part in memory until the process ends, so memory grows with the total size of the parts.

TypeScript loads through `tsx`: run from the project directory so its tsconfig and path aliases apply, or set `TSX_TSCONFIG_PATH`. Generated files are formatted with the project's Prettier configuration. Scripts, their imports and the formatter configuration are trusted Node code, not a sandbox; requests made by clients the script builds itself are outside apply's request tracking.

## Companion directory

Keep the `.ts` file and its same-named `.content` directory together; apply only accepts a script whose `baseline` points at that sibling directory. The companion holds:

- `manifest.json` and its `manifest.sha256`: the format (`datocms-content-migration-baseline/1`), the creation time, source and destination project and environment IDs, the projected destination schema (its hash covers the whole projection, model names, validators and defaults included), the tracking-model bindings, the generation options, the planned counts and the chunk index descriptor;
- `chunks.jsonl`: the SHA-256, byte count and entry count of every baseline chunk;
- `baseline/NNNNNN.jsonl`: one guard row per destination record, upload and folder as generation observed them;
- `parts/NNNNNN.ts`, when the script is split.

The companion is evidence about the destination, not a plan: the TypeScript holds the operations. Edit the script and its parts freely; leave the manifest and baseline files untouched. Checksums detect corruption and incomplete copies, not deliberate tampering by someone who can replace the checksums too. Artifacts contain project content, never credentials.

## Apply

```sh
npx datocms content:apply ./migrations/content/1791200000_syncContent.ts
```

Apply loads the script and checks the companion's checksums, sizes and entry counts. It then checks that the destination belongs to the recorded project (`DESTINATION_MISMATCH` otherwise), is ready and writable when applying in place, and still matches the generation baseline: the destination schema hash, then every record, upload and folder of the complete namespace, with no identity added or removed. The schema hash covers the locales, the environment settings listed under [Schema compatibility](#schema-compatibility), workflows (IDs, API keys, stage IDs, names and initial stages), and every model's ID, API key, name, `block`, `singleton`, `sortable`, `tree`, draft mode, draft-saving and all-locales-required settings, workflow and fields (ID, API key, type, localization, validators and default value). Changing any of these in the destination, a model rename or a field API key change included, needs a new diff; field labels, hints, appearance, fieldsets, field order and other presentation settings are not part of it. Any difference fails with `DESTINATION_CHANGED`:

```
The destination environment has changed since the diff generation. Please re-generate a diff to apply.
First difference: record AbCdEfGhIjKlMnOpQrStUv was changed.
```

By default it then creates a new fork of the destination with DatoCMS's fast fork, waits for it with progress output, checks the same baseline in the fork, and runs the script there. It reports the environment it ran in and never promotes a fork.

| Argument or flag | Default | Behavior |
| --- | --- | --- |
| `SCRIPT` | Required | The generated `.ts` entrypoint. |
| `--preflight-only` | Off | Check the artifact, read access and the destination baseline without evaluating the script or creating a fork. |
| `--fork-name=content-review` | `content-apply-<UUID>` | ID of the new fork; an existing environment ID is refused. Cannot be combined with `--in-place`. |
| `--destination=ENVIRONMENT_ID` | The recorded destination | Apply against another environment of the same project that matches the baseline. |
| `--in-place` | Off | Run the script directly in the destination instead of a fork. |
| `--allow-primary` | Off | Permit in-place writes to the primary environment; requires `--in-place`. |
| `--keep-failed-fork` | Off | Keep the fork after a failure instead of deleting it. Cannot be combined with `--preflight-only`. |
| `--no-fast-fork` | Fast fork | Create a regular fork instead of DatoCMS's fast fork. A fast fork blocks writes to the destination while it copies, so destination schedules due during the copy may not run, and DatoCMS refuses it while users are editing records (`FAST_FORK_BLOCKED`). |
| `--verification` | `versions` | How a baseline capture is confirmed: `versions` lists record versions once more (uploads and folders are reread in full); `full` rereads everything. In fork mode only the fork's capture is confirmed, since a change during the destination capture is carried into the fork. |
| `--concurrency` | `8` | Maximum concurrent baseline read requests, from 1 to 16; script calls run as written. |

`--preflight-only` only checks that the script is a regular file, without reading or evaluating it, so it does not run, preview or validate the script's calls, and the generation counts it reports describe the generated script, not later edits. A later apply repeats every check.

### Failures

CMA errors raised by the script are reported once, with the request and the CMA's error codes:

- `CMA_VALIDATION_FAILED` for a 422, such as `The CMA rejected PUT /items/AbCdEfGhIjKlMnOpQrStUv: INVALID_FIELD (title: VALIDATION_REQUIRED).`, with a hint when a unique value is still held by another record or a reference is missing or unpublished;
- `RECORD_CHANGED_DURING_APPLY` when a locked update finds a newer version;
- `CMA_REQUEST_FAILED` for any other CMA error, and for a request that timed out (a timed-out write may still have been applied).

In fork mode the fork is deleted after a failure, unless `--keep-failed-fork` is set, and the message says whether it was deleted or kept and that the destination was not changed. In place, the message says that writes made before the failure remain. There is no transaction around the migration: stop competing writes while it runs.

A script that returns while CMA writes are still running, or that leaves a call unawaited which is then refused or fails, fails with `UNAWAITED_MIGRATION_CALL` once every request settles. Reads still in flight are only drained. Detection only sees requests: an unawaited `uploads.createFromUrl` or `uploads.updateFromUrl` (or a `runMigrationPart` whose part starts with one) does local file work and a download before its first write, so a script that returns during that time is reported as a success and the upload is refused afterwards. Always `await` every call.

## Interruptions

Generation and apply are one-shot operations, with no pause, resume or saved progress. On `SIGINT`, `SIGTERM` or `SIGHUP` the command stops starting new work. During apply, new writes are refused while requests already sent finish (reads keep flowing so SDK jobs already submitted can be observed); cleanup then deletes a fork created by the run unless `--keep-failed-fork` is set. A second signal does not skip cleanup. Temporary SQLite and staging files are removed on completion and on failure. `SIGKILL` and machine shutdown cannot run cleanup.

## Native schema migrations

Keep content scripts under `migrations/content/` and run them with `content:apply`; run schema migrations with native `migrations:run`. Content scripts do not take part in the native pending-migration queue, and the schema-migration tracking model is never part of a content migration.

## Behavior and limits

- Current and published content, nested blocks, structured text, typed references, workflow stages, sortable and tree ordering, uploads, upload folders and schedules are planned together.
- Publication cycles between records are broken by publishing first without the top-level links to records published later, then publishing again with them. Running in place can briefly expose a record without those links and adds an extra published version. Cycles made only of links inside blocks or structured text cannot be broken this way.
- IDs or upload URLs embedded in arbitrary JSON or text fields are not typed references; referenced-upload selection and deletion ordering cannot see them.
- New records and uploads belong to the account or token running the migration. Version history, original creators and read-only timestamps are not copied; writable `created_at` and `first_published_at` are.
- Content writes trigger configured webhooks. Forks carry schedules that may run before promotion.
- Apply does not pause scheduled publications or unpublishings. A schedule that runs during the baseline checks fails them with `DESTINATION_CHANGED`. One that runs while the script runs is not detected, because publishing and unpublishing do not change the version that record locks compare: it can publish or unpublish a record the script has only partly written, the script's later writes can override it, and a generated call that removes a schedule which has already run fails the script. While the default fast fork copies, the destination is read-only, so a destination schedule due during the copy may not run; `--no-fast-fork` avoids this.
- The complete destination namespace is checked even for a small change. Schema, workflow and folder endpoints are read unpaginated, as the API serves them. SQLite working data can need substantial temporary disk space.

## Output and errors

Both commands support `--json` and the standard CLI logging flags (`--log-level`, `--log-mode`). With `--json`, `content:diff` returns `scriptPath`, `sourceEnvironmentId`, `destinationEnvironmentId`, `counts` (`record`, `upload` and `collection` objects, each with `create`, `update`, `delete`, `noop` and `skip` counts; `collection` means upload folders, here and wherever the output names a `kind`) and `skipped` (`{ kind, id, code, message }` for each reason an entry was skipped; without `--json` these are printed to stderr). `content:apply` returns `environmentId`, `scriptExecuted` and `partial` (whether generation skipped content), plus `preflightOnly` and `generatedCounts` for a preflight. Failures print `{ "error": { name, message, code, details, suggestions, keptForkEnvironmentId? } }`, where `keptForkEnvironmentId` appears when a fork created by the run still exists.

Request logs and API errors never contain the API token: the SDK masks the `Authorization` header (this relies on `@datocms/rest-client-utils` 6.1.1 or later, which the plugin depends on).

## Development

```sh
npm run build
npm run typecheck
npm run typecheck:test
npm test
npm run package:check
```

The tests are synthetic and need no network or credentials. They generate scripts from captured states, typecheck them against the SDK types and run them against an in-memory CMA, and cover baseline integrity, the apply checks, fork cleanup, request tracking, interruption and the command contracts. See `docs/design.md` for the design.
