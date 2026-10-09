# Content diff design

A content diff is a zip of JSON Lines: one CMA call per line, in the order they run, plus a manifest naming the destination it was generated for. `content:diff` plans once and writes the plan as operations. `content:apply` checks that what the diff touches is unchanged in the destination and runs the lines as written. Apply neither predicts the effect of the calls nor plans them again. A project dump, written by `content:export`, is the same kind of zip holding an environment's content; `content:diff` reads it as it reads a live environment, and apply cannot tell which one a diff came from.

## Principles

- **The CMA is the validator.** The plugin never predicts whether a write will be accepted. Field validators and default values take part only in the destination schema hash. Every write is validated by the CMA when the diff runs, and its errors are reported with the line that caused them. Apply runs in a fresh fork by default, so a rejected write costs only the fork.
- **Content only.** A diff never changes fields, validators, defaults or any other schema setting. Schema changes belong to native schema migrations, which run before generation.
- **Check only what the diff touches.** Apply checks the destination schema, that the IDs the diff creates are free, and that every record, upload and folder it touches is as it was at generation. Nothing else is compared, so unrelated edits to the destination do not invalidate a diff.
- **Edits after generation fail loudly.** When the destination or the diff changes after generation and a write fails because of it, apply stops with the error. There is no code that detects, repairs or works around such edits.
- **Streams, not memory.** Dumps, diffs and the working data of a diff are read and written as streams of lines. Memory holds identities and links, never every record's values.
- **Work proportional to the change.** Unchanged records cost no calls, each upload costs one call, and sibling groups whose order did not change get no reorder.
- **Reuse the SDK and the native CLI.** Clients, authentication, logging, request retries, job polling, upload transfers and the masking of the `Authorization` header come from `@datocms/cli-utils` and the CMA SDK. Zip files are read and written with `yauzl` and `yazl`.

## Plugin boundary

Everything lives in this package and works with the unmodified DatoCMS CLI and the published shared utilities. No native command is changed or overridden, and no content-specific contract is added to `cli-utils`. Diffs live in the `content/` subdirectory of the migrations directory, where the native schema runner does not look for them.

## Formats

**Dump** (`<seconds>_<name>.dump-records.zip`, or `-records-assets.zip`): `manifest.json` (format `datocms-project-dump` version 1, plugin version, project and environment, locales, whether asset files are included, counts), `schema.json` (the bulk site read with models and fields, and the workflows), `records/NNNNNN.jsonl` (one `RecordLine` per record: its current and published JSON:API resources as `GET /items?nested=true` returns them, and its schedule resources), `uploads/NNNNNN.jsonl` and `upload-collections/NNNNNN.jsonl` (as the SDK lists them), and `assets/<id>/<filename>` with `--include-assets`. Reading a dump checks the manifest counts against its lines (`INVALID_DUMP`).

**Diff** (`<seconds>_<name>.diff-records.zip`, or `-records-assets.zip` when it carries files): `manifest.json` (format `datocms-content-diff` version 1, plugin version, source kind, project and environment, destination project and environment, the projected destination schema hash, the source and destination tracking bindings, the options, counts and operation count), `operations/NNNNNN.jsonl`, and `assets/<id>/<filename>` copied from a source dump.

An operation line is `{ op, id?, label, expect?, file?, url?, md5?, data? }`. `op` is one of a fixed vocabulary (see the README); `data` is the body passed to the SDK method; `expect` is on the first line touching an existing entity (records: current version and published version update time; uploads and folders: a hash of what the diff compares). Any other operation or a malformed line refuses the diff before its first write (`INVALID_DIFF`).

JSON Lines entries are split at 64 MB. Zips are written as streams (ZIP64 where needed) under a temporary name and linked into place, so a file is never overwritten and never left half written.

## Generation (`content:diff`)

