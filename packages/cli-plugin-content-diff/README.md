# DatoCMS content diffs

Move content between DatoCMS environments, projects and backups. `content:export` writes an environment to a project dump. `content:diff` compares a source (a live environment or a dump) with a destination environment and writes a diff: the ordinary CMA calls that bring the destination to the source, in dependency order. `content:apply` checks that what the diff touches has not changed in the destination, then runs it, in a new fork by default.

Dumps and diffs are zip files of JSON Lines, so every step streams: none of them holds a whole project in memory. The plugin adds these commands to the unmodified DatoCMS CLI. It does not change native schema migrations or write their migration receipts.

## Setup

Requires Node.js 18 or later, like the DatoCMS CLI.

```sh
datocms plugins:install @datocms/cli-plugin-content-diff
```

(To work on the plugin itself, `datocms plugins:link <path to this package>` registers a checkout instead.)

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
| `--out` | Current directory | A path ending in `.zip` names the exact file; a directory gets a timestamped name. |
| `--concurrency` | `8` | Maximum concurrent read requests, from 1 to 16. |

A dump holds:

```
1791556200_backup.dump-records-assets.zip
├── manifest.json             format, plugin version, project, environment, locales, counts
├── schema.json               the site with its models and fields, and the workflows, as the CMA returns them
├── records/000001.jsonl …    one record per line: {"id", "current", "published"}
├── uploads/000001.jsonl …    one upload per line, as the SDK's uploads.list returns it
├── upload-collections/…      one folder per line
└── assets/<id>/<filename>    asset files, only with --include-assets
```

Record versions are the CMA's JSON:API resources exactly as `GET /items?nested=true` returns them (blocks inline, scheduled publication and unpublishing instants in the current version's `meta`), so a dump is readable with any JSON tool once unzipped. Each JSON Lines entry stays under 64 MB. Large dumps use ZIP64, which some archive tools (macOS Archive Utility among them) cannot open; `unzip` and most other tools can.

The export takes no lock: keep content unchanged while it runs. Reads that disagree, such as a page whose total changed or a record listed twice, stop it with `CAPTURE_DRIFT`. Asset files are downloaded one at a time while the zip is written.

## Diff

```sh
npx datocms content:diff syncContent --source=staging --destination=primary
npx datocms content:diff restore --source-dump=./1791556200_backup.dump-records.zip --destination=main
```

