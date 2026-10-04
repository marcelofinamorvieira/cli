---
'@datocms/cli-plugin-content-diff': patch
---

Content bundles now guard observed concurrent edits, restore schedules after failed writes, and clean up gracefully when interrupted. Indexed planning and execution avoid repeated full scans on large projects. Exports download original asset bytes, and asset folder hierarchy and ordering are preserved. Workflow permissions, block ownership, localized defaults, self-references, and unsupported metadata or schedule transitions are checked against native API behavior before mutation. Unsafe integer precision is rejected before comparison or writes instead of silently rounding content or schema settings.
