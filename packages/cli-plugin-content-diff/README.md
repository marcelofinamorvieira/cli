# DatoCMS content bundles

Compare content across DatoCMS environments, export a reviewable bundle, and apply it into an isolated destination fork. This plugin adds `content:diff` and `content:apply`; schema migrations continue to use the normal DatoCMS CLI commands.

Requires Node.js 22.13+ on the 22.x line, or Node.js 24+. On Node.js 22, each run prints an `ExperimentalWarning` about SQLite to stderr; it is harmless. Install the plugin in the DatoCMS CLI:

```sh
datocms plugins:install @datocms/cli-plugin-content-diff
```

## Generate a bundle

```sh
datocms content:diff \
  --source=staging \
  --destination=primary \
  --output=./content-bundle
```

`--source` accepts an environment ID or `primary`. `--destination` defaults to `primary`. The output must be a new directory. Generation checks source and destination schema compatibility, captures their complete content namespaces, and rejects an inconsistent capture. When the source and destination are different projects, both are read at the same time. `--item-types` limits changes to selected model API keys; other destination records provide dependency and preservation evidence.

| Flag | Default | Behavior |
| --- | --- | --- |
| `--item-types=article,page` | `all` | Select regular model API keys for content changes. |
| `--uploads=referenced` | `referenced` | Include assets referenced by selected content, or use `all`. |
| `--include-deletions` | Off | Plan safe destination-only deletions within the selected scope. |
| `--allow-partial` | Off | Permit only proven isolated skips and their dependency closure. |
| `--allow-temporary-schema-changes` | Off | Plan supported temporary validator/default changes. |
| `--concurrency=4` | `4` | Bound independent requests to a value from 1 to 16. |
| `--chunk-bytes=4194304` | `4194304` | Set the target JSONL chunk size. One oversized entry occupies its own chunk. |

Unsafe requested changes fail generation by default. Partial mode does not bypass incompatible schemas, incomplete access proofs, or execution conflicts. Legacy/nonportable identifiers and unsupported lifecycle states are diagnosed during planning. DatoCMS computes validity flags asynchronously; the plugin preserves content and publication state, while the restored schema determines final validity. Copying an invalid record requires `--allow-temporary-schema-changes`. When the failing rule can be identified (required, length, size, number range, enum), only that rule is relaxed during apply; otherwise every rule on the record's fields is lifted while it is written, except `unique` and the allowed-model rules of link and block fields, and all are restored afterwards.

Native file/gallery metadata that the CMA client cannot safely preserve is rejected before writes. This includes reserved keys such as `__proto__` and `__itemTypeId`, and metadata objects with `type: "item"`. These strings remain safe inside a JSON field's serialized JSON text. Existing unsupported values can remain unchanged. A scheduled invalid draft is rejected when its schedule cannot be recreated under the intended final schema.

Asset folders include labels, parent hierarchy, and exact positions. Plans account for DatoCMS's sibling renumbering when folders move. Conflicting sibling names or transitions that cannot preserve the intended hierarchy and order are diagnosed before writes; partial mode can skip only their isolated dependency closure.

Block IDs can be reused only where DatoCMS permits them in the current record version. Unsafe ownership changes and block recreation that would substitute defaults without declared suppression are diagnosed before writes.

Integer fields, integer defaults, and integer-valued validator settings must stay within JavaScript's safe integer range (±9,007,199,254,740,991). Larger values are rejected before comparison or writes to prevent rounding by the CMA client's JSON parser. Floating-point fields retain their normal number semantics, and JSON fields remain opaque serialized text.

Use the DatoCMS CLI's `--profile`, `--api-token`, linked-project OAuth authentication, and configured token environment variables. To compare different projects, select both endpoint profiles:

```sh
datocms content:diff \
  --source=main --destination=main \
  --source-profile=source-project \
  --destination-profile=target-project \
  --output=./content-bundle
```

`--source-api-token` and `--destination-api-token` override their respective profile authentication. Paired profiles cannot be combined with `--profile` or `--api-token`. Both projects must have aligned managed schemas and compatible public IDs.

## Review and apply

Review `manifest.json` and the `plan/*.jsonl` entries before applying. Changed entries contain complete baseline and desired states. Unchanged entries contain fingerprints and the metadata needed to preserve dependencies, publication, ordering, and schedules. Required new/replacement upload binaries are downloaded and checked during generation; transient download failures are retried a few times before generation fails.

```sh
datocms content:apply ./content-bundle --profile=target-project
```

Apply verifies the manifest, JSONL chunks, asset binaries, destination project binding, schema, and complete baseline before content writes. By default it creates a new isolated destination fork and reports the resulting environment ID. It never promotes the fork automatically. `--destination=ENVIRONMENT_ID` selects an alternative destination only if it satisfies the bundle's full baseline and binding checks.

| Flag | Behavior |
| --- | --- |
| `--in-place` | Apply directly to the selected destination environment. |
| `--allow-primary` | Additionally authorize writes to primary; requires `--in-place` or `--repair`. |
| `--keep-failed-fork` | Keep a fork created by this run if execution fails. |
| `--schedule-window=120` | Refuse to start when any schedule falls due within this many minutes; `0` disables the check. |
| `--repair` | Restore what an interrupted in-place apply left behind, instead of applying. See below. |
| `--allow-temporary-schema-changes` | Permit the exact temporary validator/default changes recorded in the bundle. |
| `--concurrency=4` | Bound independent requests to a value from 1 to 16. Dependent writes retain their required order. |

