# DatoCMS content diffs

Move content between DatoCMS environments, projects and backups. `content:export` writes an environment to a project dump. `content:diff` compares a source (a live environment or a dump) with a destination environment and writes a diff: the ordinary CMA calls that bring the destination to the source, in dependency order. `content:apply` checks that what the diff touches has not changed in the destination, then runs it, in a new fork by default.

Dumps and diffs are zip files of JSON Lines, so every step streams: none of them holds a whole project in memory. The plugin adds these commands to the unmodified DatoCMS CLI. It does not change native schema migrations or write their migration receipts.

## Setup

Requires Node.js 18 or later, like the DatoCMS CLI.

```sh
npm install --save-dev datocms @datocms/cli-plugin-content-diff
npx datocms plugins:link ./node_modules/@datocms/cli-plugin-content-diff
```

Authentication follows the native CLI: `--api-token`, then the OAuth token of a project linked with `datocms link`, then the profile's token environment variable (`DATOCMS_API_TOKEN` for the default profile, `DATOCMS_<PROFILE>_PROFILE_API_TOKEN` otherwise, or the profile's `apiTokenEnvName`). Reading an environment requires a token that can read every model and every upload without restrictions; the commands refuse with `UNPROVEN_FULL_ACCESS` otherwise. An API token's role must also be allowed to manage upload collections; account, organization and full-access admin tokens are exempt.

## Export

```sh
npx datocms content:export backup --environment=main
```

The dump is written to the current directory as `<seconds>_backup.dump-records.zip`, or `<seconds>_backup.dump-records-assets.zip` with `--include-assets`. Existing files are never overwritten.

| Argument or flag | Default | Behavior |
| --- | --- | --- |
| `NAME` | `dump` | Camel-cased into the timestamped file name. |
| `--environment` | `primary` | Environment ID to export, or `primary`. |
| `--include-assets` | Off | Also store the file of every asset, downloaded with its MD5 checked. Without it, a dump holds asset metadata and URLs only, so it cannot bring back an asset deleted from the project. |
| `--output` | Current directory | A path ending in `.zip` names the exact file; a directory gets a timestamped name. |
| `--concurrency` | `8` | Maximum concurrent read requests, from 1 to 16. |

A dump holds:

```
1791556200_backup.dump-records-assets.zip
├── manifest.json             format, plugin version, project, environment, locales, counts
├── schema.json               the site with its models and fields, and the workflows, as the CMA returns them
├── records/000001.jsonl …    one record per line: {"id", "current", "published", "scheduledPublication", "scheduledUnpublishing"}
├── uploads/000001.jsonl …    one upload per line, as the SDK's uploads.list returns it
├── upload-collections/…      one folder per line
└── assets/<id>/<filename>    asset files, only with --include-assets
```

Record versions are the CMA's JSON:API resources exactly as `GET /items?nested=true` returns them (blocks inline), and schedules are the resources the CMA returns for them, so a dump is readable with any JSON tool once unzipped. Each JSON Lines entry stays under 64 MB. Large dumps use ZIP64, which some archive tools (macOS Archive Utility among them) cannot open; `unzip` and most other tools can.

The export takes no lock: keep content unchanged while it runs. Reads that disagree, such as a page whose total changed or a record listed twice, stop it with `CAPTURE_DRIFT`.

## Diff

```sh
npx datocms content:diff syncContent --source=staging --destination=primary
npx datocms content:diff restore --source-dump=./1791556200_backup.dump-records.zip --destination=main
```

