---
'@datocms/cli-plugin-content-diff': minor
---

Add content migrations as editable TypeScript CMA scripts. `content:diff` generates timestamped migrations with separate baseline evidence and asset files, and execution rebuilds the dependency and safety plan from the script before writing. Run them through the plugin-owned `content:apply` command without changing the native CLI. Scripts default to a `content/` subdirectory so the schema migration runner does not discover them. Large scripts use bounded parts, interruption drains submitted work, and repair restores eligible schedules and field settings without resuming content writes. The content plugin requires Node.js 22.13+ or 24+ and never promotes an environment automatically.

Add precise content-client types, descriptive generated labels and project formatting, a read-only apply preview, and optional names for owned result forks. Preview rebuilds and checks the edited plan without applying it; execution reports verified progress by model and resource.

Reuse the public CMA identity validator, bulk schema reads and tsx loader, and keep authentication on public CLI and SDK APIs. Preserve uncertain fork IDs in sanitized errors, unify execution around the rebuilt plan, and remove retired JSON-plan and speculative environment-lock paths.

Reject incompatible schemas before capturing content, avoiding unnecessary full-project reads when the environments need schema alignment.

Read each environment once during content generation and remove the generation verification flag. Generation relies on external write controls; apply retains its destination conflict and verification checks.