Schedules are only touched on records the bundle writes: their existing schedules are cancelled before the writes, and the bundle's exact future schedules are recreated once all writes are done and temporary field settings are restored. Schedules on every other record are left alone. Because a schedule that fires during apply would change content mid-run, apply refuses to start when any schedule in the destination, or any schedule it recreates, falls due within `--schedule-window` minutes. Temporary field settings are restored before success. When an in-place run fails, temporary settings are restored, and each cancelled schedule is restored only if its record still has its original content; a record the run created or already changed keeps its current schedules and is listed in the error. Failed forks created by the run are removed unless explicitly retained. Pre-existing environments are never deleted.

If an in-place run is killed before it can clean up, run `datocms content:apply ./content-bundle --repair` (with `--destination` and `--allow-primary` as needed). It reads only the bundle and the live environment: it restores temporary field settings, gives records that still have their original content their original schedules back, gives records that already have the bundle's content the bundle's schedules, and lists any record it cannot decide on, or whose schedule has already passed. Repair never changes content and can be run again safely.

DatoCMS provides no public persistent sandbox write freeze. Maintenance mode applies only to primary and does not create an immutable snapshot or transaction. Capture validation, live guards during execution, and full final verification detect observed conflicts, but another writer can still change data between a check and its following write. Run generation and application while competing writes are stopped.

## Bundle format and lifecycle

A complete bundle contains a small checksummed `manifest.json`, a streamed checksummed `chunks.jsonl` index, deterministic byte-bounded JSONL plan chunks, and checksummed asset files referenced by upload entries. Integrity checks reject unsafe relative paths, symlinks, duplicate identities, malformed executable states, and files that do not match their checksums. The checksums are stored inside the bundle, so they detect accidental corruption and partial copies, not deliberate edits. Between review and apply, keep a reviewed bundle where only trusted people can change it, or record the value in its `manifest.sha256` and check that it is unchanged before applying. Bundles are content exports and exclude client authentication credentials.

Generation and application are one-shot operations. Temporary SQLite databases and staging files are removed on completion or failure. Completed bundles survive application and can be retained as exports. The format does not accept progress files, checkpoints, or temporary databases as inputs.

SIGINT, SIGTERM, and SIGHUP stop queued work, wait for submitted CMA operations to settle, and run the same restoration and cleanup as other failures. Cleanup can take time while a CMA operation is pending. Closing the terminal therefore stops a run too; start long runs inside a terminal multiplexer such as tmux. Forced process termination, such as SIGKILL or a machine shutdown, cannot run cleanup; after an in-place run, use `--repair` as described above, and delete any leftover `content-diff-*` directory in the temporary directory and `.content-bundle-*` directory next to the output.

Both commands support `--json` and the standard CLI logging flags. Authentication credentials are redacted from request logs and surfaced errors.

## Known limitations

- Record and upload creators are not preserved: records and uploads that apply creates are attributed to the API token or account that runs it. This matters for roles limited to records their user created.
- Only the timestamps that clients can set are preserved: `created_at` and `first_published_at`. A record that apply writes gets a new `updated_at`, one that it publishes gets a new `published_at`, and version history is not copied from the source.
- Records that are new or unpublished in the destination and link to each other, such as two new articles that reference each other, are published in two steps: one record in each cycle is first published without its links to the others, those are published, and the first record is then republished with its links. With `--in-place`, the live site briefly shows that record without those links, and the record gets an extra published version. Only links held directly in link and links fields can be dropped this way; a cycle with no such link, for example one formed entirely by links inside blocks or structured text, cannot be planned. Generation fails, and `--allow-partial` skips the records in the cycle and everything that depends on them. Dropping a required link, or shrinking a links field below its minimum size, needs `--allow-temporary-schema-changes`.
- In sortable and tree models, created and updated records take their source position, and every other destination record keeps its current one. If two records in the same sibling group would end up at the same position (for example, a record was removed from the middle of a source list while `--include-deletions` is off, or each environment added a different record at the same place), generation fails with `ORDERING_CONFLICT`, which `--allow-partial` cannot skip.
- References stored inside JSON or text fields, such as IDs saved by plugin field editors or asset URLs in Markdown, are not tracked as dependencies. `--uploads=referenced` does not bundle the assets they point to, and `--include-deletions` can delete records they point to.
- Apply refuses to start when a schedule falls due within `--schedule-window` minutes (120 by default), so a busy editorial project may need to pick a quiet slot or a smaller window. Records the bundle writes have their schedules cancelled for the duration of the writes.
- Apply never promotes the fork, and edits made in the destination after the fork was created are not in it.
- Apply's writes are ordinary content edits, so they trigger the webhooks configured for those events in the environment being written, and a large bundle can send many events.
- Working data lives in a `content-diff-*` directory inside the operating system's temporary directory (`TMPDIR` on macOS and Linux) and can be large: roughly a copy of the content of both environments, plus a staged copy of each asset file while apply uploads it.

## Development

```sh
npm run build
npm run typecheck
npm test
npm run package:check
```

The local suites use bounded mock and file fixtures to verify capture, dependencies, bundle integrity, execution, CLI routing, failure handling, and cleanup. Record and upload reads use bounded pages and temporary SQLite storage. Schema and upload-collection endpoints return their metadata as whole lists; destructive dependency guards also use the CMA’s unpaginated reference endpoints, which must be empty before removal. Large-project throughput and memory limits have not been experimentally established by these checks.