Generation resolves both sides, reads their schemas and refuses incompatible schemas before reading any content (see [Schema compatibility](#schema-compatibility)). It then reads both sides in full (current and published values, nested blocks, schedules, uploads and upload folders), plans the changes and writes the diff. The plugin takes no lock: keep content and schemas unchanged while generation runs.

A dump can be the backup of the destination itself: export `main` today, change it, and diff that dump against `main` to bring it back. The "same environment" refusal applies only when both sides are live environments.

The configured schema-migration tracking model (the profile's `migrations.modelApiKey`, `schema_migration` by default) is left out of the comparison, and its exact ID is recorded so that apply can tell if it was replaced. For a dump source, the destination profile's setting names it.

The diff is written as `migrations/content/<seconds>_syncContent.diff-records.zip`, in the `content/` subdirectory of the destination profile's migrations directory (or `./migrations/content`), where the native schema runner does not look. When the source is a dump with asset files and the diff uploads a file, the files are copied into the diff and its name ends in `.diff-records-assets.zip`. Existing files are never overwritten. Diffs can be large; add `migrations/content/*.zip` to `.gitignore` if you do not want them versioned.

| Argument or flag | Default | Behavior |
| --- | --- | --- |
| `NAME` | `contentMigration` | Camel-cased into the timestamped file name. |
| `--source` | | Source environment ID, or `primary`. Exactly one of `--source` and `--source-dump`. |
| `--source-dump` | | A dump from `content:export` to use as the source. Needs no source token. |
| `--destination` | `primary` | Destination environment ID, or `primary`. Always a live environment. |
| `--output` | Timestamped file in the default directory | A path ending in `.zip` names the exact file; a directory gets a timestamped name. Any other path is refused. |
| `--item-types=article,page` | `all` | Regular model API keys whose records the diff may change. |
| `--uploads` | `referenced` | `referenced` manages the uploads that managed records reference on either side, and the folders containing them (with their ancestors); `all` manages every upload and folder. |
| `--include-deletions` | Off | Delete destination-only records, uploads and folders within the scope, after the writes that drop references to them. |
| `--allow-partial` | Off | Skip content the diff cannot reproduce, and the writes that need it, instead of failing. |
| `--concurrency` | `8` | Maximum concurrent independent requests, from 1 to 16. |

The model selection limits which records the diff changes. Unselected records are still read, because selected records may reference them and deletions must know what still points at a record.

For separate projects, select both profiles:

```sh
npx datocms content:diff syncContent \
  --source=main --destination=main \
  --source-profile=source-project --destination-profile=target-project
```

`--source-profile` and `--destination-profile` go together. `--source-api-token` and `--destination-api-token` override the token of their profile. Paired profiles cannot be combined with `--profile` or `--api-token`, and `--source-dump` cannot be combined with the source profile flags. Separate projects, and a dump with its destination, are read concurrently. Records, uploads and folders are matched by ID, and the schema check requires the same model and field IDs on both sides, so this only works between projects whose schemas share their IDs.

### Schema compatibility

Generation compares structure only. Locales, the environment's timezone and its `improved_*`, `milliseconds_in_datetime` and `non_localized_focal_points` settings, and workflows (IDs and stage IDs) must match. Every selected model and every block model must exist in the destination with the same ID, API key, `block`, `singleton`, `sortable`, `tree`, draft mode and workflow, and the same fields compared by ID, API key, type and localization. Names, validators, default values, appearance and hints are ignored: the CMA validates every write when the diff runs. Apply still checks a hash of the destination schema that includes some of these settings (see [Apply](#apply)).

Run schema migrations first, with native `migrations:run`, then generate the content diff.

### What the planner refuses

The plugin never predicts whether the CMA will accept a write. It refuses only what the diff could not reproduce faithfully:

- values the SDK would corrupt when sending them back: an own `__proto__` key, `__itemTypeId`, or a metadata object with `type: "item"` in file or gallery values (`UNSUPPORTED_PAYLOAD_KEY`);
- publication cycles that leaving top-level `link`/`links` values out of a first publication cannot break (`PUBLICATION_CYCLE`);
- references to records created by the diff whose containing field cannot be identified (`UNSUPPORTED_CREATION_REFERENCE`).

Without `--allow-partial` the first refusal fails generation (`UNSAFE_REQUESTED_CHANGE`). With it, the refused entry is skipped, along with the writes that reference a skipped new record and the deletions of anything a skipped entry still references. Each skipped entry is reported with its reason.

### Invalid source records

Invalid records cannot be diffed. The CMA only accepts an invalid record as a draft in a model with draft mode and "Save invalid drafts" enabled. After planning, and before writing any file, generation checks every source record the diff would create or update against the source CMA's own verdict (`is_current_version_valid` and `is_published_version_valid`, which a dump keeps):

- an invalid published version always stops generation;
- an invalid current version stops it, unless the destination model has draft mode with "Save invalid drafts" enabled.

Generation then fails with `INVALID_SOURCE_RECORDS`, listing the records (the first 20 in the message, all of them in the JSON `details.records`). Integers outside JavaScript's safe range in record values are refused with `UNSUPPORTED_INTEGER_PRECISION`, even with `--allow-partial`.

## The diff file

```
1791559800_syncContent.diff-records.zip
├── manifest.json             what the diff was generated from and for, and its counts
├── operations/000001.jsonl … one operation per line, in the order they run
└── assets/<id>/<filename>    files to upload, only in a -records-assets diff
```

Each line is one CMA call:

```json
{"op":"record.update","id":"AbCdEfGhIjKlMnOpQrStUv","label":"Update Article \"Hello world\" (AbCdEfGhIjKlMnOpQrStUv)","expect":{"currentVersion":"1234567","publishedUpdatedAt":null},"data":{"title":"Hello world","meta":{"current_version":"1234567"}}}
```

| Operation | CMA call |
| --- | --- |
| `folder.create`, `folder.update`, `folder.delete` | `uploadCollections.create`, `update`, `destroy` |
| `folders.reorder` | `uploadCollections.reorder`, with every final folder at its position |
| `upload.create`, `upload.replace` | `uploads.createFromLocalFile` or `updateFromLocalFile` when `file` names an entry of the diff, otherwise `createFromUrl` or `updateFromUrl`; then an MD5 check |
| `upload.update`, `upload.delete` | `uploads.update`, `destroy` |
| `record.create`, `record.update`, `record.delete` | `items.create`, `update`, `destroy` |
| `record.publish`, `record.unpublish` | `items.publish`, `unpublish`, not recursive |
| `records.reorder` | the plugin's reorder routine (see below) |
| `schedule.publication.create`, `.delete` | `scheduledPublication.create`, `destroy` |
| `schedule.unpublishing.create`, `.delete` | `scheduledUnpublishing.create`, `destroy` |

`data` is the body passed to the SDK method, `label` is what progress and errors show, and `expect` sits on the first line that touches an existing record (its current version and published version time), upload or folder (a hash of what the diff compares). Any other operation, or a malformed line, makes apply refuse the whole diff before the first write, so an edited diff cannot make other calls, such as deleting an environment.

Operations run in this order:

1. folder creates (parents first) and updates;
2. upload creates, file replacements and metadata updates;
3. record creates. A create sends empty (`[]` for Modular Content and multiple-links fields, `null` otherwise) every field that references a record not created yet or, for models without draft mode (which publish on create), a record not published yet; the publication or update phase writes the full value. Records that reference each other are created in an order that leaves out few such fields;
4. publications and unpublications, including the update that writes the published values before each publish, provisional first publications and the republications that break publication cycles, and tree moves (`parent_id`), so a record moves under its new parent before it is published there and leaves a parent before that parent is unpublished;
5. updates of current drafts, workflow stages, `created_at` and `first_published_at`, each followed by a publish when it changes the fields of a published draft-mode record that has no unpublished changes in the source;
6. record, upload and folder deletions (folders deepest first);
7. one `folders.reorder` when any folder changes;
8. one `records.reorder` per sortable or tree sibling group that gains records or whose order changes;
9. schedule changes, only for records whose schedules differ.

**Optimistic locking.** The first update of a record that already exists in the destination carries `meta: { current_version }`, unless another write to that record comes first or an earlier tree move out of its sibling group renumbers it. If someone edits the record while the diff runs, the CMA rejects the update and apply reports `RECORD_CHANGED_DURING_APPLY` instead of overwriting the edit.

**Blocks.** Updates send only the fields that change. Inside a changed Modular Content, single block or Structured Text field, a block that keeps its ID in the same field and locale is sent as its bare ID when unchanged, or as `{ id, type: 'item', attributes }` with only its changed attributes; new blocks are sent in full with their block model.

**Uploads.** A diff from an environment, or from a dump without asset files, uploads new and replaced files from the source URL (with the original-file parameters, so default image optimizations and SVG sanitizing do not alter the bytes); the source uploads must still exist when the diff runs. Every upload is checked against the source MD5 and fails with `ASSET_CHANGED` when it differs.

**Ordering.** Creates send no `position`, and tree creates and moves send only `parent_id`. `records.reorder` lists the sibling group, refuses with `ORDERING_MEMBERS_DIFFER` when its members differ from `order` (naming the extra and missing IDs), moves only the out-of-place records to the positions the group already uses, reads the result back and fails with `ORDERING_NOT_APPLIED` if the order still differs after three passes.

**Editing.** To change a diff, unzip it, edit or delete lines, and zip it again. The CMA validates every write. If an edit breaks something, apply stops with the CMA's error; the plugin does not try to repair it.

## Apply

```sh
npx datocms content:apply ./migrations/content/1791559800_syncContent.diff-records.zip
```

Apply reads the manifest and checks that the destination belongs to the project the diff was generated for (`DESTINATION_MISMATCH` otherwise) and is ready and writable when applying in place. It then checks the destination schema hash and, reading the diff once, that every line is a valid operation, that every ID the diff creates is free, and that every record, upload and folder the diff touches is as it was at generation. The schema hash covers the locales, the environment settings listed under [Schema compatibility](#schema-compatibility), workflows, and every model's ID, API key, name, flags, workflow and fields (ID, API key, type, localization, validators and default value). Any difference fails with `DESTINATION_CHANGED`:

```
The destination environment has changed since the diff generation. Please re-generate a diff to apply.
First difference: record AbCdEfGhIjKlMnOpQrStUv was changed.
```

By default it then creates a new fork of the destination with DatoCMS's fast fork, waits for it with progress output, repeats the checks in the fork, and runs the operations there, one at a time and in order. It reports the environment it ran in and never promotes a fork.

| Argument or flag | Default | Behavior |
| --- | --- | --- |
| `FILE` | Required | The `.zip` diff. |
| `--preflight-only` | Off | Run the checks without creating a fork or running anything. |
| `--fork-name=content-review` | `content-apply-<UUID>` | ID of the new fork; an existing environment ID is refused. Cannot be combined with `--in-place`. |
| `--destination=ENVIRONMENT_ID` | The diff's destination | Apply against another environment of the same project. |
| `--in-place` | Off | Run directly in the destination instead of a fork. |
| `--allow-primary` | Off | Permit in-place writes to the primary environment; requires `--in-place`. |
| `--keep-failed-fork` | Off | Keep the fork after a failure instead of deleting it. Cannot be combined with `--preflight-only`. |
| `--no-fast-fork` | Fast fork | Create a regular fork. A fast fork blocks writes to the destination while it copies, so destination schedules due during the copy may not run, and DatoCMS refuses it while users are editing records (`FAST_FORK_BLOCKED`). |
| `--concurrency` | `8` | Maximum concurrent check requests, from 1 to 16; operations run one at a time. |

Only what the diff touches is checked. If something changes after generation, in the destination or in the diff, and that makes a write fail, apply stops with the CMA's error. In particular:

- records the diff does not touch are not checked. A destination record that starts linking to a record the diff deletes loses that link, as the field's `on_reference_delete_strategy` schema setting (by default `delete_references`) decides;
- scheduled publications and unpublishings are not paused. One that runs during the checks fails them; one that runs while the diff runs is not detected, because publishing does not change the current version a lock compares.

### Failures

A failed operation is reported with its place in the diff and the CMA's error codes, for example `operations/000001.jsonl line 42, Update Article "Hello world" (AbCdEfGhIjKlMnOpQrStUv): The CMA rejected PUT /items/AbCdEfGhIjKlMnOpQrStUv: INVALID_FIELD (title: VALIDATION_REQUIRED).`:

- `CMA_VALIDATION_FAILED` for a 422, with a hint when a unique value is still held by another record or a reference is missing or unpublished;
- `RECORD_CHANGED_DURING_APPLY` when a locked update finds a newer version;
- `CMA_REQUEST_FAILED` for any other CMA error, and for a request that timed out (a timed-out write may still have been applied).

In fork mode the fork is deleted after a failure, unless `--keep-failed-fork` is set, and the message says whether it was deleted or kept and that the destination was not changed. In place, the message says that writes made before the failure remain. There is no transaction around a diff: stop competing writes while it runs.

## Interruptions

Every command is one-shot, with no pause, resume or saved progress. On `SIGINT`, `SIGTERM` or `SIGHUP` it stops starting new work; apply finishes the operation in progress, then cleanup deletes a fork created by the run unless `--keep-failed-fork` is set. A second signal does not skip cleanup. Temporary files and partial zips are removed on completion and on failure. `SIGKILL` and machine shutdown cannot run cleanup.

## Native schema migrations

Keep diffs under `migrations/content/` and run them with `content:apply`; run schema migrations with native `migrations:run`. Diffs do not take part in the native pending-migration queue, and the schema-migration tracking model is never part of a diff.

## Behavior and limits

- Current and published content, nested blocks, structured text, typed references, workflow stages, sortable and tree ordering, uploads, upload folders and schedules are planned together.
- Publication cycles between records are broken by publishing first without the top-level links to records published later, then publishing again with them. Running in place can briefly expose a record without those links and adds an extra published version. Cycles made only of links inside blocks or structured text cannot be broken this way.
- IDs or upload URLs embedded in arbitrary JSON or text fields are not typed references; referenced-upload selection and deletion ordering cannot see them.
- New records and uploads belong to the account or token running the diff. Version history, original creators and read-only timestamps are not copied; writable `created_at` and `first_published_at` are.
- Content writes trigger configured webhooks. Forks carry schedules that may run before promotion.
- Generation keeps record values in temporary files on disk, compressed, and only identities and links in memory; it needs temporary disk space of roughly twice the compressed size of both sides.

## Output and errors

Every command supports `--json` and the standard CLI logging flags (`--log-level`, `--log-mode`). With `--json`, `content:export` returns the dump manifest and `dumpPath`; `content:diff` returns `diffPath`, `sourceEnvironmentId`, `destinationEnvironmentId`, `operations`, `counts` (`record`, `upload` and `collection` objects, each with `create`, `update`, `delete`, `noop` and `skip` counts; `collection` means upload folders) and `skipped` (`{ kind, id, code, message }` for each reason an entry was skipped; without `--json` these are printed to stderr); `content:apply` returns `environmentId`, `executed`, `operations` and `partial` (whether generation skipped content), plus `preflightOnly` and `generatedCounts` for a preflight. Failures print `{ "error": { name, message, code, details, suggestions, keptForkEnvironmentId? } }`, where `keptForkEnvironmentId` appears when a fork created by the run still exists.

Request logs and API errors never contain the API token: the SDK masks the `Authorization` header (this relies on `@datocms/rest-client-utils` 6.1.1 or later, which the plugin depends on).

## Development

```sh
npm run build
npm run typecheck
npm run typecheck:test
npm test
npm run package:check
```

The tests are synthetic and need no network or credentials. They plan diffs from captured states, run them against an in-memory CMA until both sides plan as no-ops, and cover the dump and diff formats, the apply checks, fork cleanup, interruption and the command contracts. See `docs/design.md` for the design.
