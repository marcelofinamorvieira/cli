# Content migration design

A content migration is an editable TypeScript function made of real, ordered CMA calls, plus a companion directory that records what the destination looked like at generation. `content:diff` plans once and compiles the plan into code. `content:apply` checks that the destination still matches the recorded baseline and runs the code as written. Apply neither predicts the effect of the calls nor plans them again.

## Principles

- **The CMA is the validator.** The plugin never predicts whether a write will be accepted. Field validators and default values take part only in the destination schema hash. Every write is validated by the CMA when the script runs, and its errors are reported with the request that caused them. Apply runs in a fresh fork by default, so a rejected write costs only the fork.
- **Content only.** A content migration never changes fields, validators, defaults or any other schema setting. Schema changes belong to native schema migrations, which run before generation.
- **Whole-destination baseline.** Apply requires the complete destination namespace to equal the generation baseline, even for a small change. Any difference is reported with one message: `The destination environment has changed since the diff generation. Please re-generate a diff to apply.`
- **Reviewable code.** Generated scripts contain literal payloads, one comment per operation, only the imports they use, and no read-before-write round trips. Optimistic locking uses the versions recorded in the baseline.
- **Work proportional to the change.** Unchanged records cost no calls, each upload costs one call, and sibling groups whose order did not change get no ordering call.
- **Reuse the SDK and the native CLI.** Clients, authentication, logging, request retries, job polling, upload transfers and the masking of the `Authorization` header in logs and errors come from `@datocms/cli-utils` and the CMA SDK.

## Plugin boundary

Everything lives in this package and works with the unmodified DatoCMS CLI and the published shared utilities. No native command is changed or overridden, and no content-specific contract is added to `cli-utils`. Generated scripts import `@datocms/cli-plugin-content-diff/migration`, so the package must be a resolvable dependency of the project. Content scripts live in the `content/` subdirectory of the migrations directory, where the native schema runner does not look for them.

## Generation (`content:diff`)

