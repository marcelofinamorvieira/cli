import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { expect } from 'chai';
import { register as registerTsx } from 'tsx/cjs/api';
import * as ts from 'typescript';
import {
  GENERATED_RUNTIME_SHARED_MODULES,
  GENERATED_RUNTIME_SHARED_SOURCE,
} from '../../src/content-diff/generated/runtime-shared';
import {
  RUNTIME_VERSION,
  type RuntimeFormat,
  renderRuntime,
} from '../../src/content-diff/runtime-template';
import { sharedFailure } from '../../src/content-diff/shared/failure-factory';
import {
  SHARED_FAILURE_CODES,
  type SharedFailureKind,
} from '../../src/content-diff/shared/failure-kinds';
import {
  ContentDiffError,
  type JsonObject,
} from '../../src/content-diff/types';

/**
 * Runtime twin names that were renamed or removed when their logic moved to
 * src/content-diff/shared. The hand-written runtime must never declare them
 * again, so a deleted twin cannot quietly come back under its old name.
 *
 * The list is complete for the move: it holds every top-level name of the
 * pre-move runtime that the assembled runtime no longer declares, plus
 * runtimeTuningDefinition, which lived only between those states. Names the
 * shared source kept (for example canonicalizeRecord) are not listed; the
 * generator's collision check already rejects a hand-written copy of them.
 */
const RETIRED_RUNTIME_NAMES: readonly string[] = [
  // Tuning defaults and lookup, now read from shared/tuning.ts.
  'DEFAULT_SCHEDULE_SAFETY_WINDOW_MS',
  'DEFAULT_UPLOAD_PROCESSING_TIMEOUT_MS',
  'DEFAULT_VALIDITY_PROCESSING_TIMEOUT_MS',
  'runtimeTuningDefinition',
  // Upload filename helpers, now the shared/upload-contract.ts names.
  'basenameFromFilename',
  'filenameExtension',
  'safeFilename',
  // Nested-block identity, fields and walkers, now shared/nested-blocks.ts
  // and shared/embedded-blocks.ts.
  'collectBlockOwnershipFieldValue',
  'collectBlockOwnershipStructuredTextNode',
  'collectBlockOwnershipValue',
  'isNestedItem',
  'mapRuntimeFieldBlocks',
  'mapRuntimeNonLocalizedFieldBlocks',
  'mapRuntimeStructuredTextBlockNodes',
  'nestedItemFields',
  'nestedItemIdentity',
  // Reference and upload walkers, now shared/references.ts visitors behind
  // the collectRecordReferencesFromFields and
  // collectUploadReferencesFromFields adapters.
  'collectRecordReferencesFromEmbedded',
  'collectRecordReferencesFromStructuredText',
  'collectRecordReferencesFromStructuredTextNode',
  'collectUploadReferencesFromEmbedded',
  'collectUploadReferencesFromStructuredText',
  'collectUploadReferencesFromStructuredTextNode',
  // Canonicalization helpers, now the shared/canonicalize.ts names.
  'canonicalizeUpload',
  'requiredCmaBoolean',
  'requiredTimestamp',
  'sortLocalesObject',
  // Plan analyses, now shared/topology.ts, create-defaults.ts,
  // create-sanitization.ts, unique-releases.ts and validation-payload.ts. The
  // record-position filter is positionedRecordPlans.
  'affectedRecordSiblingGroups',
  'childFirst',
  'convertRuntimeValidationEmbeddedValue',
  'convertRuntimeValidationRecordFields',
  'createDefaultLocales',
  'deriveSanitizedHtmlWriteRisks',
  'findInvalidUniqueReleaseField',
  'isProvablySanitizerByteStableText',
  'orderedRecordPlans',
  // Manifest and plan validation, now shared/plan-validation.ts, which
  // generation runs too.
  'assertEnvelope',
  'validatePlan',
  // Generic set helpers shared from plan-validation.ts under their old
  // names, renamed so they cannot collide with hand-written helpers.
  'sameStringSet',
  'unique',
  // CMA not-found detection, schedule parsing and the ledger contract, now
  // shared/cma-errors.ts, schedules.ts and legacy-id-ledger.ts.
  'collectLegacyMappingFieldMismatches',
  'includedRelationship',
  'isNotFound',
  'parseRuntimeScheduleLocales',
  'parseRuntimeSelectivePublication',
  'validateLegacyIdMappingRegistry',
  'validateStoredLegacyIdMappingEntry',
];

/**
 * sha256 of each released runtime as write-artifacts writes it (trimmed and
 * newline-terminated). A released version's bytes are immutable: changing
 * the header, the generated shared source, the hand-written body, or the
 * footer afterwards requires bumping CONTENT_DIFF_RUNTIME_VERSION. Record
 * v17 here when it ships.
 */
const RELEASED_RUNTIME_DIGESTS: Readonly<
  Record<string, { js: string; ts: string }>
> = {};

/**
 * Diagnostics that mean the assembled runtime is broken: unresolved names,
 * duplicate declarations, use before declaration, calling a non-function,
 * and wrong argument counts. checkJs accepts two top-level function
 * declarations with the same name, as JavaScript does, so duplicated
 * functions are caught by duplicateTopLevelNames instead.
 */
const FATAL_ASSEMBLY_DIAGNOSTIC_CODES = new Set([
  2300, 2304, 2349, 2393, 2448, 2451, 2454, 2552, 2554, 2555, 2582,
]);

const ROOT = resolve(__dirname, '../..');

type Signature = { minimum: number; maximum: number };

