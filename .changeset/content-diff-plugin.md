---
"@datocms/cli-plugin-content-diff": minor
---

Add `@datocms/cli-plugin-content-diff`, a plugin that moves content between
environments, or between duplicated projects, as a reviewable migration.

`content:diff` compares a source environment with a destination and writes a
migration plus a plan listing every change: records with their current and
published versions, nested blocks, references, uploads and upload collections,
publication schedules, positions and workflow stages. Generating never changes
the project. The migration applies the plan with `migrations:run`, normally in
a fork, and verifies the result before it finishes.

The plugin supplies its own `migrations:new` and `migrations:run`, which keep
working for ordinary migrations, and supports `datocms` 4.x from 4.2.0 on.