Generation resolves both sides, reads their schemas and refuses incompatible schemas before reading any content (see [Schema compatibility](#schema-compatibility)). It then reads the selected models of both sides in full (current and published values, nested blocks, schedules), plus uploads and upload folders, plans the changes and writes the diff. The plugin takes no lock: keep content and schemas unchanged while generation runs.

A dump can be the backup of the destination itself: export `main` today, change it, and diff that dump against `main` to bring it back. The "same environment" refusal applies only when both sides are live environments.

The configured schema-migration tracking model (the profile's `migrations.modelApiKey`, `schema_migration` by default) is left out of the comparison and of the schema hash, and its API key is recorded in the diff so that apply leaves it out too.

The diff is written as `migrations/content/<seconds>_syncContent.diff-records.zip`, in the `content/` subdirectory of the profile's migrations directory (or `./migrations/content`), where the native schema runner does not look. When the source is a dump with asset files and the diff uploads a file, the files are copied into the diff and its name ends in `.diff-records-assets.zip`. Existing files are never overwritten. Diffs can be large; add `migrations/content/*.zip` to `.gitignore` if you do not want them versioned.

| Argument or flag | Default | Behavior |
| --- | --- | --- |
| `NAME` | `contentMigration` | Camel-cased into the timestamped file name. |
| `--source` | | Source environment ID, or `primary`. Exactly one of `--source` and `--source-dump`. |
| `--source-dump` | | A dump from `content:export` to use as the source. Needs no source token. |
| `--destination` | `primary` | Destination environment ID, or `primary`. Always a live environment. |
| `--out` | Timestamped file in the default directory | A path ending in `.zip` names the exact file; a directory gets a timestamped name. A path with another extension is refused. |
| `--source-profile` | | A configured profile naming the source project, when it is not the destination project. |
| `--source-api-token` | | Overrides the source profile's token; requires `--source-profile`. |
| `--item-types=article,page` | `all` | Regular model API keys whose records the diff may change. Only these models are read; links from other records to records the diff deletes are left to the field's `on_reference_delete_strategy`. |
| `--uploads` | `referenced` | `referenced` manages the uploads that managed records reference on either side, and the folders containing them (with their ancestors); `all` manages every upload and folder. |
| `--include-deletions` | Off | Delete destination-only records, uploads and folders within the scope, after the writes that drop references to them. |
| `--concurrency` | `8` | Maximum concurrent independent requests, from 1 to 16. |

For separate projects, the native flags select the destination and `--source-profile` the source:

```sh
npx datocms content:diff syncContent \
  --source=main --destination=main \
  --profile=target-project --source-profile=source-project
```

The source profile's token is resolved in the native order (`--source-api-token`, the project linked with `datocms link`, the profile's environment variable). `--source-dump` cannot be combined with `--source-profile`. Separate projects, and a dump with its destination, are read concurrently. Records, uploads and folders are matched by ID, and the schema check requires the same model and field IDs on both sides, so this works between projects whose schemas share their IDs: forks, clones, and projects built from the same autogenerated migrations.

### Schema compatibility

Generation compares structure only. Locales, the environment's timezone and its `improved_*`, `milliseconds_in_datetime` and `non_localized_focal_points` settings, and workflows (IDs and stage IDs) must match. Every selected model and every block model must exist in the destination with the same ID, API key, `block`, `singleton`, `sortable`, `tree`, draft mode and workflow, and the same fields compared by ID, API key, type and localization. Names, validators, default values, appearance and hints are ignored: the CMA validates every write when the diff runs. Apply still checks a hash of the destination schema that includes some of these settings (see [Apply](#apply)).

Run schema migrations first, with native `migrations:run`, then generate the content diff.

### What the planner refuses

The plugin never predicts whether the CMA will accept a write. Generation fails only when no order of writes exists: a publication cycle that leaving top-level `link`/`links` values out of a first publication cannot break (`PUBLICATION_CYCLE`, naming the records). Everything else is ordered and left to the CMA.

### Invalid source records

Invalid records cannot be diffed. The CMA only accepts an invalid record as a draft in a model with draft mode and "Save invalid drafts" enabled. After planning, and before writing any file, generation checks every source record the diff would create or update against the source CMA's own verdict (`is_current_version_valid` and `is_published_version_valid`, which a dump keeps):

- an invalid published version always stops generation;
- an invalid current version stops it, unless the destination model has draft mode with "Save invalid drafts" enabled.

Generation then fails with `INVALID_SOURCE_RECORDS`, listing the records (the first 20 in the message, all of them in the JSON `details.records`).

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
| `folder.create`, `folder.update`, `folder.delete` | `uploadCollections.create`, `update`, `destroy`; creates and updates carry the folder's position |
| `upload.create`, `upload.replace` | `uploads.createFromLocalFile` or `updateFromLocalFile` when `file` names an entry of the diff, otherwise `createFromUrl` or `updateFromUrl`; then an MD5 check |
| `upload.update`, `upload.delete` | `uploads.update`, `destroy` |
| `record.create`, `record.update`, `record.delete` | `items.create`, `update`, `destroy` |
| `record.publish`, `record.unpublish` | `items.publish`, `unpublish`, with `recursive` off: tree parents and children are never published or unpublished along |
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
6. record, upload and folder deletions (folders deepest first), and the unpublishing of records that a deleted record still linked to from its published version or was the published child of, which the CMA refuses while that record exists;
7. one `records.reorder` per sortable or tree sibling group that gains records or whose order changes;
8. schedule changes, only for records whose schedules differ.

**Optimistic locking.** The first update of a record that already exists in the destination carries `meta: { current_version }`, unless another write to that record comes first. If someone edits the record while the diff runs, the CMA rejects the update and apply reports `RECORD_CHANGED_DURING_APPLY` instead of overwriting the edit.

**Blocks.** Updates send only the fields that change. Inside a changed Modular Content, single block or Structured Text field, a block that keeps its ID in the same field and locale is sent as its bare ID when unchanged, or as `{ id, type: 'item', attributes }` with only its changed attributes; new blocks are sent in full with their block model.

**Uploads.** A diff from an environment, or from a dump without asset files, uploads new and replaced files from the source URL (with the original-file parameters, so default image optimizations and SVG sanitizing do not alter the bytes); the source uploads must still exist and be reachable when the diff runs, and the machine running apply downloads them before uploading them. Every upload is checked against the source MD5 and fails with `ASSET_CHANGED` when it differs.

**Ordering.** Creates send no `position`, and tree creates and moves send only `parent_id`. `records.reorder` lists the sibling group, refuses with `ORDERING_MEMBERS_DIFFER` when its members differ from `order` (naming the extra and missing IDs), moves only the out-of-place records to the positions the group already uses, reads the result back and fails with `ORDERING_NOT_APPLIED` if the order still differs after three passes.

**Schedules.** A diff recreates the scheduled publication and unpublishing instants the record listing reports. A schedule limited to some locales is recreated as a schedule for the whole record: its details are readable only through an API DatoCMS marks unstable.

**Editing.** To change a diff, unzip it, edit or delete lines, and zip it again. The CMA validates every write. If an edit breaks something, apply stops with the CMA's error; the plugin does not try to repair it.

## Apply

```sh
npx datocms content:apply ./migrations/content/1791559800_syncContent.diff-records.zip
```

Apply reads the manifest and checks that the destination belongs to the project the diff was generated for (`DESTINATION_MISMATCH` otherwise) and is ready and writable when applying in place. It then checks the destination schema hash and, reading the diff once, that every line is a valid operation, that every ID the diff creates is free, and that every record, upload and folder the diff touches is as it was at generation. The schema hash covers the locales, the environment settings listed under [Schema compatibility](#schema-compatibility), workflows, and every model's ID, API key, name, flags, workflow and fields (ID, API key, type, localization, validators and default value), with the schema-migration tracking model left out. Any difference fails with `DESTINATION_CHANGED`:

```
The destination environment has changed since the diff generation. Please re-generate a diff to apply.
First difference: record AbCdEfGhIjKlMnOpQrStUv was changed.
```

By default it then creates a new fork of the destination, waits for it with progress output, repeats the checks in the fork, and runs the operations there, one at a time and in order. It reports the environment it ran in and never promotes a fork. Promoting the fork later replaces the destination with it, so edits made in the destination after the fork request are lost; `--in-place` keeps them, and the optimistic locks make the diff fail instead of overwriting a record edited meanwhile. Each operation is one CMA request, run one after another, so a diff of 100,000 operations takes hours. Unlike `migrations:run`, where `--source` is the environment to fork and `--destination` the fork's name, here `--destination` is the environment the diff targets and `--fork-name` names the fork.

| Argument or flag | Default | Behavior |
| --- | --- | --- |
| `FILE` | Required | The `.zip` diff. |
| `--preflight-only` | Off | Run the checks without creating a fork or running anything. |
| `--fork-name=content-review` | `content-apply-<seconds>` | ID of the new fork, lowercase letters, numbers and dashes; an existing environment ID is refused. Cannot be combined with `--in-place`. |
| `--destination=ENVIRONMENT_ID` | The diff's destination | Apply against another environment of the same project, by ID or `primary`. |
| `--in-place` | Off | Run directly in the destination instead of a fork. |
| `--allow-primary` | Off | Permit in-place writes to the primary environment; requires `--in-place`. |
| `--keep-failed-fork` | Off | Keep the fork after a failure instead of deleting it. Cannot be combined with `--preflight-only`. |
| `--fast-fork` | Off | Create the fork with DatoCMS's fast fork, as `migrations:run --fast-fork` does. It is quicker but blocks writes to the destination while it copies, so destination schedules due during the copy may not run, and DatoCMS refuses it while users are editing records (`FAST_FORK_BLOCKED`). |
| `--force` | Off | Start the fast fork even while users are editing records; requires `--fast-fork`. |
| `--concurrency` | `8` | Maximum concurrent check requests, from 1 to 16; operations run one at a time. |

Only what the diff touches is checked. If something changes after generation, in the destination or in the diff, and that makes a write fail, apply stops with the CMA's error. In particular:

- records the diff does not touch are not checked. A destination record that starts linking to a record the diff deletes loses that link, as the field's `on_reference_delete_strategy` schema setting (by default `delete_references`) decides;
- `records.reorder` lines carry no expectation and their position writes are not locked: a sibling order changed in the destination after generation is overwritten, not reported;
- scheduled publications and unpublishings are not paused. One that runs during the checks fails them; one that runs while the diff runs is not detected, because publishing does not change the current version a lock compares.

### Failures

A failed operation is reported with its place in the diff and the CMA's error codes, for example `operations/000001.jsonl line 42, Update Article "Hello world" (AbCdEfGhIjKlMnOpQrStUv): The CMA rejected PUT /items/AbCdEfGhIjKlMnOpQrStUv: INVALID_FIELD (title: VALIDATION_REQUIRED). See https://www.datocms.com/docs/content-management-api/errors/...`:

- `CMA_VALIDATION_FAILED` for a 422, with the CMA's documentation link for the first error;
- `RECORD_CHANGED_DURING_APPLY` when a locked update finds a newer version;
- `CMA_REQUEST_FAILED` for any other CMA error, and for a request that timed out (a timed-out write may still have been applied).

In fork mode the fork is deleted after a failure, unless `--keep-failed-fork` is set, and the message says whether it was deleted or kept and that the destination was not changed. In place, the message says that writes made before the failure remain. There is no transaction around a diff: stop competing writes while it runs.

## Interruptions

Every command is one-shot, with no pause, resume or saved progress. On `SIGINT` or `SIGTERM` it stops starting new work; apply finishes the operation in progress, then cleanup deletes a fork created by the run unless `--keep-failed-fork` is set. A second signal does not skip cleanup. Temporary files and partial zips are removed on completion and on failure. `SIGKILL` and machine shutdown cannot run cleanup.

## Native schema migrations

Keep diffs under `migrations/content/` and run them with `content:apply`; run schema migrations with native `migrations:run`. Diffs do not take part in the native pending-migration queue, and the schema-migration tracking model is never part of a diff.

## Behavior and limits

- Current and published content, nested blocks, structured text, typed references, workflow stages, sortable and tree ordering, uploads, upload folders and schedule instants are planned together.
- Publication cycles between records are broken by publishing first without the top-level links to records published later, then publishing again with them. Running in place can briefly expose a record without those links and adds an extra published version. Cycles made only of links inside blocks or structured text cannot be broken this way.
- A block cannot move to another field or locale and keep its ID: the CMA refuses it. Blocks moved in the editor get new IDs, so this only affects a source where a script re-added a removed block, with its ID, to another field or locale; the diff then fails at that record's update.
- IDs or upload URLs embedded in arbitrary JSON or text fields are not typed references; referenced-upload selection and deletion ordering cannot see them.
- New records and uploads belong to the account or token running the diff. Version history, original creators and read-only timestamps are not copied; writable `created_at` and `first_published_at` are.
- Content writes trigger configured webhooks. Forks carry schedules that may run before promotion.
- Generation keeps record values in temporary files on disk, compressed, and only identities and links in memory; it needs temporary disk space of roughly twice the compressed size of both sides. Memory still grows with the number of records in the selected models on both sides.

## Output and errors

Every command supports `--json` and the standard CLI logging flags (`--log-level`, `--log-mode`). With `--json`, `content:export` returns the dump manifest and `dumpPath`; `content:diff` returns `diffPath`, `sourceEnvironmentId`, `destinationEnvironmentId`, `operations` and `counts` (`record`, `upload` and `collection` objects, each with `create`, `update`, `delete` and `noop` counts; `collection` means upload folders); `content:apply` returns `environmentId`, `executed` and `operations`, plus `preflightOnly` and `generatedCounts` for a preflight. Failures print `{ "error": { name, message, code, details, suggestions, keptForkEnvironmentId? } }`, where `keptForkEnvironmentId` appears when a fork created by the run still exists. Authorization failures keep the CMA's own code under `--json` (`INVALID_AUTHORIZATION_HEADER`, `INSUFFICIENT_PERMISSIONS`); human output translates them as the native commands do.

Request logs and API errors never contain the API token: the SDK masks the `Authorization` header (this needs `@datocms/rest-client-utils` 6.1.1 or later in the installed SDK).

### Error codes

| Code | Meaning |
| --- | --- |
| `APPLY_FAILED_CLEANUP_INCOMPLETE` | An operation failed and the fork could not be removed afterwards; the original failure is under `details.cause`. |
| `ASSET_CHANGED` | An uploaded file's MD5 differs from the source's: the source asset changed after generation. |
| `ASSET_DOWNLOAD_FAILED` | `content:export --include-assets` could not download an asset file. |
| `CAPTURE_DRIFT` | Two reads of the same environment disagreed while it was being read: content changed during export or generation. |
| `CMA_REQUEST_FAILED` | A CMA request failed with something other than a validation error, or timed out. |
| `CMA_VALIDATION_FAILED` | The CMA rejected a write (HTTP 422). |
| `DESTINATION_CHANGED` | The destination schema, or a record, upload or folder the diff touches, differs from generation. |
| `DESTINATION_MISMATCH` | The destination is not an environment of the project the diff was generated for. |
| `DESTINATION_UNAVAILABLE` | An in-place destination is not ready or is read-only. |
| `ENVIRONMENT_NOT_FOUND` | The requested environment does not exist in the project. |
| `FAST_FORK_BLOCKED` | DatoCMS refused a fast fork because users are editing records. |
| `FORK_FAILED` | The fork ended in a status other than ready, or disappeared. |
| `FORK_ID_COLLISION` | The requested fork name already exists. |
| `INTERRUPTED` | The command was stopped by `SIGINT` (exit 130) or `SIGTERM` (exit 143). |
| `INVALID_BLOCK` | A block in the content lacks its model or attributes. |
| `INVALID_DIFF` | The diff zip, its manifest or one of its lines is not a valid diff. |
| `INVALID_DIFF_PATH` | The `FILE` argument of `content:apply` is not a `.zip` path. |
| `INVALID_DUMP` | The dump zip, its manifest or its line counts are not a valid dump. |
| `INVALID_FORK_NAME` | `--fork-name` is not made of lowercase letters, numbers and dashes. |
| `INVALID_JSON` | The content holds a value that is not JSON. |
| `INVALID_MODEL` | The content refers to a model missing from the schema. |
| `INVALID_MODEL_SELECTION` | `--item-types` names an unknown model or a block model. |
| `INVALID_NAME` | The `NAME` argument has no letters or numbers. |
| `INVALID_OUTPUT_PATH` | `--out` is neither a `.zip` path nor a directory. |
| `INVALID_RESPONSE` | The CMA returned something other than the expected JSON object. |
| `INVALID_SOURCE_RECORDS` | The source CMA reports records the diff would write as invalid. |
| `INVALID_ZIP` | A zip entry is missing or is not valid JSON. |
| `LINKED_PROJECT_TOKEN_MISSING` | The linked source project returned no API token. |
| `LINKED_PROJECT_UNAVAILABLE` | The linked source project could not be read with the saved OAuth credentials. |
| `OAUTH_CREDENTIALS_INVALID` | The saved OAuth token used for the source project was rejected. |
| `OAUTH_CREDENTIALS_MISSING` | The source profile is linked but no OAuth credentials are saved. |
| `ORDERING_MEMBERS_DIFFER` | A sibling group's members differ from the order list of a `records.reorder` line. |
| `ORDERING_NOT_APPLIED` | A sibling group is still out of order after three passes. |
| `OUTPUT_EXISTS` | The dump or diff file to write already exists. |
| `PRIMARY_REQUIRES_APPROVAL` | `--in-place` targets the primary environment without `--allow-primary`. |
| `PUBLICATION_CYCLE` | Records in a publication cycle cannot be published in any order. |
| `RECORD_CHANGED_DURING_APPLY` | A locked update found a newer version of the record. |
| `SAME_ENVIRONMENT` | Source and destination are the same live environment. |
| `SCHEMA_INCOMPATIBLE` | The source and destination schemas differ in structure. |
| `UNPROVEN_FULL_ACCESS` | The token's role does not prove unrestricted reads of every model and upload. |

## Development

```sh
npm run build
npm run typecheck
npm run typecheck:test
npm test
npm run test:integration
```

`npm test` is synthetic and needs no network or credentials: it plans diffs from captured states, runs them against an in-memory CMA until both sides plan as no-ops, and covers the dump and diff formats, the apply checks, fork cleanup, interruption and the command contracts. `npm run test:integration` runs one end-to-end scenario on a throwaway DatoCMS project (export, diff, apply, diff again, then a restore from the dump) with the account credentials described in the repository's `.env.sample`. See [docs/design.md](https://github.com/datocms/cli/blob/main/packages/cli-plugin-content-diff/docs/design.md) for the design.
