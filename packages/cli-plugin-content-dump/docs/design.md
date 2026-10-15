# Content dump design

The plugin has two commands. `content:export` writes an environment's content to a dump. `content:import` writes a dump into an empty sandbox environment that has the dump's schema. The import compares nothing but the schema, and writes nothing but content.

## Principles

- **The CMA is the validator.** The import predicts nothing the CMA decides. Every write is validated by the CMA, and its errors are reported with the step that caused them. The one check made in advance, of the records DatoCMS itself flags as invalid, reads the CMA's own verdict from the dump.
- **Assume the documented starting point.** The destination is assumed empty and is not checked. A destination that is not empty fails at the first ID it already holds, with the CMA's error.
- **Streams, not memory.** Dumps are read and written as streams of lines. Memory holds what each record depends on, never its values.
- **No code for improbable cases.** Normal use is handled; anything else is reported when it fails, never anticipated or repaired. There is no resume, rollback or retry beyond the SDK's own.
- **Plugin only.** Everything lives in this package and works with the unmodified DatoCMS CLI and `@datocms/cli-utils`. Clients, authentication, logging, rate limits and upload transfers come from them.

## The dump

A zip, written as a stream (ZIP64 where needed) to `<path>.partial` and renamed once complete:

```
manifest.json             format datocms-project-dump, version 1, creation time, plugin version, project, environment and whether it is the primary one, locales, whether asset files are included, counts
schema.json               { site: GET /site?include=item_types,item_types.fields, workflows: workflows.list() }
records/000001.jsonl …    one { id, current, published } per record
uploads/000001.jsonl …    one upload per line, as uploads.list() returns it
upload-collections/…      one upload folder per line, as uploadCollections.list() returns it
assets/<id>/<filename>    stored, uncompressed, only with --include-assets
```

