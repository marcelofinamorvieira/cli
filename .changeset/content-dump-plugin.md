---
'@datocms/cli-plugin-content-dump': minor
---

Add the `content:export` and `content:import` commands. `content:export` writes an environment's content to a dump file: every record with its published version and newer draft, every upload and upload folder, and optionally every asset file. `content:import` writes a dump into an empty sandbox environment that has the dump's schema, under the original IDs (legacy numeric IDs, which the CMA no longer accepts, get UUIDs derived from them) and in the order the CMA requires, including records that link to each other. It checks the schema first, and when the schemas differ it lists the differences and, when the environment the dump came from still has that schema, gives the `migrations:new --autogenerate` and `migrations:run` commands that copy it.