1. **Endpoints.** One profile, or a pair of source and destination profiles. `content:apply` extends `CmaClientCommand` directly; `content:diff` has a small base class (`PairedProfileCommand`) only because `CmaClientCommand` resolves exactly one profile during `init`. It resolves each endpoint's token in the native order: explicit token, linked project OAuth token, then the profile's environment variable.
2. **Schemas.** Both schemas are read in bulk, with workflows read separately. The configured schema-migration tracking model is identified by API key, left out of the comparison and the capture, and its exact ID (or its absence) is recorded as a binding.
3. **Compatibility.** Before any content is read, locales, environment semantics (timezone and the `improved_*`, `milliseconds_in_datetime` and `non_localized_focal_points` settings) and workflows (IDs and stage IDs) must match, and every selected model and every block model must have the same ID, API key, `block`, `singleton`, `sortable`, `tree`, draft mode, workflow and field set (ID, API key, type, localization) on both sides, so separate projects must share their schema IDs. Names, validators, defaults, appearance and hints are ignored. Environment flags the API does not report read as off, as in the SDK.
4. **Capture.** Both complete namespaces are read once into temporary SQLite: current and published record versions in native JSON:API form with nested blocks, schedules, uploads (through the SDK's normalizing `uploads.list`, so `default_field_metadata` is field-keyed) and upload folders. The capture first proves that the token has unrestricted read access; an API token's role must also be allowed to manage upload collections (account, organization and full-access admin tokens are exempt). Generation takes no lock and does not reread: it relies on content and schemas staying unchanged while it runs. Environments of one project are read one after the other (they share a rate limit); separate projects are read concurrently.
5. **Planning.** Every record, upload and folder is classified as create, update, delete, noop or skip. The model selection limits which records may change, while the full capture supplies inbound references and retained destination state. SQLite indexes drive the dependency graph: creation order (a creation cycle is broken like a publication cycle, so only the fields of a member that reference a member created later are emptied; models without draft mode publish on create, so their creates also leave out fields that reference records not published yet), publication order, references released before the records they point to are unpublished, tree parents and ancestors, deletions after the writes that drop references to them, and folder depth.
6. **Source validity.** Invalid records cannot be diffed, because the CMA accepts an invalid record only as a draft in a model with draft mode and invalid draft saving. Every source record the plan creates or updates is checked against the source CMA's own verdict (`is_current_version_valid`, `is_published_version_valid`, captured as `RecordState.invalid` and kept out of the content hash). An invalid published version, or an invalid current version unless the destination model has draft mode with invalid draft saving (the setting the CMA applies when the script writes the draft), fails generation with `INVALID_SOURCE_RECORDS` before any file is written. The verdict is the CMA's; the plugin evaluates no validators.
7. **Emission.** The plan is compiled into TypeScript (see below), formatted with the project's Prettier configuration and split into parts when it exceeds the chunk target (`--chunk-bytes`), which also sizes the baseline chunk files.
8. **Publishing the artifact.** The script and companion are staged in a temporary directory next to the output. The companion name is claimed with `mkdir`, the staged entries are renamed into it, and the script is published last with an exclusive copy. Neither the script nor the companion is ever overwritten; a name that appears during publishing fails with `MIGRATION_EXISTS` and removes the companion.

### Structural refusals

The planner refuses only what the script could not reproduce faithfully:

- record values the SDK would corrupt: an own `__proto__` key, `__itemTypeId`, or a metadata object with `type: "item"`;
- publication cycles that leaving top-level `link`/`links` values out of a first publication cannot break;
- references to created records whose containing field cannot be identified.

Without `--allow-partial` the first refusal fails generation. With it, the refused entry becomes `skip`, and the skip propagates only where it is structurally required: to entries that reference a skipped create, and to deletions of records, uploads or folders that a skipped entry's retained destination state still references. A skipped update does not propagate to other writes. `content:diff` reports every skipped entry with its code and reason. `--include-deletions` deletes destination-only content in scope with no further filter.

Unsafe integers in record values are refused earlier, during capture, with `UNSUPPORTED_INTEGER_PRECISION`, because JSON parsing would otherwise make two different integers compare equal and the difference would plan as a no-op. They always fail generation, even with `--allow-partial`.

## Generated code

The main file wraps the operations in `defineContentMigration({ baseline }, async (client) => { … })`, where `baseline` is `join(__dirname, '<name>.content')`. `ContentMigrationClient` is the `@datocms/cma-client-node` `Client` type. Each operation has one short comment naming the action, the model, the record title (as the call leaves it) and the ID. Payloads are inlined literals.

Phase order:

1. folder creates (parents first, with `id`, `label` and `parent`) and updates of differing `label`/`parent`;
2. upload creates, file replacements and metadata updates;
3. record creates, without `position` (tree creates send `parent_id`). The CMA appends each create to its sibling group, so creates that do not wait on each other follow their desired group and position, and a group made only of new records is already in order when `reorderRecords` runs. A create sends empty (`[]` for `rich_text` and `links` fields, `null` otherwise) every field that references a record not created yet or, for models without draft mode, a record not published yet; the whole top-level field is emptied, blocks and Structured Text included, and the publication or update phase writes the full value;
4. publications and unpublications: the update that writes the published values before each publish (models without draft mode are published by that update), unpublishing of records whose desired state is unpublished, provisional first publications without the links to records published later, then republications that restore them. Tree moves (`parent_id`) run in this phase, in publication order: a record that is published moves in the update that precedes its publication, one that is unpublished moves right after, and any other moved record gets a lone move at its place in that order. A move that is not part of a publication also carries the record's draft changes, unless the update phase would publish them again afterwards. So a record sits under its new parent before it is published there, and leaves a parent before that parent is unpublished. Moves also wait for every moved record on their desired ancestor path;
5. draft and current updates, including workflow `stage`, `created_at` and `first_published_at`. A field update gives a published draft-mode record a new current version, so when the source record has no unpublished changes the update is followed by `items.publish`;
6. record deletes, upload deletes, then folder deletes (deepest first by baseline depth);
7. one `client.uploadCollections.reorder([...])` when any folder is created, updated or deleted, listing every final folder at its desired position (the source position for managed folders, the baseline one for the others);
8. one `reorderRecords(client, { model, parent, order })` per sortable or tree sibling group that gains records or whose order differs from the baseline, with the complete final member list sorted by desired position (managed records first on ties, then by ID); a group that only loses records keeps its order and gets no call;
9. schedules, only for records whose schedules differ: the baseline schedule is destroyed when it is absent or different in the desired state, and the desired one is created when it is absent or different in the baseline. Deleted records get no schedule calls.

**Locking.** For a record present in the destination baseline with a non-null current version, the first `items.update` carries `meta: { current_version: '<baseline version>' }` unless another write to that record (publish, unpublish, update, delete, schedule change) is emitted before it, or an earlier move of a tree record out of its sibling group renumbers it (renumbering may give it a new version). Later updates and creates carry no version. No `items.find` precedes an update.

**Blocks.** Updates send only changed fields. Inside a changed block field, a block whose ID and block model already sit in the same field and locale is sent as its bare ID when unchanged, or as `{ id, type: 'item', attributes }` with only its changed attributes (recursively); new blocks and every block of a create are sent in full with `relationships.item_type`.

**Uploads.** The companion stores no files. A new upload is `client.uploads.createFromUrl({ id, url, filename, …metadata, upload_collection })` and a replaced file is `client.uploads.updateFromUrl(id, { url, filename, …metadata })`, where `url` is the source upload URL captured at generation (with the original-file parameters, so default image optimizations and SVG sanitizing do not alter the bytes). Each is followed by an MD5 check that throws `Asset <id> changed in the source since the diff generation. Please re-generate a diff to apply.` A metadata-only change is `client.uploads.update(id, { …changed attributes })`.

**Parts.** When the script exceeds the chunk target, operations are written to `parts/NNNNNN.ts`, each exporting a default async function of the client, and the main file runs them in order with `runMigrationPart(client, join(__dirname, '<name>.content', 'parts', part))`.

### `reorderRecords`

Exported from the runtime module, it lists the model's records with the SDK (paged, 500 per page, current version), takes the sibling group and refuses with `ORDERING_MEMBERS_DIFFER` when the group's members differ from `order` (naming unexpected, missing and repeated IDs). It keeps the longest run already in relative order in place and moves every other record, in desired order, right after its desired predecessor with `items.update(id, { position })`, using the group's existing positions as slots and modeling the CMA's insert-and-shift locally to avoid redundant moves. It reads the group back to confirm, repeats at most three passes, and fails with `ORDERING_NOT_APPLIED` if the order still differs. A group already in order costs one listing and no writes.

## Companion format

`<name>.content/` holds:

- `manifest.json` with `manifest.sha256`: format `datocms-content-migration-baseline/1`, creation time, source and destination site and environment IDs, the projected destination schema (whose hash covers the whole projection: model names, field validators and defaults, all-locales-required and draft-saving settings, workflow API keys and stages), the generation options and counts, the source and destination tracking bindings and the chunk index descriptor;
- `chunks.jsonl`: one descriptor per baseline chunk (file, SHA-256, bytes, entries);
- `baseline/NNNNNN.jsonl`: `{ kind, id, guard }` rows, one per destination record, upload and folder, split into chunks that follow the same `--chunk-bytes` target. A record guard holds its hash (which covers its model, content, parent, stage, dates and schedules) and the current version, published update time and position the hash leaves out; uploads and folders hold their hash;
- `parts/NNNNNN.ts` when the script is split.

Loading checks the manifest checksum, every chunk's size, entry count and checksum (each capped file is read whole and checked before it is parsed), and the chunk file names and order. Beyond those checksums, only the manifest fields apply reads (destination binding, tracking binding, schema hash, counts, chunk index) and each row's kind, ID and guard object are checked for shape. Rows are loaded into a temporary SQLite table and compared as whole guards, without recomputing per-row or schema hashes. The checksums detect corruption and incomplete copies, not deliberate tampering.

## Apply (`content:apply`)

1. **Options.** Flag checks run in `init`, before `CmaClientCommand` resolves the token, so a bad flag fails without network access.
2. **Script.** The script is loaded through the public `tsx` CommonJS API, the same mechanism native migrations use, and dropped from the module cache and from its parent module's children afterwards. `tsx` keeps every compiled file in an in-memory cache for the rest of the process, so a split migration's memory grows with the total size of its parts. Its default export must come from `defineContentMigration` (format `datocms-content-migration`, version 1) and its `baseline` must resolve to the sibling `<name>.content` directory. With `--preflight-only`, the source file is only checked to be a regular file, and never read or evaluated.
3. **Destination.** The root client's project must be the recorded destination project (`DESTINATION_MISMATCH` otherwise). In place, the destination environment must be ready and writable, and writes to primary need `--allow-primary`; in fork mode the fork request decides whether the environment can be forked.
4. **Baseline.** The destination schema is read and projected through the recorded tracking binding (a missing, renamed or replaced tracking model counts as a schema change), its hash compared (it covers locales, environment semantics, workflows with their stages, and every model's identity, name, flags, workflow and fields with their validators and default values; field labels, hints, appearance and fieldsets are not part of it), and the complete namespace captured and confirmed (`--verification`: one more listing of record versions, or a full second read). Before a fork the destination capture is not confirmed: it only fails fast, and a change made while it runs is carried into the fork, whose confirmed capture sees it. The capture is compared with the baseline rows: any added, removed or changed record, upload or folder, a different schema hash, or drift observed while capturing (including a request that fails because the schema changed meanwhile) throws `DESTINATION_CHANGED` with the first difference in `details` (`{ kind, id, reason }`, `{ reason: 'schema' }` or `{ reason: 'drift', description }`). The human output prints the message, then one `First difference: …` line. Schedules are not paused: one that runs during these checks fails them with `DESTINATION_CHANGED`. One that runs while the script runs is not detected, since publishing and unpublishing leave the current version the record locks compare unchanged; a generated call removing a schedule that has already run fails the script.
5. **Fork.** In fork mode the fork ID is checked unused before the capture and again right before the request. The fork is requested with `immediate_return` and, unless `--no-fast-fork`, `fast`; a fast fork DatoCMS refuses because users are editing records fails with `FAST_FORK_BLOCKED`, and a fast fork makes the destination read-only while it copies, so a destination schedule due then may not run. It is polled with progress lines until ready, for at most two hours; the same baseline check then runs in the fork. Ownership means "this run checked the ID was unused and requested it".
6. **Execution.** The script receives a CMA client for the target environment built from the native client options plus a tracked `fetchFn`.
7. **Cleanup.** After a failure, an environment answering to the fork ID is destroyed unless `--keep-failed-fork` is set, in which case `keptForkEnvironmentId` names it (also when the lookup that confirms the fork fails, since nothing is removed). A fork request rejected with a 4xx never triggers cleanup; if an environment with that ID exists afterwards (the SDK may have retried a timed-out request that did create it), it is reported as kept and left alone. A failed removal becomes `APPLY_FAILED_CLEANUP_INCOMPLETE` with the original failure under `details.cause`.

### Request tracking

The SDK sends every request (retries, job polling and file transfers included) through `client.config.fetchFn`. The execution client's `fetchFn`, and its `request` method so that SDK-level retries and job polling count as in flight, are wrapped to track every request. After an interrupt, new non-GET requests are rejected with `INTERRUPTED`, while reads continue so jobs already submitted can be observed. Every tracked request is settled before cleanup. If the callback resolves while writes are still in flight, or a call it never awaited was refused or failed, apply drains the remaining requests and fails with `UNAWAITED_MIGRATION_CALL`. A process-level `unhandledRejection` listener keeps such a call from ending the process before cleanup. Only requests are observed: work an SDK helper does with nothing in flight is not, so an unawaited `uploads.createFromUrl` or `uploads.updateFromUrl`, which prepares a temporary file and streams the download before its upload write starts, can let the callback finish with nothing in flight; the write is then refused after apply has reported success. The root client used to manage environments is not wrapped.

### Error reporting

CMA errors raised by the script are wrapped once:

- a 422 becomes `CMA_VALIDATION_FAILED`: `The CMA rejected <METHOD> <path>: <code>[ (<field>: <validation code>)]…`, with `details: { method, url, status, errors }` and short hints for `VALIDATION_UNIQUE` and for missing or unpublished references;
- `STALE_ITEM_VERSION` becomes `RECORD_CHANGED_DURING_APPLY`: `Record <id> was modified by someone else while the migration was running.`;
- any other `ApiError` becomes `CMA_REQUEST_FAILED` with the same context, and so does an SDK `TimeoutError` (`status: null`, no errors), whose message says the request may still have been applied.

Failures raised once the script started end with what happened to the target: in fork mode, that the fork was deleted or kept and the destination was not changed; in place, that writes made before the failure remain. JSON output prints `{ "error": { … } }`, picking the reported fields explicitly (`name`, `message`, `code`, `details`, `suggestions`, and `keptForkEnvironmentId` when a fork still exists). The SDK masks the `Authorization` header in request logs and API errors, so no credential reaches the output.

## Interruption and one-shot execution

Both commands handle `SIGINT`, `SIGTERM` and `SIGHUP` by aborting a shared signal, waiting for active requests and running cleanup; a repeated signal only prints that cleanup is still in progress. There is no checkpoint, journal or resume. Temporary SQLite databases and staging directories are removed on success and failure; `SIGKILL` cannot clean up.

## Storage

The working store is a temporary `node:sqlite` database (Node.js 22.23.1+ on the 22.x line, or 24.18+). `node:sqlite` is loaded on first use, after a version check, so the commands load and report `UNSUPPORTED_NODE_VERSION` on older runtimes.

## Validation

The test suite is synthetic. Generated scripts are typechecked against the real SDK types and replayed against an in-memory CMA until source and destination plan as no-ops; it covers locking, ordering, folders, uploads, schedules, publication cycles and deletions. Apply tests cover baseline integrity and differences, fork creation and cleanup, CMA error wrapping, request tracking and draining, interruption, and the command contracts. Live writes are limited to disposable projects and are not part of the suite.