`current` is the record exactly as `GET /items` returns it (read through `client.request`, so the SDK's deserializer changes nothing), with its blocks nested when its model has block fields. `published` is the published version, read by ID, only for records with unpublished changes (status `updated`); otherwise the current version is the published one and `published` is null. Records are read model by model in creation order (the ID order can time out on large models), 30 per page when nested and 500 otherwise, with up to 8 pages in flight and consumed in order. JSON Lines entries are split at 64 MiB. Asset files are downloaded one at a time from the original-file URL (`skip-default-optimizations=true&svg-sanitize=false`), so the bytes are the uploaded ones.

## The schema check

The dump's `schema.json` and a fresh read of the destination are both reduced to a schema view, and compared with `isDeepStrictEqual`:

- the locales, in order;
- every model and block model, keyed by ID, because records, blocks and validators name models by ID, with its API key;
- their fields, keyed by API key, because content is written by API key, with type, localization and validators;
- for content models only, singleton, sortable, tree, draft mode, saving invalid drafts, all locales required and workflow, which decide how records are written (the CMA ignores these on block models, and the native autogenerate does not copy them there);
- the workflows with their API key, stage IDs and initial stage.

Everything else is left out because it does not change what the CMA accepts, and because part of it a migration generated with `migrations:new --autogenerate` does not reproduce: names, hints, appearance, fieldsets, default values (autogenerate drops per-locale null defaults), field IDs, the timezone, the environment's settings, and the migration tracking model, which `migrations:run` creates in the environment it runs in. The view of the dump is also the import's only source of schema information, so the check compares exactly what the import relies on.

On a mismatch, the error lists the differences (the first twenty, then how many more) and gives one of four pieces of advice, read only on this failure path:

1. The destination is in another project: the dump can be imported only into its own project, since the import keeps model IDs and generated migrations work within one project.
2. The original environment no longer exists, or cannot be read with the token: give the destination the schema another way.
3. It exists but its schema view now differs from the dump's: a migration generated from it would not reproduce the dump's schema.
4. It exists and still has the dump's schema: `migrations:new copyDumpSchema --autogenerate=<source>:<destination>`, `migrations:run --source=<destination> --in-place --migrations-dir=<the generated script alone>`, then the import again. The native autogenerate creates models, fields and fieldsets with the source's IDs (legacy numeric IDs aside), so the destination then matches. The message also says what the native commands need: a `datocms.config.json` profile, the generated script run alone, and the tracking model left to `migrations:run`, which creates it before running any script.

## The import

1. **Index.** One pass over `records/`. Each line is stored, deflated, in one temporary file, and only its node stays in memory: ID, model, status, creation time, the references of the version it is created with (top-level field, target, whether the field is required), its tree parent and its previous sibling (sortable models, and children of one tree parent, sorted by position). Records of the tracking model are skipped. Records the CMA flags invalid (an invalid published version, or an invalid current version unless the model saves invalid drafts) stop the import here, all counted and the first twenty listed, before anything is written.
2. **Plan.** One rule orders every record: R is created only once every record it depends on is completely written, that is created and, when the dump has it published, published. R depends on the records it links to (at any depth: links, Structured Text links and inline records, and inside blocks), its tree parent and its previous sibling. That rule meets every ordering constraint of the CMA: links must point to existing records; publishing needs the linked records and the tree parent published (`UNPUBLISHED_LINK`, `UNPUBLISHED_PARENT`); models without draft mode publish on create; and a record created without a position is appended to its siblings, so creating siblings in order rebuilds sortable and tree order without a reorder pass.

   Records in a dependency cycle are found as strongly connected components (Tarjan's algorithm, iterative). The members of each cyclic component are ranked oldest first (records mostly link to older ones) by Kahn's algorithm over the dependencies that cannot wait: tree parent, previous sibling and required links; if required links themselves loop, over parent and previous sibling only, which never loop. Every field of a member holding a link to a member at or after it in that rank, including itself, is deferred: created empty and written later. The remaining dependencies form no cycle: between components they follow the condensation, and within one they point to lower ranks.
3. **Folders**, one at a time, parents first and each sibling group in ascending position, with their own IDs and positions.
4. **Uploads**, 8 at a time, with their IDs and metadata. The file, from the dump or downloaded from the original-file URL, is written to the temporary directory under the upload's extension (the SDK takes the content type from it) and uploaded with `createFromLocalFile`.
5. **Records**, 8 at a time in dependency order. Each is created with `items.rawCreate` from its published version if it has one, else its current one: its ID, every field (blocks in full with their IDs; deferred fields empty), its tree parent, and `meta.created_at` and `meta.first_published_at`. A published record of a draft-mode model is then published with `recursive: false`.
6. **Finish**, 8 at a time, for the records that need it: deferred fields written and published again; the current version of records with unpublished changes; a workflow stage other than the initial one; and scheduled publications and unpublishings still in the future (past ones are counted and skipped, since the CMA refuses them).

**IDs.** Records, blocks, uploads and folders are created under the dump's IDs, so every link and reference stays valid. The CMA accepts only version 4 UUIDs as new IDs, and older projects still hold legacy numeric ones: each numeric ID is replaced by a UUID derived from it (a hash of the number with the version and variant bits set), wherever it appears, so references stay consistent with no table of IDs in memory.

The first failure stops starting new requests, waits for the running ones, and throws `IMPORT_FAILED`, naming the step and the CMA's error codes. On SIGINT or SIGTERM the temporary files are removed and the command exits with 130 or 143. Nothing in the destination is undone; it is a disposable sandbox.

## Testing

`npm test` runs offline: the export and the import go through an in-memory CMA that enforces the live-verified rules the import's order depends on, and a dump imported and exported again must equal the original. The planner, the payload builder, the schema view and its advice, the zip files, the concurrency helpers and the commands have their own tests. `npm run test:integration` runs the same round trip against a throwaway DatoCMS project, including the native autogenerate advice, which is the check that the CMA accepts what the emulator accepts.