type RuntimeSharedScripts = {
  RUNTIME_PLATFORM_IMPORTS: Readonly<Record<string, readonly string[]>>;
  GENERATED_MODULE_PATH: string;
  SHARED_MODULE_HEADER: readonly string[];
  OUT_OF_DATE_MESSAGE: string;
  renderSharedRuntime(root: string): {
    source: string;
    modules: string[];
    topLevel: Map<string, string>;
    signatures: Map<string, Signature>;
    environmentProvided: string[];
  };
  renderGeneratedModule(root: string): string;
  readHandwrittenRuntimeBody(root: string): string;
  validateAssembly(root: string): string[];
  isGeneratedModuleCurrent(root: string): boolean;
  writeGeneratedModule(root: string): void;
  locateRuntimeLine(root: string, runtimeFile: string, line: number): string;
};

async function importRuntimeSharedScripts(): Promise<RuntimeSharedScripts> {
  return (await import(
    pathToFileURL(resolve(__dirname, '../../scripts/runtime-shared.mjs')).href
  )) as RuntimeSharedScripts;
}

describe('generated shared runtime source', () => {
  let scripts: RuntimeSharedScripts;
  const temporaryDirectories: string[] = [];

  before(async () => {
    scripts = await importRuntimeSharedScripts();
  });

  after(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  async function temporaryDirectory(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
  }

  it('is up to date with the shared TypeScript modules', async () => {
    const checkedIn = await readFile(
      join(ROOT, scripts.GENERATED_MODULE_PATH),
      'utf8',
    );
    expect(checkedIn.replace(/\r\n/g, '\n')).to.equal(
      scripts.renderGeneratedModule(ROOT),
      'Run `npm run runtime:generate` and commit the result.',
    );
    const rendered = scripts.renderSharedRuntime(ROOT);
    expect(GENERATED_RUNTIME_SHARED_SOURCE).to.equal(rendered.source);
    expect([...GENERATED_RUNTIME_SHARED_MODULES]).to.deep.equal(
      rendered.modules,
    );
    expect(scripts.isGeneratedModuleCurrent(ROOT)).to.equal(true);
  });

  it('reports no contract, cycle, collision, or binding violations', () => {
    expect(scripts.validateAssembly(ROOT)).to.deep.equal([]);
  });

  it('assembles header, shared source, hand-written body, and footer', () => {
    const body = scripts.readHandwrittenRuntimeBody(ROOT);
    expect(body.length).to.be.greaterThan(0);
    for (const format of ['js', 'ts'] as const) {
      const runtime = renderRuntime(format);
      const assembled = GENERATED_RUNTIME_SHARED_SOURCE + body;
      expect(runtime.indexOf(assembled), format).to.be.greaterThan(0);
      expect(runtime.indexOf(body), format).to.equal(runtime.lastIndexOf(body));
    }
  });

  it('type-checks the assembled runtime without unresolved, duplicate, or misused names', () => {
    const check = checkAssembledRuntime(renderRuntime('js'));
    expect(check.globalDiagnostics).to.deep.equal([]);
    expect(check.fatal).to.deep.equal([]);
  });

  it('declares every top-level name once across the shared source and the hand-written body', () => {
    expect(
      duplicateTopLevelNames(
        GENERATED_RUNTIME_SHARED_SOURCE,
        scripts.readHandwrittenRuntimeBody(ROOT),
      ),
    ).to.deep.equal([]);
  });

  it('catches a function the shared source and the hand-written body both declare', () => {
    const body = scripts.readHandwrittenRuntimeBody(ROOT);
    const twin = 'function isObject(value) {\n  return !!value;\n}\n';
    const runtime = renderRuntime('js').replace(body, () => twin + body);
    // checkJs alone lets the twin through; the name check does not.
    expect(checkAssembledRuntime(runtime).fatal).to.deep.equal([]);
    expect(
      duplicateTopLevelNames(GENERATED_RUNTIME_SHARED_SOURCE + twin, body),
    ).to.deep.equal(['isObject']);
  });

  it('calls shared functions from hand-written code with a compatible argument count', () => {
    const runtime = renderRuntime('js');
    const body = scripts.readHandwrittenRuntimeBody(ROOT);
    const sharedStart = runtime.indexOf(GENERATED_RUNTIME_SHARED_SOURCE + body);
    expect(sharedStart).to.be.greaterThan(0);
    const check = checkAssembledRuntime(runtime);
    expect(
      arityViolations(
        check,
        {
          start: sharedStart,
          end: sharedStart + GENERATED_RUNTIME_SHARED_SOURCE.length,
        },
        {
          start: sharedStart + GENERATED_RUNTIME_SHARED_SOURCE.length,
          end:
            sharedStart + GENERATED_RUNTIME_SHARED_SOURCE.length + body.length,
        },
        scripts.renderSharedRuntime(ROOT).signatures,
      ),
    ).to.deep.equal([]);
  });

  it('catches unresolved names and argument-count drift in an assembled runtime', () => {
    const shared =
      '\nfunction sharedPair(left, right) {\n  return [left, right];\n}\n';
    const body =
      '\nfunction handwritten() {\n  sharedPair(1);\n  sharedPair(1, 2);\n  sharedPair(1, 2, 3);\n  return missingName;\n}\n';
    const runtime = `'use strict';\n${shared}${body}module.exports = { handwritten };\n`;
    const start = runtime.indexOf(shared);
    const check = checkAssembledRuntime(runtime);
    expect(check.fatal.map(({ code }) => code).sort()).to.deep.equal([
      2304, 2554,
    ]);
    expect(
      arityViolations(
        check,
        { start, end: start + shared.length },
        {
          start: start + shared.length,
          end: start + shared.length + body.length,
        },
        new Map([['sharedPair', { minimum: 2, maximum: 2 }]]),
      ),
    ).to.deep.equal([
      'sharedPair(1): expected 2 arguments, received 1',
      'sharedPair(1, 2, 3): expected 2 arguments, received 3',
    ]);
  });

  it('renders both runtime formats as syntactically valid source', () => {
    for (const format of ['js', 'ts'] as const) {
      const output = ts.transpileModule(renderRuntime(format), {
        fileName: `runtime-v${RUNTIME_VERSION}.${format}`,
        reportDiagnostics: true,
        compilerOptions: {
          allowJs: true,
          target: ts.ScriptTarget.ES2022,
          module:
            format === 'ts' ? ts.ModuleKind.ESNext : ts.ModuleKind.CommonJS,
        },
      });
      expect(
        (output.diagnostics ?? []).map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
        ),
        format,
      ).to.deep.equal([]);
    }
  });

  it('binds exactly the runtime platform imports in both headers', () => {
    const expected = Object.fromEntries(
      Object.entries(scripts.RUNTIME_PLATFORM_IMPORTS).map(
        ([module, names]) => [module, [...names]],
      ),
    );
    for (const format of ['js', 'ts'] as const) {
      expect(runtimePlatformImports(format), format).to.deep.equal(expected);
    }
  });

  it('keeps released runtime versions byte-for-byte frozen', () => {
    const recorded = RELEASED_RUNTIME_DIGESTS[RUNTIME_VERSION];
    const actual = {
      js: writtenRuntimeDigest('js'),
      ts: writtenRuntimeDigest('ts'),
    };
    if (recorded) {
      expect(
        actual,
        `Runtime v${RUNTIME_VERSION} is released; bump CONTENT_DIFF_RUNTIME_VERSION instead of changing its bytes.`,
      ).to.deep.equal(recorded);
    }
    for (const digests of Object.values(RELEASED_RUNTIME_DIGESTS)) {
      expect(digests.js).to.match(/^[0-9a-f]{64}$/);
      expect(digests.ts).to.match(/^[0-9a-f]{64}$/);
    }
  });

  it('never redeclares a retired runtime twin in the hand-written body', () => {
    const declared = topLevelDeclarations(
      scripts.readHandwrittenRuntimeBody(ROOT),
    );
    expect(
      RETIRED_RUNTIME_NAMES.filter((name) => declared.has(name)),
    ).to.deep.equal([]);
  });

  it('loads the TypeScript runtime through the tsx loader used by migrations:run', async () => {
    const directory = await temporaryDirectory('datocms-runtime-shared-tsx-');
    const path = join(directory, `runtime-v${RUNTIME_VERSION}.ts`);
    await writeFile(path, `${renderRuntime('ts').trimEnd()}\n`);
    const loader = registerTsx({ namespace: randomUUID() });
    try {
      const runtime = loader.require(path, __filename) as Record<
        string,
        unknown
      >;
      expect(runtime.RUNTIME_VERSION).to.equal(RUNTIME_VERSION);
      expect(runtime.runContentDiffMigration).to.be.a('function');
    } finally {
      loader.unregister();
    }
  });

  it('builds each shared failure kind with its own code in the planner and in the runtime', async () => {
    const directory = await temporaryDirectory(
      'datocms-runtime-shared-failure-',
    );
    const path = join(directory, 'runtime.cjs');
    await writeFile(
      path,
      `${renderRuntime(
        'js',
      )}\nmodule.exports.__sharedFailure = sharedFailure;\n`,
    );
    const runtime = createRequire(join(directory, 'loader.cjs'))(path) as {
      __sharedFailure(
        kind: string,
        message: string,
        details?: JsonObject,
      ): Error & { code: string; details: unknown };
    };
    const kinds = Object.keys(SHARED_FAILURE_CODES) as SharedFailureKind[];
    expect(kinds).to.not.be.empty;

    for (const kind of kinds) {
      const codes = SHARED_FAILURE_CODES[kind];
      // The CLI formats these planner codes specially; shared code must
      // never produce them.
      expect([
        'SCHEMA_MISMATCH',
        'ENVIRONMENT_SEMANTICS_MISMATCH',
      ]).to.not.include(codes.planner);

      const planner = sharedFailure(kind, `planner ${kind}`);
      expect(planner, kind).to.be.instanceOf(ContentDiffError);
      expect(planner.name).to.equal('ContentDiffError');
      expect(planner.code).to.equal(codes.planner);
      expect(planner.message).to.equal(`planner ${kind}`);
      expect(planner.details).to.equal(undefined);
      expect(
        sharedFailure(kind, 'with details', { path: 'a.b' }).details,
      ).to.deep.equal({ path: 'a.b' });

      const executed = runtime.__sharedFailure(kind, `runtime ${kind}`);
      expect(executed, kind).to.be.instanceOf(Error);
      expect(executed).to.not.be.instanceOf(ContentDiffError);
      expect(executed.name).to.equal('ContentDiffRuntimeError');
      expect(executed.code).to.equal(codes.runtime);
      expect(executed.message).to.equal(`runtime ${kind}`);
      expect(executed.details).to.equal(null);
      expect(
        runtime.__sharedFailure(kind, 'with details', { path: 'a.b' }).details,
      ).to.deep.equal({ path: 'a.b' });
    }

    // Unknown kinds, including names inherited from Object.prototype, fail
    // closed instead of producing an error without a code.
    for (const kind of ['notAKind', 'toString', 'constructor', '__proto__']) {
      expect(
        () => sharedFailure(kind as SharedFailureKind, 'x'),
        kind,
      ).to.throw(TypeError, `Unknown shared failure kind ${kind}.`);
      let thrown: (Error & { code?: string }) | undefined;
      try {
        runtime.__sharedFailure(kind, 'x');
      } catch (error) {
        thrown = error as Error & { code?: string };
      }
      expect(thrown?.name, kind).to.equal('ContentDiffRuntimeError');
      expect(thrown?.code).to.equal('INVALID_SHARED_FAILURE');
      expect(thrown?.message).to.equal(`Unknown shared failure kind ${kind}.`);
    }
  });

  it('builds only after verifying the generated module, without regenerating it', async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['runtime:generate']).to.equal(
      'node scripts/runtime-shared.mjs --write',
    );
    expect(pkg.scripts.build).to.match(
      /^node -e "[^"]+" && node scripts\/runtime-shared\.mjs --check && tsc -b$/,
    );
    expect(pkg.scripts.prepack).to.not.include('runtime:generate');
    expect(pkg.dependencies.typescript).to.match(/^\d+\.\d+\.\d+$/);
    expect(ts.version).to.equal(pkg.dependencies.typescript);
    const attributes = await readFile(join(ROOT, '.gitattributes'), 'utf8');
    expect(attributes.split('\n')).to.include(
      'src/content-diff/generated/** text eol=lf',
    );

    const check = spawnSync(
      process.execPath,
      [join(ROOT, 'scripts/runtime-shared.mjs'), '--check'],
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(check.status, check.stderr).to.equal(0);
    const misuse = spawnSync(
      process.execPath,
      [join(ROOT, 'scripts/runtime-shared.mjs'), '--rewrite'],
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(misuse.status).to.equal(2);
  });

  it('checks out every generator input and output with LF line endings', async function () {
    const worktree = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    if (worktree.status !== 0 || worktree.stdout.trim() !== 'true') {
      this.skip();
    }
    const sharedModules = (await readdir(join(ROOT, 'src/content-diff/shared')))
      .filter((name) => name.endsWith('.ts'))
      .map((name) => `src/content-diff/shared/${name}`);
    expect(sharedModules).to.not.deep.equal([]);
    const paths = [
      ...sharedModules,
      scripts.GENERATED_MODULE_PATH,
      'src/content-diff/runtime-template.ts',
      'scripts/runtime-shared.mjs',
    ];
    const attributes = spawnSync('git', ['check-attr', 'eol', '--', ...paths], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(attributes.status, attributes.stderr).to.equal(0);
    expect(attributes.stdout.trim().split('\n')).to.deep.equal(
      paths.map((path) => `${path}: eol: lf`),
    );
  });

  describe('generator on fixture sources', () => {
    const header = () => `${scripts.SHARED_MODULE_HEADER.join('\n')}\n\n`;
    const handwrittenBody = [
      '',
      'function isObject(value) {',
      "  return typeof value === 'object' && value !== null;",
      '}',
      '',
      'function sharedFailure(kind, message, details) {',
      '  return new Error(kind + message + String(details));',
      '}',
      '',
    ].join('\n');

    async function fixtureRoot(
      modules: Record<string, string>,
      options: { typescript?: string; body?: string | null } = {},
    ): Promise<string> {
      const root = await temporaryDirectory('datocms-runtime-shared-fixture-');
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({
          dependencies: { typescript: options.typescript ?? ts.version },
        }),
      );
      await mkdir(join(root, 'src/content-diff/shared'), { recursive: true });
      await mkdir(join(root, 'src/content-diff/generated'), {
        recursive: true,
      });
      const body = options.body === undefined ? handwrittenBody : options.body;
      await writeFile(
        join(root, 'src/content-diff/runtime-template.ts'),
        body === null
          ? 'export const RUNTIME_VERSION = "17";\n'
          : `export const RUNTIME_VERSION = '17';\nconst HANDWRITTEN_RUNTIME_BODY = String.raw\`${body}\`;\n`,
      );
      for (const [name, text] of Object.entries(modules)) {
        const path = join(root, 'src/content-diff/shared', name);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, text);
      }
      return root;
    }

    it('orders modules by their value imports and emits one script-scope text', async () => {
      const root = await fixtureRoot({
        'failure-factory.ts':
          'export function sharedFailure(kind: string, message: string, details?: unknown): Error {\n  return new Error(kind + message + String(details));\n}\n',
        'alpha.ts': `${header()}import type { Beta } from './beta';\nimport { BETA_LIMIT, betaLabel } from './beta';\nimport { sharedFailure } from './failure-factory';\nimport { createHash } from 'node:crypto';\n\n/** Uses the sibling module. */\nexport function alphaLabel(value: Beta, suffix?: string): string {\n  if (value.size > BETA_LIMIT) {\n    throw sharedFailure('invalidJson', \`too large: \${value.size}\`);\n  }\n  return betaLabel(value) + (suffix ?? '') + createHash('sha256').update('\\\\d').digest('hex');\n}\n`,
        'beta.ts': `${header()}export interface Beta {\n  size: number;\n}\n\nexport const BETA_LIMIT = 128 * 1024;\nconst BETA_KEYS = Object.freeze(new Set(['a', \`b\`]));\n\nexport function betaLabel(value: Beta, ...rest: string[]): string {\n  return \`\${value.size}\${rest.join('')}\${BETA_KEYS.size}\`;\n}\n`,
      });
      expect(scripts.validateAssembly(root)).to.deep.equal([]);
      const rendered = scripts.renderSharedRuntime(root);
      expect(rendered.modules).to.deep.equal([
        'src/content-diff/shared/beta.ts',
        'src/content-diff/shared/alpha.ts',
      ]);
      expect(Object.fromEntries(rendered.topLevel)).to.deep.equal({
        BETA_LIMIT: 'src/content-diff/shared/beta.ts',
        BETA_KEYS: 'src/content-diff/shared/beta.ts',
        betaLabel: 'src/content-diff/shared/beta.ts',
        alphaLabel: 'src/content-diff/shared/alpha.ts',
      });
      expect(rendered.signatures.get('alphaLabel')).to.include({
        minimum: 1,
        maximum: 2,
      });
      expect(rendered.signatures.get('betaLabel')).to.include({
        minimum: 1,
        maximum: Number.POSITIVE_INFINITY,
      });
      expect(rendered.environmentProvided).to.deep.equal(['sharedFailure']);
      expect(rendered.source).to.match(
        /^\n\/\/ ---- src\/content-diff\/shared\/beta\.ts ----\n/,
      );
      expect(rendered.source).to.include(
        '\n\n// ---- src/content-diff/shared/alpha.ts ----\n/** Uses the sibling module. */\nfunction alphaLabel(value, suffix) {',
      );
      expect(rendered.source).to.not.match(
        /\bexport\b|\bimport\b|Inlined into/,
      );

      // The cooked template in the generated module evaluates back to the
      // exact source, including backticks, substitutions, and backslashes.
      const generated = scripts.renderGeneratedModule(root);
      const exports: Record<string, unknown> = {};
      runInNewContext(
        ts.transpileModule(generated, {
          compilerOptions: { module: ts.ModuleKind.CommonJS },
        }).outputText,
        { exports },
      );
      expect(exports.GENERATED_RUNTIME_SHARED_SOURCE).to.equal(rendered.source);
      expect(exports.GENERATED_RUNTIME_SHARED_MODULES).to.deep.equal(
        rendered.modules,
      );

      // The assembled text runs with the hand-written environment bindings.
      const context = { createHash, result: '' };
      runInNewContext(
        `${rendered.source}${handwrittenBody}\nresult = alphaLabel({ size: 1 }, '!');`,
        context,
      );
      expect(context.result).to.match(/^12!/);
      expect(() =>
        runInNewContext(
          `${rendered.source}${handwrittenBody}\nalphaLabel({ size: 1e9 });`,
          { createHash },
        ),
      ).to.throw('invalidJsontoo large: 1000000000');

      expect(scripts.isGeneratedModuleCurrent(root)).to.equal(false);
      scripts.writeGeneratedModule(root);
      expect(scripts.isGeneratedModuleCurrent(root)).to.equal(true);
      const path = join(root, scripts.GENERATED_MODULE_PATH);
      await writeFile(
        path,
        (await readFile(path, 'utf8')).replace(/\n/g, '\r\n'),
      );
      expect(scripts.isGeneratedModuleCurrent(root)).to.equal(true);
    });

    it('maps emitted runtime lines back to shared and hand-written sources', async () => {
      const root = await fixtureRoot({
        'gamma.ts': `${header()}export const GAMMA = 1;\n\nexport function gamma(value: number): number {\n  return value + GAMMA;\n}\n`,
      });
      const { source } = scripts.renderSharedRuntime(root);
      const runtimeFile = join(root, 'runtime-v17.js');
      await writeFile(
        runtimeFile,
        `'use strict';\n\n${source}${handwrittenBody}\nmodule.exports = {};\n`,
      );
      const lines = (await readFile(runtimeFile, 'utf8')).split('\n');
      const locate = (text: string) =>
        scripts.locateRuntimeLine(root, runtimeFile, lines.indexOf(text) + 1);
      expect(locate('    return value + GAMMA;')).to.equal(
        'src/content-diff/shared/gamma.ts:7',
      );
      expect(locate('// ---- src/content-diff/shared/gamma.ts ----')).to.equal(
        'src/content-diff/shared/gamma.ts (module banner)',
      );
      expect(
        locate('function sharedFailure(kind, message, details) {'),
      ).to.equal(
        'src/content-diff/runtime-template.ts:7 (hand-written runtime)',
      );
    });

    const violations: Array<{
      title: string;
      modules: Record<string, string>;
      expected: string;
    }> = [
      {
        title: 'a missing contract header',
        modules: { 'a.ts': 'export const A = 1;\n' },
        expected: 'must start with the comment',
      },
      {
        title: 'a value import from a planner module',
        modules: {
          'a.ts':
            "import { ContentDiffError } from '../types';\nexport const A = ContentDiffError;\n",
        },
        expected: 'value import from ../types is not allowed',
      },
      {
        title: 'a renamed import',
        modules: {
          'a.ts': "import { B as C } from './b';\nexport const A = C;\n",
          'b.ts': 'export const B = 1;\n',
        },
        expected: 'renamed import B as C is not allowed',
      },
      {
        title: 'a default import',
        modules: { 'a.ts': "import b from './b';\nexport const A = b;\n" },
        expected: 'default import from ./b is not allowed',
      },
      {
        title: 'a namespace import',
        modules: { 'a.ts': "import * as b from './b';\nexport const A = b;\n" },
        expected: 'namespace import from ./b is not allowed',
      },
      {
        title: 'a side-effect import',
        modules: { 'a.ts': "import './b';\nexport const A = 1;\n" },
        expected: 'side-effect import of ./b is not allowed',
      },
      {
        title: 'a built-in the runtime header does not bind',
        modules: {
          'a.ts':
            "import { readFileSync } from 'node:fs';\nexport const A = readFileSync;\n",
        },
        expected:
          'imports readFileSync from node:fs, but the runtime header binds only createReadStream, createWriteStream',
      },
      {
        title: 'an import of a name the sibling does not export',
        modules: {
          'a.ts': "import { hidden } from './b';\nexport const A = hidden;\n",
          'b.ts': 'const hidden = 1;\nexport const B = hidden;\n',
        },
        expected: 'imports hidden from ./b, which does not export it',
      },
      {
        title: 'an import from a missing sibling',
        modules: { 'a.ts': "import { B } from './b';\nexport const A = B;\n" },
        expected: 'imports from ./b, which is not a shared module',
      },
      {
        title: 'an import cycle',
        modules: {
          'a.ts':
            "import { b } from './b';\nexport function a(): number {\n  return b();\n}\n",
          'b.ts':
            "import { a } from './a';\nexport function b(): number {\n  return a();\n}\n",
        },
        expected:
          'shared modules form an import cycle: src/content-diff/shared/a.ts, src/content-diff/shared/b.ts',
      },
      {
        title: 'a let declaration',
        modules: { 'a.ts': 'export let A = 1;\n' },
        expected: 'only `const` declarations are allowed',
      },
      {
        title: 'a class',
        modules: { 'a.ts': 'export class A {}\n' },
        expected: 'classes are not allowed',
      },
      {
        title: 'an enum',
        modules: { 'a.ts': 'export enum A {\n  B,\n}\n' },
        expected: 'enums are not allowed',
      },
      {
        title: 'a namespace',
        modules: { 'a.ts': 'export namespace A {\n  export const B = 1;\n}\n' },
        expected: 'namespaces are not allowed',
      },
      {
        title: 'a declare statement',
        modules: { 'a.ts': 'declare const A: number;\n' },
        expected: '`declare` statements are not allowed',
      },
      {
        title: 'a default export',
        modules: { 'a.ts': 'export default function a(): void {}\n' },
        expected: 'default exports are not allowed',
      },
      {
        title: 'an export list',
        modules: { 'a.ts': 'const A = 1;\nexport { A };\n' },
        expected: 'only `export function`, `export const`',
      },
      {
        title: 'a re-export',
        modules: {
          'a.ts': "export * from './b';\n",
          'b.ts': 'export const B = 1;\n',
        },
        expected: 'only `export function`, `export const`',
      },
      {
        title: 'an executable statement',
        modules: { 'a.ts': 'export const A: string[] = [];\nA.push("x");\n' },
        expected: 'executable top-level statements are not allowed',
      },
      {
        title: 'top-level await',
        modules: {
          'a.ts':
            'export const A = await Promise.resolve(1);\nfor await (const b of []) {\n  void b;\n}\n',
        },
        expected: 'top-level await is not allowed',
      },
      {
        title: 'a const initializer with a side effect',
        modules: {
          'a.ts':
            'function b(): number {\n  return 1;\n}\nexport const A = b();\n',
        },
        expected: 'const initializers must be side-effect free',
      },
      {
        title: 'a function-valued const',
        modules: { 'a.ts': 'export const A = (): number => 1;\n' },
        expected: 'const initializers must be side-effect free',
      },
      {
        title: 'a reference to process',
        modules: {
          'a.ts':
            'export function a(): string | undefined {\n  return process.env.HOME;\n}\n',
        },
        expected: 'must not reference `process`',
      },
      {
        title: 'a reference to require',
        modules: {
          'a.ts':
            "export function a(): unknown {\n  return require('node:fs');\n}\n",
        },
        expected: 'must not reference `require`',
      },
      {
        title: 'eval',
        modules: {
          'a.ts': "export function a(): unknown {\n  return eval('1');\n}\n",
        },
        expected: 'must not reference `eval`',
      },
      {
        title: 'the Function constructor',
        modules: {
          'a.ts':
            "export function a(): unknown {\n  return new Function('return 1');\n}\n",
        },
        expected: 'must not reference `Function`',
      },
      {
        title: 'import.meta',
        modules: {
          'a.ts':
            'export function a(): string {\n  return import.meta.url;\n}\n',
        },
        expected: 'must not use import.meta',
      },
      {
        title: 'dynamic import',
        modules: {
          'a.ts':
            "export function a(): Promise<unknown> {\n  return import('node:fs');\n}\n",
        },
        expected: 'must not use dynamic import()',
      },
      {
        title: 'a plain Error thrown outside the self-describing modules',
        modules: {
          'a.ts': "export function a(): never {\n  throw new Error('no');\n}\n",
        },
        expected: 'shared code throws only sharedFailure',
      },
      {
        title: 'a plain error rethrown through a local binding',
        modules: {
          'a.ts':
            "export function a(): never {\n  const failure = new TypeError('no');\n  throw failure;\n}\n",
        },
        expected: 'must not create errors with `TypeError`',
      },
      {
        title: 'a plain error created without new and rejected',
        modules: {
          'a.ts':
            "export function a(): Promise<never> {\n  return Promise.reject(Error('no'));\n}\n",
        },
        expected: 'must not create errors with `Error`',
      },
      {
        title: 'an aliased error constructor',
        modules: {
          'a.ts':
            "export function a(): never {\n  const Plain = RangeError;\n  const failure = new Plain('no');\n  throw failure;\n}\n",
        },
        expected: 'must not create errors with `RangeError`',
      },
      {
        title: 'a forbidden name reached through globalThis',
        modules: {
          'a.ts':
            "export function a(): string | undefined {\n  return globalThis['process'].env.HOME;\n}\n",
        },
        expected: 'must not reference `globalThis`',
      },
      {
        title: 'a forbidden name as a globalThis property',
        modules: {
          'a.ts':
            'export function a(): string | undefined {\n  return globalThis.process.env.HOME;\n}\n',
        },
        expected: 'must not reference `globalThis`',
      },
      {
        title: 'a subdirectory',
        modules: { 'nested/a.ts': 'export const A = 1;\n' },
        expected: 'nested is a directory; the shared directory must stay flat',
      },
      {
        title: 'a name declared by two shared modules',
        modules: {
          'a.ts': 'export const SAME = 1;\n',
          'b.ts': 'export const SAME = 2;\n',
        },
        expected:
          'Top-level name `SAME` is declared by both src/content-diff/shared/a.ts and src/content-diff/shared/b.ts',
      },
      {
        title: 'a name the hand-written runtime still declares',
        modules: {
          'a.ts':
            'export function isObject(value: unknown): boolean {\n  return value !== null;\n}\n',
        },
        expected:
          'Top-level name `isObject` is declared by both src/content-diff/shared/a.ts and the hand-written runtime; delete the hand-written copy or rename one.',
      },
      {
        title: 'a runtime header binding',
        modules: {
          'a.ts': 'export function createHash(): number {\n  return 1;\n}\n',
        },
        expected:
          'declares top-level name `createHash`, which is a runtime header binding from node:crypto',
      },
      {
        // Every wrapper name is also a forbidden identifier, which fires first.
        title: 'a CommonJS wrapper name',
        modules: { 'a.ts': 'export const __filename = 1;\n' },
        expected: 'must not reference `__filename`',
      },
      {
        title: 'a reserved global',
        modules: { 'a.ts': 'export const structuredClone = 1;\n' },
        expected: 'which is a reserved JavaScript or Node.js global',
      },
      {
        title: 'an environment binding the hand-written runtime lacks',
        modules: {
          'failure-factory.ts':
            'export function sharedFailure(): Error {\n  return new Error();\n}\nexport function otherFailure(): Error {\n  return new Error();\n}\n',
          'a.ts':
            "import { otherFailure } from './failure-factory';\nexport function a(): never {\n  throw otherFailure();\n}\n",
        },
        expected:
          'exports otherFailure, but the hand-written runtime does not declare a top-level function otherFailure',
      },
      {
        title: 'an environment import without the failure factory',
        modules: {
          'a.ts':
            "import { sharedFailure } from './failure-factory';\nexport function a(): never {\n  throw sharedFailure();\n}\n",
        },
        expected: 'does not exist',
      },
    ];

    it('accepts error types, instanceof checks, rethrows, and self-describing errors', async () => {
      const root = await fixtureRoot({
        'a.ts': `${header()}interface Detailed extends Error {\n  readonly detail?: unknown;\n}\n\n/** Rethrows the first caught failure. */\nexport function a(values: unknown[]): Detailed | null {\n  let firstError: unknown = null;\n  for (const value of values) {\n    try {\n      if (value instanceof TypeError) return value;\n    } catch (error) {\n      firstError ??= error;\n    }\n  }\n  if (firstError instanceof Error) throw firstError;\n  return null;\n}\n`,
        'tuning.ts': `${header()}export function tuning(): never {\n  throw Object.assign(new RangeError('bad'), { code: 'INVALID_TUNING' });\n}\n`,
      });
      expect(scripts.validateAssembly(root)).to.deep.equal([]);
    });

    for (const violation of violations) {
      it(`rejects ${violation.title}`, async () => {
        const modules = Object.fromEntries(
          Object.entries(violation.modules).map(([name, text]) => [
            name,
            name === 'failure-factory.ts' ||
            violation.title === 'a missing contract header'
              ? text
              : `${header()}${text}`,
          ]),
        );
        const root = await fixtureRoot(modules);
        const diagnostics = scripts.validateAssembly(root);
        expect(
          diagnostics.some((diagnostic) =>
            diagnostic.includes(violation.expected),
          ),
          diagnostics.join('\n'),
        ).to.equal(true);
        expect(() => scripts.renderSharedRuntime(root)).to.throw(
          'violate the inlining contract',
        );
      });
    }

    it('rejects a TypeScript range or a different installed compiler', async () => {
      for (const typescript of [`^${ts.version}`, '0.0.1']) {
        const diagnostics = scripts.validateAssembly(
          await fixtureRoot({}, { typescript }),
        );
        expect(diagnostics, typescript).to.have.length(1);
        expect(diagnostics[0], typescript).to.match(/^package\.json: /);
      }
    });

    it('rejects a runtime template without exactly one String.raw hand-written body', async () => {
      const missing = scripts.validateAssembly(
        await fixtureRoot({}, { body: null }),
      );
      expect(missing).to.deep.equal([
        'src/content-diff/runtime-template.ts: expected exactly one HANDWRITTEN_RUNTIME_BODY declaration, found 0.',
      ]);
      const substituted = scripts.validateAssembly(
        await fixtureRoot({}, { body: '${1}' }),
      );
      expect(substituted[0]).to.include(
        'must be a top-level const initialized with a String.raw template without substitutions',
      );
    });
  });
});

