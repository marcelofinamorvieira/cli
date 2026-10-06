---
'@datocms/cli-plugin-content-diff': minor
---

Add content migrations as editable TypeScript scripts that execute real CMA calls in their written order. Generation checks schema compatibility, captures content once using temporary SQLite, plans dependencies and emits the required execution phases. Apply validates the saved destination baseline and runs the script directly, without local intent recording or replanning. Large scripts use bounded TypeScript parts and disposable processes.

Keep content generation and execution inside the plugin with public SDK and CLI APIs. Support fork-first execution, explicit in-place/primary authorization, conservative repair, original asset binaries, typed CMA methods, descriptive comments, project formatting and sanitized errors. A preflight-only check replaces simulated dry-run; edited scripts own their execution order and behavior. Earlier simulated migration artifacts must be regenerated. Node.js 22.13+ on the 22.x line, or 24+, is required.
