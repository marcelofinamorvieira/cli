# Content diff boundary

Keep content diff entirely within `@datocms/cli-plugin-content-diff`. It must work with the unmodified DatoCMS CLI and published shared utilities. Do not change, override, or patch native CLI commands or add content-specific contracts to `cli-utils`; generation and execution belong to `content:diff` and `content:apply`.