type AssembledRuntimeCheck = {
  program: ts.Program;
  sourceFile: ts.SourceFile;
  globalDiagnostics: string[];
  fatal: Array<{ code: number; line: number; message: string }>;
};

function checkAssembledRuntime(runtime: string): AssembledRuntimeCheck {
  const fileName = resolve(ROOT, '.datocms-runtime-shared-check.cjs');
  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    strict: false,
    noImplicitAny: false,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    lib: ['lib.es2023.d.ts'],
    types: ['node'],
    // Wherever npm put @types/node: hoisted in a workspace, local otherwise.
    typeRoots: [dirname(dirname(require.resolve('@types/node/package.json')))],
    skipLibCheck: true,
  };
  // Serve the runtime from memory so the check never writes into the tree.
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.readFile = (path) => (path === fileName ? runtime : readFile(path));
  host.fileExists = (path) => path === fileName || fileExists(path);
  host.getSourceFile = (path, languageVersion, onError, shouldCreate) =>
    path === fileName
      ? ts.createSourceFile(
          path,
          runtime,
          languageVersion,
          true,
          ts.ScriptKind.JS,
        )
      : getSourceFile(path, languageVersion, onError, shouldCreate);
  const program = ts.createProgram([fileName], options, host);
  const sourceFile = program.getSourceFile(fileName)!;
  const globalDiagnostics = [
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
  ].map((diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
  );
  const fatal = ts
    .getPreEmitDiagnostics(program, sourceFile)
    .filter((diagnostic) =>
      FATAL_ASSEMBLY_DIAGNOSTIC_CODES.has(diagnostic.code),
    )
    .map((diagnostic) => ({
      code: diagnostic.code,
      line:
        sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line +
        1,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
    }));
  return { program, sourceFile, globalDiagnostics, fatal };
}

