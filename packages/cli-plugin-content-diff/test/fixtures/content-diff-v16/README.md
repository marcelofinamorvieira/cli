# Historical runtime v16 fixture

`no-op-bundle.json.gz` freezes the original JavaScript runtime, generated migration entrypoint, and generated no-op manifest from commit `2ea45ce94692142ab3a4c08fb8989743b111b5ba`. The runtime SHA-256 is `2a4ac6ea924fd6f3cbdb82b92c32713f48be9a5e29ec1c2c4d9315641f803200`.

The fixture was produced from an isolated archive of that commit's `src` directory and `test/content-diff/runtime.test.ts`. Its original `makeRuntimePlan('unchanged', 'unchanged')` and `makeEnvelope` helpers generated the manifest, serialized with `JSON.stringify(envelope, null, 2) + '\n'`. The original `renderRuntime('js')` and `renderEntrypoint('js', '1700000000_historical.plan.json', sha256(manifest), envelope.plan.target.siteId)` generated the runtime and entrypoint. The enclosing JSON object was compressed with Node's `gzipSync(..., { level: 9 })`.

The regression test decompresses and executes these historical bytes without Git, network access, or installed historical dependencies. Keep this fixture frozen when the current runtime changes: its purpose is to verify execution and integrity compatibility with an actual previously generated migration.
