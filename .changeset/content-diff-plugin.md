---
'@datocms/cli-plugin-content-diff': minor
'datocms': minor
'@datocms/cli-utils': minor
---

Add content migrations as editable TypeScript CMA scripts. `content:diff` generates timestamped migrations with separate baseline evidence and asset files, and execution rebuilds the dependency and safety plan from the script before writing. Run them through `content:apply` or the native `migrations:run` workflow, which supplies managed execution context and preserves ownership of its fork and completion receipt. Large scripts use bounded parts, interruption drains submitted work, and repair restores eligible schedules and field settings without resuming content writes. The content plugin requires Node.js 22.13+ or 24+ and never promotes an environment automatically.