/**
 * JavaScript lets missing arguments through, so compare each hand-written
 * call into shared code against the shared TypeScript signature.
 */
function arityViolations(
  check: AssembledRuntimeCheck,
  shared: { start: number; end: number },
  handwritten: { start: number; end: number },
  signatures: ReadonlyMap<string, Signature>,
): string[] {
  const checker = check.program.getTypeChecker();
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.getStart(check.sourceFile) >= handwritten.start &&
      node.getEnd() <= handwritten.end
    ) {
      const declarations =
        checker.getSymbolAtLocation(node.expression)?.declarations ?? [];
      const signature = signatures.get(node.expression.text);
      if (
        signature &&
        declarations.length > 0 &&
        declarations.every(
          (declaration) =>
            declaration.getStart(check.sourceFile) >= shared.start &&
            declaration.getEnd() <= shared.end,
        )
      ) {
        const count = node.arguments.length;
        if (count < signature.minimum || count > signature.maximum) {
          const expected =
            signature.minimum === signature.maximum
              ? String(signature.minimum)
              : signature.maximum === Number.POSITIVE_INFINITY
                ? `at least ${signature.minimum}`
                : `${signature.minimum} to ${signature.maximum}`;
          violations.push(
            `${node.getText(
              check.sourceFile,
            )}: expected ${expected} arguments, received ${count}`,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(check.sourceFile);
  return violations;
}

function runtimePlatformImports(
  format: RuntimeFormat,
): Record<string, string[]> {
  const sourceFile = ts.createSourceFile(
    `runtime.${format}`,
    renderRuntime(format),
    ts.ScriptTarget.ES2022,
    true,
    format === 'ts' ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
  const imports: Record<string, string[]> = {};
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      expect(clause?.name, 'default import').to.equal(undefined);
      const bindings = clause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) {
        throw new Error('The runtime header must use named imports.');
      }
      const module = (statement.moduleSpecifier as ts.StringLiteral).text;
      expect(imports, module).to.not.have.property(module);
      imports[module] = bindings.elements.map((element) => {
        expect(element.propertyName, element.name.text).to.equal(undefined);
        return element.name.text;
      });
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer;
      if (
        initializer &&
        ts.isCallExpression(initializer) &&
        ts.isIdentifier(initializer.expression) &&
        initializer.expression.text === 'require'
      ) {
        if (!ts.isObjectBindingPattern(declaration.name)) {
          throw new Error('The runtime header must destructure require().');
        }
        const module = (initializer.arguments[0] as ts.StringLiteral).text;
        expect(imports, module).to.not.have.property(module);
        imports[module] = declaration.name.elements.map((element) => {
          expect(element.propertyName, 'renamed binding').to.equal(undefined);
          return (element.name as ts.Identifier).text;
        });
      }
    }
  }
  return imports;
}

function writtenRuntimeDigest(format: RuntimeFormat): string {
  return createHash('sha256')
    .update(`${renderRuntime(format).trimEnd()}\n`)
    .digest('hex');
}

/**
 * Names declared more than once at the top level of the assembled script.
 * Parsed independently of the generator, so a generator bug cannot hide a
 * shared function that still has a hand-written twin.
 */
function duplicateTopLevelNames(shared: string, body: string): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const name of [
    ...topLevelDeclarationList(shared),
    ...topLevelDeclarationList(body),
  ]) {
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  }
  return [...duplicates].sort();
}

function topLevelDeclarations(body: string): Set<string> {
  return new Set(topLevelDeclarationList(body));
}

/** Every top-level name the script declares, in order, with repeats. */
function topLevelDeclarationList(body: string): string[] {
  const sourceFile = ts.createSourceFile(
    'runtime-part.js',
    body,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS,
  );
  const names: string[] = [];
  const collect = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      names.push(name.text);
      return;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) collect(element.name);
    }
  };
  for (const statement of sourceFile.statements) {
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement)) &&
      statement.name
    ) {
      names.push(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        collect(declaration.name);
      }
    }
  }
  return names;
}