1. **Endpoints.** One profile, or a pair of source and destination profiles, or a dump and one profile. `content:diff` has a small base class (`PairedProfileCommand`) only because `CmaClientCommand` resolves exactly one profile during `init`. It resolves each endpoint's token in the native order: explicit token, linked project OAuth token, then the profile's environment variable.
2. **Schemas.** Live schemas are read in bulk, with workflows read separately; a dump's `schema.json` goes through the same normalization. The configured schema-migration tracking model is identified by API key, left out of the comparison and the content, and its exact ID (or absence) is recorded as a binding.
3. **Compatibility.** Before any content is read, locales, environment semantics and workflows (IDs and stage IDs) must match, and every selected model and every block model must have the same ID, API key, `block`, `singleton`, `sortable`, `tree`, draft mode, workflow and field set (ID, API key, type, localization) on both sides.
4. **Capture.** Each live side is read once: for every regular model, pages of current records (nested where the model has block fields), then the published versions of those records by ID, then the schedules of records with schedule markers; then uploads and folders. The capture first proves that the token has unrestricted read access. Reads that disagree (page totals, duplicates, publication state, schedule markers) fail with `CAPTURE_DRIFT`; nothing is locked or reread. Environments of one project are read one after the other (they share a rate limit); separate projects, and a dump with its destination, are read concurrently.
5. **Side index.** Each captured record is canonicalized and written to one of 1024 gzip bucket files, chosen by a hash of its ID; only its facts stay in memory: model, hash, publication, parent, position, validity and title. Records of the selected models also add the uploads they reference to a set. Uploads are split the same way; folders stay in memory.
6. **Planning.** Every record, upload and folder is classified as create, update, delete, noop or skip, from the facts alone. Only records the plan creates, updates or deletes take part in ordering, so their references (reduced to target, kind, field and top-level field) and the values the SDK would corrupt are then read from their buckets, on both sides; no other record's references are kept. The model selection limits which records may change, while every record supplies inbound references and retained destination state. An in-memory Kahn ordering per phase ranks creation order (a creation cycle is broken like a publication cycle, so only the fields of a member that reference a member created later are left empty; models without draft mode publish on create, so their creates also leave out fields that reference records not published yet), publication order, references released before the records they point to are unpublished, tree parents and ancestors, deletions after the writes that drop references to them, and folder depth. Publication cycles are broken by leaving top-level links out of a first publication.
7. **Source validity.** Every source record the plan creates or updates is checked against the source CMA's own verdict (`is_current_version_valid`, `is_published_version_valid`). An invalid published version, or an invalid current version unless the destination model has draft mode with invalid draft saving, fails generation with `INVALID_SOURCE_RECORDS` before any file is written.
8. **Operations.** Every operation gets a slot: one per entity and phase, numbered in run order from the plan. Slots are grouped into ranges of about 64 MB of estimated payload. The records and uploads of each bucket are then read back, source and destination together, and their operations are built from their full states, each into the file of its range. Each range is sorted in memory and written to the diff in order. A record's operations follow the state the run leaves it in so far, as each call builds on the previous ones (labels that name another record, such as the parent of a move or a reorder, use that record's final title); whether a first update can be locked is decided in this final ordered pass, since an earlier move of a sibling out of its group renumbers it.

### Structural refusals

The planner refuses only what the diff could not reproduce faithfully:

- record values the SDK would corrupt: an own `__proto__` key, `__itemTypeId`, or a metadata object with `type: "item"`;
- publication cycles that leaving top-level `link`/`links` values out of a first publication cannot break;
- references to created records whose containing field cannot be identified.

Without `--allow-partial` the first refusal fails generation. With it, the refused entry becomes `skip`, and the skip propagates only where it is structurally required: to entries that reference a skipped create, and to deletions of records, uploads or folders that a skipped entry's retained destination state still references. `--include-deletions` deletes destination-only content in scope with no further filter.

## Operation rules

Phase order: folder writes; upload creates and changes; record creates; publications, unpublications, provisional first publications and their republications, and tree moves; draft updates; record, upload and folder deletes (folders deepest first by destination depth); one folder reorder; one record reorder per changed sibling group; schedules.

**Locking.** For a record present in the destination with a current version, the first `record.update` carries `meta: { current_version }` unless another write to that record comes first, or an earlier move of a record out of its sibling group renumbered it.

**Blocks.** Updates send only changed fields. Inside a changed block field, a block whose ID and block model already sit in the same field and locale is sent as its bare ID when unchanged, or as `{ id, type: 'item', attributes }` with only its changed attributes; new blocks and every block of a create are sent in full.

**Uploads.** A new or replaced file is uploaded from the diff's own file when the source dump carried one, and otherwise from the source upload URL with the original-file parameters, so default image optimizations and SVG sanitizing do not alter the bytes. Each upload is checked against the source MD5 (`ASSET_CHANGED`).

