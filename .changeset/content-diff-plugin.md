---
'@datocms/cli-plugin-content-diff': minor
---

Add `@datocms/cli-plugin-content-diff`, a plugin that copies content between
two DatoCMS environments, in the same project or across two projects.

`content:diff` compares a source environment with a destination and writes a
reviewable, checksummed content bundle. It never changes either project.

`content:apply` verifies the bundle, applies it into a new fork of the
destination, and verifies the result before it finishes. It writes into an
existing environment only when asked to with explicit flags, and it never
promotes the fork. The plugin requires Node.js 22.13+ or 24+.