**Reorder.** `records.reorder` lists the model's records (paged, 500 per page, current version), takes the sibling group and refuses with `ORDERING_MEMBERS_DIFFER` when its members differ from `order`. It keeps the longest run already in relative order in place and moves every other record, in desired order, right after its desired predecessor with `items.update(id, { position })`, using the group's existing positions as slots. It reads the group back to confirm, repeats at most three passes, and fails with `ORDERING_NOT_APPLIED` if the order still differs.

## Apply (`content:apply`)

1. **Options.** Flag checks run in `init`, before `CmaClientCommand` resolves the token, so a bad flag fails without network access.
2. **Diff.** The manifest is read and checked (`INVALID_DIFF`).
3. **Destination.** The root client's project must be the diff's destination project (`DESTINATION_MISMATCH`). In place, the destination environment must be ready and writable, and writes to primary need `--allow-primary`.
4. **Checks.** The destination schema is read and projected through the recorded tracking binding (a missing, renamed or replaced tracking model counts as a schema change), and its hash compared. The operations are then read once: every line is validated, every created ID must be free and every `expect` must match, read in batches of 100 IDs with `--concurrency` requests at a time. A difference throws `DESTINATION_CHANGED` with `{ kind, id, reason: 'added' | 'removed' | 'changed' }` or `{ reason: 'schema' }`. Before a fork these checks only fail fast; they run again in the fork, which is the snapshot the diff runs against. `--preflight-only` stops after them.
5. **Fork.** In fork mode the fork ID is checked unused before the checks and again right before the request. The fork is requested with `immediate_return` and, unless `--no-fast-fork`, `fast`; a fast fork DatoCMS refuses because users are editing records fails with `FAST_FORK_BLOCKED`. It is polled with progress lines until ready, for at most two hours.
6. **Run.** The operations run one at a time, in file order, with a CMA client for the target environment. Asset files are extracted from the diff to a temporary file for their upload and removed afterwards.
7. **Cleanup.** After a failure, an environment answering to the fork ID is destroyed unless `--keep-failed-fork` is set, in which case `keptForkEnvironmentId` names it. A fork request rejected with a 4xx never triggers cleanup; if an environment with that ID exists afterwards (the SDK may have retried a timed-out request that did create it), it is reported as kept and left alone. A failed removal becomes `APPLY_FAILED_CLEANUP_INCOMPLETE` with the original failure under `details.cause`.

### Error reporting

CMA errors are wrapped once, and the message is prefixed with the operation's entry, line and label:

- a 422 becomes `CMA_VALIDATION_FAILED`: `The CMA rejected <METHOD> <path>: <code>[ (<field>: <validation code>)]…`, with `details: { method, url, status, errors, operation }` and short hints for `VALIDATION_UNIQUE` and for missing or unpublished references;
- `STALE_ITEM_VERSION` becomes `RECORD_CHANGED_DURING_APPLY`;
- any other `ApiError` becomes `CMA_REQUEST_FAILED`, and so does an SDK `TimeoutError` (`status: null`), whose message says the request may still have been applied.

Apply records what a failure left behind as one `outcome` sentence on the error: once operations started, in fork mode, that the fork was deleted or kept and the destination was not changed, and in place, that writes made before the failure remain; before it, that a fork is kept. JSON output prints `{ "error": { … } }`, picking the reported fields explicitly. The SDK masks the `Authorization` header in request logs and API errors.

## Interruption and one-shot execution

Every command handles `SIGINT`, `SIGTERM` and `SIGHUP` by aborting a shared signal; apply lets the operation in progress finish and starts no other, then runs cleanup; a repeated signal only prints that cleanup is still in progress. There is no checkpoint, journal or resume. Temporary directories and partial zips are removed on success and failure; `SIGKILL` cannot clean up.

## Validation

The test suite is synthetic. Diffs are planned from captured states and replayed against an in-memory CMA until source and destination plan as no-ops; it covers locking, ordering, folders, uploads, schedules, publication cycles and deletions, the dump and diff formats, the apply checks, fork creation and cleanup, CMA error wrapping, interruption and the command contracts. Live writes are limited to disposable projects and are not part of the suite.
