import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Generator and validator for the shared prefix of the migration runtime.
 *
 * Every module in src/content-diff/shared (except the planner-side
 * failure-factory.ts) is transpiled with the pinned TypeScript compiler,
 * stripped of module syntax, and checked in as one JavaScript text in
 * src/content-diff/generated/runtime-shared.ts. renderRuntime() emits that
 * text between the runtime header and the hand-written runtime body, so the
 * planner and every generated migration run the same shared logic.
 *
 * The emitted bytes depend only on checked-in text: fixed compiler options,
 * repo-relative POSIX paths, code-unit ordering, and LF line endings.
 *
 *   node scripts/runtime-shared.mjs [--check]   fail when the file is stale
 *   node scripts/runtime-shared.mjs --write     rewrite the generated module
 *   node scripts/runtime-shared.mjs --locate <runtime-file>:<line>
 *                                               map an emitted runtime line
 *                                               back to its source line
 */

const localRequire = createRequire(import.meta.url);
const ts = localRequire('typescript');

export const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
);
export const SHARED_DIRECTORY = 'src/content-diff/shared';
export const GENERATED_MODULE_PATH =
  'src/content-diff/generated/runtime-shared.ts';
export const RUNTIME_TEMPLATE_PATH = 'src/content-diff/runtime-template.ts';
export const HANDWRITTEN_RUNTIME_BODY_NAME = 'HANDWRITTEN_RUNTIME_BODY';
/** Planner implementation of the bindings the hand-written runtime provides. */
export const ENVIRONMENT_PROVIDED_MODULE = 'failure-factory.ts';
export const SHARED_MODULE_HEADER = Object.freeze([
  '// Inlined into the generated migration runtime by scripts/runtime-shared.mjs.',
  '// Keep it dependency-free; any change changes the runtime bytes.',
]);
export const OUT_OF_DATE_MESSAGE = `${GENERATED_MODULE_PATH} is out of date with ${SHARED_DIRECTORY}. Run \`npm run runtime:generate\` and commit the result.`;

/**
 * The exact built-in bindings the runtime header provides. Shared modules may
 * import only these names, and the header stays their single binding site.
 */
export const RUNTIME_PLATFORM_IMPORTS = Object.freeze({
  'node:crypto': Object.freeze(['createHash']),
  'node:fs': Object.freeze(['createReadStream', 'createWriteStream']),
  'node:fs/promises': Object.freeze(['mkdtemp', 'rm']),
  'node:os': Object.freeze(['tmpdir']),
  'node:path': Object.freeze([
    'dirname',
    'isAbsolute',
    'join',
    'relative',
    'resolve',
  ]),
  'node:stream': Object.freeze(['Readable', 'Transform']),
  'node:stream/promises': Object.freeze(['pipeline']),
});

export const COMMONJS_WRAPPER_NAMES = Object.freeze([
  'require',
  'module',
  'exports',
  '__filename',
  '__dirname',
]);

export const RESERVED_GLOBAL_NAMES = Object.freeze([
  'Object',
  'Array',
  'Map',
  'Set',
  'Symbol',
  'Promise',
  'Error',
  'TypeError',
  'JSON',
  'Math',
  'Number',
  'String',
  'Boolean',
  'BigInt',
  'Date',
  'RegExp',
  'URL',
  'Buffer',
  'fetch',
  'process',
  'console',
  'setTimeout',
  'clearTimeout',
  'setImmediate',
  'AbortController',
  'Response',
  'ReadableStream',
  'structuredClone',
  'globalThis',
  'undefined',
  'NaN',
  'Infinity',
  'queueMicrotask',
]);

/**
 * Identifiers a shared module may not mention anywhere. globalThis is listed
 * because property access on it would reach the others by name.
 */
export const FORBIDDEN_SHARED_IDENTIFIERS = Object.freeze([
  'process',
  'require',
  'module',
  'exports',
  '__dirname',
  '__filename',
  'eval',
  'Function',
  'globalThis',
]);

/**
 * Modules whose self-describing errors are already identical on both sides.
 * Every other shared module throws only sharedFailure(...) or rethrows.
 */
const SELF_DESCRIBING_ERROR_MODULES = new Set([
  'tuning.ts',
  'download-asset.ts',
]);

/**
 * Built-in error constructors. Outside the self-describing modules they may
 * appear only in types and on the right of instanceof, so a rethrown
 * identifier can only carry a caught error or a sharedFailure(...) result.
 */
const ERROR_CONSTRUCTOR_NAMES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'EvalError',
  'URIError',
  'AggregateError',
]);

const SHARED_SIBLING_SPECIFIER = /^\.\/([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const ARITHMETIC_OPERATORS = new Set([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.BarToken,
  ts.SyntaxKind.AmpersandToken,
  ts.SyntaxKind.CaretToken,
  ts.SyntaxKind.LessThanLessThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
]);
const UNARY_OPERATORS = new Set([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.ExclamationToken,
  ts.SyntaxKind.TildeToken,
]);

/** Locale-independent ordering, so output is identical on every machine. */
export function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Transpile and validate every shared module. Throws with every contract,
 * cycle, and collision diagnostic when any exists.
 */
export function renderSharedRuntime(root = PACKAGE_ROOT) {
  const analysis = analyzeSharedRuntime(root);
  if (analysis.diagnostics.length > 0) {
    throw new Error(
      `Shared runtime modules violate the inlining contract:\n${analysis.diagnostics
        .map((diagnostic) => `  - ${diagnostic}`)
        .join('\n')}`,
    );
  }
  return {
    source: analysis.source,
    modules: analysis.modules.map(({ path }) => path),
    topLevel: analysis.topLevel,
    signatures: analysis.signatures,
    environmentProvided: analysis.environmentProvided,
  };
}

/** Every contract, cycle, collision, and binding diagnostic, in order. */
export function validateAssembly(root = PACKAGE_ROOT) {
  return analyzeSharedRuntime(root).diagnostics;
}

/** The complete text of src/content-diff/generated/runtime-shared.ts. */
export function renderGeneratedModule(root = PACKAGE_ROOT) {
  const { source, modules } = renderSharedRuntime(root);
  const moduleList =
    modules.length === 0
      ? '[]'
      : `[\n${modules.map((path) => `  '${path}',\n`).join('')}]`;
  return [
    '// Generated by scripts/runtime-shared.mjs from src/content-diff/shared. Do not edit.',
    '// Change the shared TypeScript modules and run `npm run runtime:generate`.',
    '// The migration runtime embeds this text verbatim: any change here changes the',
    '// bytes of the versioned runtime (see RELEASED_RUNTIME_DIGESTS in',
    '// test/content-diff/runtime-shared.test.ts).',
    '',
    '/** Shared modules in inclusion order. */',
    `export const GENERATED_RUNTIME_SHARED_MODULES: readonly string[] = ${moduleList};`,
    '',
    // A cooked template keeps multi-line JavaScript readable; an empty source
    // stays a plain string literal.
    `export const GENERATED_RUNTIME_SHARED_SOURCE: string = ${
      source === '' ? "''" : `\`${escapeTemplateText(source)}\``
    };`,
    '',
  ].join('\n');
}

/**
 * Whether the checked-in generated module matches the shared modules. Only
 * compares: verification must never rewrite sources (for example during
 * `prepare` in a consumer's install). CRLF checkouts compare equal.
 */
export function isGeneratedModuleCurrent(root = PACKAGE_ROOT) {
  const path = join(root, GENERATED_MODULE_PATH);
  const expected = renderGeneratedModule(root);
  return (
    existsSync(path) &&
    readFileSync(path, 'utf8').replace(/\r\n/g, '\n') === expected
  );
}

/** Rewrite the generated module when its text differs. */
export function writeGeneratedModule(root = PACKAGE_ROOT) {
  const path = join(root, GENERATED_MODULE_PATH);
  const expected = renderGeneratedModule(root);
  const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (current !== expected) writeFileSync(path, expected);
}

/**
 * The raw text of the single `const HANDWRITTEN_RUNTIME_BODY = String.raw`
 * template in runtime-template.ts, which is exactly the string it evaluates to.
 */
export function readHandwrittenRuntimeBody(root = PACKAGE_ROOT) {
  return locateHandwrittenRuntimeBody(root).text;
}

/**
 * Map a line of an emitted runtime file (1-based) to the shared TypeScript
 * line or the runtime-template.ts line it came from.
 */
export function locateRuntimeLine(root, runtimeFile, line) {
  const content = readFileSync(runtimeFile, 'utf8').replace(/\r\n/g, '\n');
  const lineOffsets = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\n') lineOffsets.push(index + 1);
  }
  if (!Number.isInteger(line) || line < 1 || line > lineOffsets.length) {
    throw new Error(`${runtimeFile} has no line ${line}.`);
  }
  const lineAt = (offset) => countNewlines(content, 0, offset) + 1;
  const analysis = analyzeSharedRuntime(root);
  if (analysis.diagnostics.length > 0) {
    throw new Error(
      'Cannot locate lines while the shared modules are invalid; run node scripts/runtime-shared.mjs --check.',
    );
  }

  const body = locateHandwrittenRuntimeBody(root);
  const bodyOffset = content.indexOf(body.text);
  if (bodyOffset >= 0) {
    const firstLine = lineAt(bodyOffset);
    const lastLine = firstLine + countNewlines(body.text, 0, body.text.length);
    if (line >= firstLine && line <= lastLine) {
      return `${RUNTIME_TEMPLATE_PATH}:${
        body.line + (line - firstLine)
      } (hand-written runtime)`;
    }
  }

  const sourceOffset =
    analysis.source === '' ? -1 : content.indexOf(analysis.source);
  if (sourceOffset >= 0) {
    const sourceFirstLine = lineAt(sourceOffset);
    let moduleStart = null;
    for (const entry of analysis.modules) {
      const bannerLine =
        sourceFirstLine + countNewlines(analysis.source, 0, entry.sourceOffset);
      const lastLine = bannerLine + entry.emittedLines;
      if (line >= bannerLine && line <= lastLine) {
        moduleStart = { entry, bannerLine };
        break;
      }
    }
    if (moduleStart) {
      const { entry, bannerLine } = moduleStart;
      if (line === bannerLine) return `${entry.path} (module banner)`;
      const emittedLine = line - bannerLine - 1;
      const chunk = entry.chunks.find(
        (candidate) =>
          emittedLine >= candidate.emittedLine &&
          emittedLine < candidate.emittedLine + candidate.lineCount,
      );
      if (!chunk) return `${entry.path} (statement separator)`;
      const transpiledLine =
        chunk.transpiledLine + (emittedLine - chunk.emittedLine);
      const originalLine = originalLineFor(entry, transpiledLine);
      return originalLine === null
        ? `${entry.path} (no source mapping for this line)`
        : `${entry.path}:${originalLine + 1}`;
    }
  }
  return `${runtimeFile}:${line} is in the runtime header or footer (${RUNTIME_TEMPLATE_PATH} renderRuntime)`;
}

function analyzeSharedRuntime(root) {
  const diagnostics = [];
  const report = (path, message) => diagnostics.push(`${path}: ${message}`);

  try {
    assertTypeScriptVersion(root);
  } catch (error) {
    report('package.json', error.message);
  }

  let body = null;
  try {
    body = locateHandwrittenRuntimeBody(root);
  } catch (error) {
    report(RUNTIME_TEMPLATE_PATH, error.message);
  }
  const handwritten = body ? collectHandwrittenDeclarations(body.text) : null;

  const listing = listSharedModules(root);
  for (const problem of listing.problems) report(SHARED_DIRECTORY, problem);

  const environment = listing.hasEnvironmentModule
    ? readEnvironmentProvided(root)
    : null;

  const parsed = listing.modules.map((name) =>
    parseSharedModule(root, name, report),
  );
  const byName = new Map(parsed.map((entry) => [entry.name, entry]));

  for (const entry of parsed) {
    for (const reference of entry.valueImports) {
      if (reference.module === ENVIRONMENT_PROVIDED_MODULE) {
        if (!environment) {
          report(
            entry.path,
            `imports ${reference.names.join(
              ', ',
            )} from ./failure-factory, but ${SHARED_DIRECTORY}/${ENVIRONMENT_PROVIDED_MODULE} does not exist.`,
          );
          continue;
        }
        for (const name of reference.names) {
          if (!environment.has(name)) {
            report(
              entry.path,
              `imports ${name} from ./failure-factory, which does not export it as a value.`,
            );
          }
        }
        continue;
      }
      const sibling = byName.get(reference.module);
      if (!sibling) {
        report(
          entry.path,
          `imports from ${reference.specifier}, which is not a shared module in ${SHARED_DIRECTORY}.`,
        );
        continue;
      }
      for (const name of reference.names) {
        if (!sibling.valueExports.has(name)) {
          report(
            entry.path,
            `imports ${name} from ${reference.specifier}, which does not export it as a function or const.`,
          );
        }
      }
    }
  }

  const ordered = orderModules(parsed, report);

  const topLevel = new Map();
  const signatures = new Map();
  const reservedNames = new Map();
  for (const [module, names] of Object.entries(RUNTIME_PLATFORM_IMPORTS)) {
    for (const name of names) {
      reservedNames.set(name, `a runtime header binding from ${module}`);
    }
  }
  for (const name of COMMONJS_WRAPPER_NAMES) {
    reservedNames.set(name, 'a CommonJS module-wrapper name');
  }
  for (const name of RESERVED_GLOBAL_NAMES) {
    if (!reservedNames.has(name)) {
      reservedNames.set(name, 'a reserved JavaScript or Node.js global');
    }
  }

  const modules = [];
  let source = '';
  for (const entry of ordered) {
    const transpiled = transpileSharedModule(entry, report);
    if (!transpiled) continue;
    for (const name of transpiled.topLevelNames) {
      const previous = topLevel.get(name);
      if (previous) {
        report(
          entry.path,
          previous === entry.path
            ? `declares top-level name \`${name}\` more than once.`
            : `Top-level name \`${name}\` is declared by both ${previous} and ${entry.path}; rename one.`,
        );
        continue;
      }
      topLevel.set(name, entry.path);
      const reason = reservedNames.get(name);
      if (reason) {
        report(
          entry.path,
          `declares top-level name \`${name}\`, which is ${reason}; rename it.`,
        );
      }
      if (handwritten?.names.has(name)) {
        report(
          entry.path,
          `Top-level name \`${name}\` is declared by both ${entry.path} and the hand-written runtime; delete the hand-written copy or rename one.`,
        );
      }
    }
    for (const [name, signature] of entry.signatures) {
      if (transpiled.topLevelNames.includes(name)) {
        signatures.set(name, signature);
      }
    }
    const banner = `// ---- ${entry.path} ----`;
    const block = `${banner}\n${transpiled.text}\n`;
    modules.push({
      path: entry.path,
      name: entry.name,
      text: entry.text,
      sourceOffset: source === '' ? 1 : source.length + 1,
      emittedLines: countNewlines(block, 0, block.length) - 1,
      chunks: transpiled.chunks,
    });
    source += `\n${block}`;
  }
  if (environment && handwritten) {
    for (const name of environment) {
      if (!handwritten.functions.has(name)) {
        report(
          `${SHARED_DIRECTORY}/${ENVIRONMENT_PROVIDED_MODULE}`,
          `exports ${name}, but the hand-written runtime does not declare a top-level function ${name}; shared code calls it as an environment-provided binding.`,
        );
      }
    }
  }

  if (source.includes('\r')) {
    report(
      SHARED_DIRECTORY,
      'the generated source contains a carriage return.',
    );
  }

  return {
    diagnostics,
    source,
    modules,
    topLevel,
    signatures,
    environmentProvided: environment
      ? [...environment].sort(compareCodeUnits)
      : [],
  };
}

function assertTypeScriptVersion(root) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const pinned = pkg.dependencies?.typescript;
  if (typeof pinned !== 'string' || !EXACT_VERSION.test(pinned)) {
    throw new Error(
      `dependencies.typescript must be an exact version so the generated runtime is reproducible; found ${JSON.stringify(
        pinned,
      )}.`,
    );
  }
  if (ts.version !== pinned) {
    throw new Error(
      `the installed TypeScript is ${ts.version}, but package.json pins ${pinned}; reinstall dependencies before generating the runtime.`,
    );
  }
}

function listSharedModules(root) {
  const directory = join(root, SHARED_DIRECTORY);
  const problems = [];
  const modules = [];
  let hasEnvironmentModule = false;
  if (!existsSync(directory))
    return { modules, problems, hasEnvironmentModule };
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      problems.push(
        `${entry.name} is a directory; the shared directory must stay flat.`,
      );
    } else if (!entry.isFile()) {
      problems.push(`${entry.name} is not a regular file.`);
    } else if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) {
      problems.push(
        `${entry.name} is not a TypeScript module; only .ts modules belong here.`,
      );
    } else if (entry.name === ENVIRONMENT_PROVIDED_MODULE) {
      hasEnvironmentModule = true;
    } else {
      modules.push(entry.name);
    }
  }
  modules.sort(compareCodeUnits);
  return { modules, problems, hasEnvironmentModule };
}

function readEnvironmentProvided(root) {
  const path = `${SHARED_DIRECTORY}/${ENVIRONMENT_PROVIDED_MODULE}`;
  const sourceFile = ts.createSourceFile(
    path,
    readFileSync(join(root, path), 'utf8'),
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const names = new Set();
  for (const statement of sourceFile.statements) {
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
        if (
          statement.exportClause &&
          ts.isNamedExports(statement.exportClause)
        ) {
          for (const element of statement.exportClause.elements) {
            if (!element.isTypeOnly) names.add(element.name.text);
          }
        }
      }
      continue;
    }
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      names.add(statement.name.text);
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      names.add(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        collectBindingNames(declaration.name, names);
      }
    }
  }
  return names;
}

function parseSharedModule(root, name, report) {
  const path = `${SHARED_DIRECTORY}/${name}`;
  // A checkout or an editor may turn LF into CRLF (Git for Windows defaults to
  // core.autocrlf=true). Normalizing here keeps the emitted runtime byte for
  // byte identical to an LF checkout, so builds and git installs still pass.
  const text = readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');
  const sourceFile = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const entry = {
    name,
    path,
    text,
    sourceFile,
    valueImports: [],
    importedValues: new Set(),
    valueExports: new Set(),
    signatures: new Map(),
    valid: true,
  };
  const fail = (node, message) => {
    entry.valid = false;
    const position = node
      ? sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      : null;
    report(position ? `${path}:${position.line + 1}` : path, message);
  };

  if (text.includes('\r')) {
    fail(
      null,
      'contains a carriage return that is not part of a CRLF line ending; shared modules must use LF.',
    );
  }
  const header = `${SHARED_MODULE_HEADER.join('\n')}\n`;
  if (!text.startsWith(header)) {
    fail(
      null,
      `must start with the comment:\n${SHARED_MODULE_HEADER.join('\n')}`,
    );
  }
  for (const diagnostic of sourceFile.parseDiagnostics ?? []) {
    fail(
      null,
      `does not parse: ${ts.flattenDiagnosticMessageText(
        diagnostic.messageText,
        ' ',
      )}`,
    );
  }

  const functionNames = new Set();
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      functionNames.add(statement.name.text);
    }
  }

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      validateImport(entry, statement, fail);
    }
  }

  const declaredConsts = new Set();
  for (const statement of sourceFile.statements) {
    validateTopLevelStatement(
      entry,
      statement,
      { functionNames, declaredConsts },
      fail,
    );
  }

  validateIdentifiersAndThrows(entry, fail);
  return entry;
}

function validateImport(entry, statement, fail) {
  const specifier = ts.isStringLiteral(statement.moduleSpecifier)
    ? statement.moduleSpecifier.text
    : null;
  const clause = statement.importClause;
  if (!clause) {
    fail(statement, `side-effect import of ${specifier} is not allowed.`);
    return;
  }
  if (clause.isTypeOnly) return;
  if (clause.name) {
    fail(
      statement,
      `default import from ${specifier} is not allowed; use named imports.`,
    );
  }
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) {
    fail(
      statement,
      `namespace import from ${specifier} is not allowed; use named imports.`,
    );
    return;
  }
  const valueElements = bindings
    ? bindings.elements.filter((element) => !element.isTypeOnly)
    : [];
  if (valueElements.length === 0) return;
  for (const element of valueElements) {
    if (element.propertyName) {
      fail(
        element,
        `renamed import ${element.propertyName.text} as ${element.name.text} is not allowed; shared code must use one name on both sides.`,
      );
    }
  }
  const names = valueElements.map((element) => element.name.text);
  for (const name of names) entry.importedValues.add(name);

  if (
    specifier !== null &&
    Object.hasOwn(RUNTIME_PLATFORM_IMPORTS, specifier)
  ) {
    const allowed = RUNTIME_PLATFORM_IMPORTS[specifier];
    for (const name of names) {
      if (!allowed.includes(name)) {
        fail(
          statement,
          `imports ${name} from ${specifier}, but the runtime header binds only ${allowed.join(
            ', ',
          )} from that module.`,
        );
      }
    }
    return;
  }
  const sibling =
    specifier === null ? null : SHARED_SIBLING_SPECIFIER.exec(specifier);
  if (!sibling) {
    fail(
      statement,
      `value import from ${specifier} is not allowed; shared modules import values only from sibling shared modules, ./failure-factory, or the runtime platform built-ins.`,
    );
    return;
  }
  entry.valueImports.push({
    specifier,
    module: `${sibling[1]}.ts`,
    names,
    node: statement,
  });
}

function validateTopLevelStatement(entry, statement, scope, fail) {
  if (hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) {
    fail(statement, '`declare` statements are not allowed.');
    return;
  }
  if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
    fail(statement, 'default exports are not allowed.');
    return;
  }
  const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
  if (ts.isImportDeclaration(statement)) return;
  if (
    ts.isTypeAliasDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement)
  ) {
    return;
  }
  if (ts.isFunctionDeclaration(statement)) {
    if (!statement.name) {
      fail(statement, 'function declarations must be named.');
      return;
    }
    const name = statement.name.text;
    if (exported && statement.body) entry.valueExports.add(name);
    recordSignature(entry, statement);
    return;
  }
  if (ts.isVariableStatement(statement)) {
    if (!isPlainConst(statement.declarationList)) {
      fail(
        statement,
        'only `const` declarations are allowed at the top level (no let, var, or using).',
      );
      return;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (!declaration.initializer) {
        fail(declaration, 'const declarations need an initializer.');
      } else {
        validateConstInitializer(declaration.initializer, scope, entry, fail);
      }
      const names = new Set();
      collectBindingNames(declaration.name, names);
      for (const name of names) {
        scope.declaredConsts.add(name);
        if (exported) entry.valueExports.add(name);
      }
    }
    return;
  }
  if (
    ts.isExportDeclaration(statement) ||
    ts.isExportAssignment(statement) ||
    ts.isImportEqualsDeclaration(statement)
  ) {
    fail(
      statement,
      'only `export function`, `export const`, `export type`, and `export interface` are allowed (no re-exports, export lists, export =, or import =).',
    );
    return;
  }
  if (ts.isClassDeclaration(statement)) {
    fail(
      statement,
      'classes are not allowed: lib/ and the runtime compile class fields differently.',
    );
    return;
  }
  if (ts.isEnumDeclaration(statement)) {
    fail(statement, 'enums are not allowed; use a const object.');
    return;
  }
  if (ts.isModuleDeclaration(statement)) {
    fail(statement, 'namespaces are not allowed.');
    return;
  }
  fail(
    statement,
    'executable top-level statements are not allowed; shared modules only declare types, functions, and side-effect-free consts.',
  );
}

function validateConstInitializer(expression, scope, entry, fail) {
  const check = (node) => {
    if (
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isParenthesizedExpression(node)
    ) {
      return check(node.expression);
    }
    if (
      ts.isStringLiteral(node) ||
      ts.isNumericLiteral(node) ||
      ts.isBigIntLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isRegularExpressionLiteral(node) ||
      node.kind === ts.SyntaxKind.TrueKeyword ||
      node.kind === ts.SyntaxKind.FalseKeyword ||
      node.kind === ts.SyntaxKind.NullKeyword
    ) {
      return true;
    }
    if (ts.isTemplateExpression(node)) {
      return node.templateSpans.every((span) => check(span.expression));
    }
    if (ts.isIdentifier(node)) {
      const name = node.text;
      return (
        name === 'undefined' ||
        name === 'NaN' ||
        name === 'Infinity' ||
        scope.declaredConsts.has(name) ||
        scope.functionNames.has(name) ||
        entry.importedValues.has(name)
      );
    }
    if (ts.isPrefixUnaryExpression(node)) {
      return UNARY_OPERATORS.has(node.operator) && check(node.operand);
    }
    if (ts.isBinaryExpression(node)) {
      return (
        ARITHMETIC_OPERATORS.has(node.operatorToken.kind) &&
        check(node.left) &&
        check(node.right)
      );
    }
    if (ts.isArrayLiteralExpression(node)) {
      return node.elements.every((element) =>
        ts.isSpreadElement(element)
          ? check(element.expression)
          : ts.isOmittedExpression(element) || check(element),
      );
    }
    if (ts.isObjectLiteralExpression(node)) {
      return node.properties.every((property) => {
        if (ts.isPropertyAssignment(property)) {
          return (
            (!ts.isComputedPropertyName(property.name) ||
              check(property.name.expression)) &&
            check(property.initializer)
          );
        }
        if (ts.isShorthandPropertyAssignment(property)) {
          return check(property.name);
        }
        if (ts.isSpreadAssignment(property)) {
          return check(property.expression);
        }
        return false;
      });
    }
    if (ts.isPropertyAccessExpression(node)) {
      return !ts.isPropertyAccessChain(node) && check(node.expression);
    }
    if (ts.isElementAccessExpression(node)) {
      return (
        (ts.isStringLiteral(node.argumentExpression) ||
          ts.isNumericLiteral(node.argumentExpression)) &&
        check(node.expression)
      );
    }
    if (ts.isNewExpression(node)) {
      return (
        ts.isIdentifier(node.expression) &&
        (node.expression.text === 'Set' || node.expression.text === 'Map') &&
        (node.arguments ?? []).every(check)
      );
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const allowedCallee =
        (ts.isIdentifier(callee) && callee.text === 'Symbol') ||
        (ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          callee.expression.text === 'Object' &&
          callee.name.text === 'freeze');
      return (
        allowedCallee && !node.questionDotToken && node.arguments.every(check)
      );
    }
    return false;
  };
  if (!check(expression)) {
    fail(
      expression,
      'const initializers must be side-effect free: literals, array or object literals, earlier consts, new Set(...), new Map(...), Symbol(...), or Object.freeze(...).',
    );
  }
}

function validateIdentifiersAndThrows(entry, fail) {
  const forbidden = new Set(FORBIDDEN_SHARED_IDENTIFIERS);
  const allowsSelfDescribingErrors = SELF_DESCRIBING_ERROR_MODULES.has(
    entry.name,
  );
  const visit = (node) => {
    if (
      ts.isIdentifier(node) &&
      forbidden.has(node.text) &&
      !isPropertyNamePosition(node)
    ) {
      fail(
        node,
        `must not reference \`${node.text}\`; shared code runs identically in the planner and the runtime.`,
      );
    }
    if (
      !allowsSelfDescribingErrors &&
      ts.isIdentifier(node) &&
      ERROR_CONSTRUCTOR_NAMES.has(node.text) &&
      !isPropertyNamePosition(node) &&
      !isInstanceofTarget(node) &&
      !isTypePosition(node)
    ) {
      fail(
        node,
        `must not create errors with \`${node.text}\`; shared code throws only sharedFailure(kind, message, details) or rethrows a caught error.`,
      );
    }
    if (
      ts.isMetaProperty(node) &&
      node.keywordToken === ts.SyntaxKind.ImportKeyword
    ) {
      fail(node, 'must not use import.meta.');
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      fail(node, 'must not use dynamic import().');
    }
    if (
      (ts.isAwaitExpression(node) ||
        (ts.isForOfStatement(node) && node.awaitModifier)) &&
      isTopLevelAwait(node)
    ) {
      fail(node, 'top-level await is not allowed.');
    }
    if (ts.isThrowStatement(node) && !allowsSelfDescribingErrors) {
      const thrown = unwrapExpression(node.expression);
      const isSharedFailure =
        ts.isCallExpression(thrown) &&
        ts.isIdentifier(thrown.expression) &&
        thrown.expression.text === 'sharedFailure';
      if (!isSharedFailure && !ts.isIdentifier(thrown)) {
        fail(
          node,
          'shared code throws only sharedFailure(kind, message, details) or rethrows a caught error.',
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(entry.sourceFile);
}

function isTopLevelAwait(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) return false;
  }
  return true;
}

function unwrapExpression(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isInstanceofTarget(node) {
  const parent = node.parent;
  return (
    !!parent &&
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
    parent.right === node
  );
}

function isTypePosition(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isTypeNode(current) || ts.isHeritageClause(current)) return true;
    if (ts.isStatement(current) || ts.isExpression(current)) return false;
  }
  return false;
}

function isPropertyNamePosition(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (
    (ts.isPropertyAccessExpression(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isEnumMember(parent)) &&
    parent.name === node
  ) {
    return true;
  }
  if (ts.isQualifiedName(parent) && parent.right === node) return true;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return true;
  return false;
}

function recordSignature(entry, declaration) {
  const name = declaration.name.text;
  const parameters = declaration.parameters.filter(
    (parameter) =>
      !(ts.isIdentifier(parameter.name) && parameter.name.text === 'this'),
  );
  let minimum = 0;
  let maximum = 0;
  for (const parameter of parameters) {
    if (parameter.dotDotDotToken) {
      maximum = Number.POSITIVE_INFINITY;
      continue;
    }
    maximum += 1;
    if (!parameter.questionToken && !parameter.initializer) {
      minimum = maximum;
    }
  }
  const previous = entry.signatures.get(name);
  const overloads = previous?.overloads ?? [];
  if (!declaration.body) overloads.push({ minimum, maximum });
  const effective =
    overloads.length > 0
      ? {
          minimum: Math.min(...overloads.map((overload) => overload.minimum)),
          maximum: Math.max(...overloads.map((overload) => overload.maximum)),
        }
      : { minimum, maximum };
  entry.signatures.set(name, { ...effective, overloads });
}

function orderModules(parsed, report) {
  const byName = new Map(parsed.map((entry) => [entry.name, entry]));
  const dependencies = new Map();
  const dependents = new Map(parsed.map((entry) => [entry.name, []]));
  for (const entry of parsed) {
    const needs = new Set();
    for (const reference of entry.valueImports) {
      if (reference.module === entry.name) {
        report(entry.path, 'imports itself.');
      } else if (byName.has(reference.module)) {
        needs.add(reference.module);
      }
    }
    dependencies.set(entry.name, needs);
    for (const name of needs) dependents.get(name).push(entry.name);
  }
  const remaining = new Map(
    parsed.map((entry) => [entry.name, dependencies.get(entry.name).size]),
  );
  const ready = parsed
    .filter((entry) => remaining.get(entry.name) === 0)
    .map((entry) => entry.name);
  const ordered = [];
  while (ready.length > 0) {
    ready.sort(compareCodeUnits);
    const name = ready.shift();
    ordered.push(byName.get(name));
    for (const dependent of dependents.get(name)) {
      const count = remaining.get(dependent) - 1;
      remaining.set(dependent, count);
      if (count === 0) ready.push(dependent);
    }
  }
  if (ordered.length !== parsed.length) {
    const cyclic = parsed
      .filter((entry) => !ordered.includes(entry))
      .map((entry) => entry.path)
      .sort(compareCodeUnits);
    report(
      SHARED_DIRECTORY,
      `shared modules form an import cycle: ${cyclic.join(', ')}.`,
    );
  }
  return ordered;
}

function transpileOptions(sourceMap) {
  return {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    removeComments: false,
    newLine: ts.NewLineKind.LineFeed,
    isolatedModules: true,
    verbatimModuleSyntax: false,
    noEmitHelpers: true,
    importHelpers: false,
    sourceMap,
    inlineSourceMap: false,
    inlineSources: false,
  };
}

function runTranspile(entry, sourceMap) {
  return ts.transpileModule(entry.text, {
    fileName: entry.path,
    reportDiagnostics: true,
    compilerOptions: transpileOptions(sourceMap),
    transformers: { after: [stripModuleSyntax] },
  });
}

/** Remove module syntax so each module's statements share one script scope. */
function stripModuleSyntax(context) {
  const { factory } = context;
  return (sourceFile) => {
    const statements = [];
    for (const statement of sourceFile.statements) {
      if (
        ts.isImportDeclaration(statement) ||
        ts.isImportEqualsDeclaration(statement) ||
        ts.isExportDeclaration(statement) ||
        ts.isExportAssignment(statement)
      ) {
        continue;
      }
      const modifiers = ts.canHaveModifiers(statement)
        ? ts.getModifiers(statement)
        : undefined;
      const exported = modifiers?.some(
        (modifier) =>
          modifier.kind === ts.SyntaxKind.ExportKeyword ||
          modifier.kind === ts.SyntaxKind.DefaultKeyword,
      );
      if (!exported) {
        statements.push(statement);
        continue;
      }
      const kept = modifiers.filter(
        (modifier) =>
          modifier.kind !== ts.SyntaxKind.ExportKeyword &&
          modifier.kind !== ts.SyntaxKind.DefaultKeyword,
      );
      const nextModifiers = kept.length > 0 ? kept : undefined;
      if (ts.isFunctionDeclaration(statement)) {
        statements.push(
          factory.updateFunctionDeclaration(
            statement,
            nextModifiers,
            statement.asteriskToken,
            statement.name,
            statement.typeParameters,
            statement.parameters,
            statement.type,
            statement.body,
          ),
        );
      } else if (ts.isVariableStatement(statement)) {
        statements.push(
          factory.updateVariableStatement(
            statement,
            nextModifiers,
            statement.declarationList,
          ),
        );
      } else {
        throw new Error(
          `${sourceFile.fileName}: cannot strip the export from a ${
            ts.SyntaxKind[statement.kind]
          }.`,
        );
      }
    }
    return factory.updateSourceFile(sourceFile, statements);
  };
}

function transpileSharedModule(entry, report) {
  if (!entry.valid) return null;
  let output;
  try {
    output = runTranspile(entry, false);
  } catch (error) {
    report(entry.path, error.message);
    return null;
  }
  for (const diagnostic of output.diagnostics ?? []) {
    report(
      entry.path,
      `transpile error: ${ts.flattenDiagnosticMessageText(
        diagnostic.messageText,
        ' ',
      )}`,
    );
  }
  const text = output.outputText;
  const javascript = ts.createSourceFile(
    entry.path.replace(/\.ts$/, '.js'),
    text,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS,
  );
  let valid = true;
  const fail = (message) => {
    valid = false;
    report(entry.path, `transpiled output ${message}`);
  };
  if (text.includes('\r')) fail('contains a carriage return.');
  const first = javascript.statements[0];
  if (
    first &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === 'use strict'
  ) {
    fail('contains a "use strict" directive.');
  }
  const visit = (node) => {
    if (
      ts.isImportDeclaration(node) ||
      ts.isImportEqualsDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      ts.isExportAssignment(node) ||
      hasModifier(node, ts.SyntaxKind.ExportKeyword)
    ) {
      fail('still contains import or export syntax.');
    }
    if (
      ts.isIdentifier(node) &&
      node.text === 'require' &&
      !isPropertyNamePosition(node)
    ) {
      fail('references `require`.');
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      fail('contains a dynamic import().');
    }
    if (
      ts.isMetaProperty(node) &&
      node.keywordToken === ts.SyntaxKind.ImportKeyword
    ) {
      fail('contains import.meta.');
    }
    ts.forEachChild(node, visit);
  };
  visit(javascript);

  const topLevelNames = [];
  for (const statement of javascript.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      topLevelNames.push(statement.name.text);
    } else if (
      ts.isVariableStatement(statement) &&
      isPlainConst(statement.declarationList)
    ) {
      const names = new Set();
      for (const declaration of statement.declarationList.declarations) {
        collectBindingNames(declaration.name, names);
      }
      topLevelNames.push(...names);
    } else {
      fail(
        `contains a top-level ${
          ts.SyntaxKind[statement.kind]
        }; only functions and consts may be emitted.`,
      );
    }
  }
  if (!valid) return null;

  // One blank line between top-level statements; each statement keeps its
  // leading comments. The module banner replaces the contract header.
  const header = `${SHARED_MODULE_HEADER.join('\n')}\n`;
  const chunks = [];
  const texts = [];
  let emittedLine = 0;
  for (const statement of javascript.statements) {
    let start = statement.getFullStart();
    let chunk = text.slice(start, statement.getEnd());
    const leading = /^(?:[ \t]*\n)+/.exec(chunk);
    if (leading) {
      start += leading[0].length;
      chunk = chunk.slice(leading[0].length);
    }
    if (texts.length === 0 && chunk.startsWith(header)) {
      start += header.length;
      chunk = chunk.slice(header.length);
      const blank = /^(?:[ \t]*\n)+/.exec(chunk);
      if (blank) {
        start += blank[0].length;
        chunk = chunk.slice(blank[0].length);
      }
    }
    const lineCount = countNewlines(chunk, 0, chunk.length) + 1;
    chunks.push({
      emittedLine,
      transpiledLine: countNewlines(text, 0, start),
      lineCount,
    });
    texts.push(chunk);
    emittedLine += lineCount + 1;
  }
  return { text: texts.join('\n\n'), topLevelNames, chunks };
}

function originalLineFor(entry, transpiledLine) {
  const output = runTranspile(entry, true);
  const map = JSON.parse(output.sourceMapText);
  const lines = map.mappings.split(';');
  const state = { sourceIndex: 0, sourceLine: 0, sourceColumn: 0 };
  for (let line = 0; line < lines.length; line += 1) {
    let firstOriginal = null;
    for (const segment of lines[line].split(',')) {
      if (segment === '') continue;
      const values = decodeVlq(segment);
      if (values.length >= 4) {
        state.sourceIndex += values[1];
        state.sourceLine += values[2];
        state.sourceColumn += values[3];
        if (firstOriginal === null) firstOriginal = state.sourceLine;
      }
    }
    if (line === transpiledLine) return firstOriginal;
  }
  return null;
}

function decodeVlq(segment) {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const values = [];
  let value = 0;
  let shift = 0;
  for (const character of segment) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error(`Invalid source map segment ${segment}.`);
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
    } else {
      values.push(value & 1 ? -(value >> 1) : value >> 1);
      value = 0;
      shift = 0;
    }
  }
  return values;
}

function locateHandwrittenRuntimeBody(root) {
  const text = readFileSync(join(root, RUNTIME_TEMPLATE_PATH), 'utf8');
  const sourceFile = ts.createSourceFile(
    RUNTIME_TEMPLATE_PATH,
    text,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const matches = [];
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === HANDWRITTEN_RUNTIME_BODY_NAME
    ) {
      matches.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one ${HANDWRITTEN_RUNTIME_BODY_NAME} declaration, found ${matches.length}.`,
    );
  }
  const [declaration] = matches;
  const list = declaration.parent;
  const initializer = declaration.initializer;
  if (
    !ts.isVariableDeclarationList(list) ||
    !isPlainConst(list) ||
    !ts.isVariableStatement(list.parent) ||
    list.parent.parent !== sourceFile ||
    !initializer ||
    !ts.isTaggedTemplateExpression(initializer) ||
    initializer.tag.getText(sourceFile) !== 'String.raw' ||
    !ts.isNoSubstitutionTemplateLiteral(initializer.template) ||
    typeof initializer.template.rawText !== 'string'
  ) {
    throw new Error(
      `${HANDWRITTEN_RUNTIME_BODY_NAME} must be a top-level const initialized with a String.raw template without substitutions.`,
    );
  }
  const templateStart = initializer.template.getStart(sourceFile);
  return {
    text: initializer.template.rawText,
    // The raw text starts right after the opening backtick.
    line: sourceFile.getLineAndCharacterOfPosition(templateStart).line + 1,
  };
}

function collectHandwrittenDeclarations(body) {
  const sourceFile = ts.createSourceFile(
    'handwritten-runtime.js',
    body,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS,
  );
  const names = new Set();
  const functions = new Set();
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      names.add(statement.name.text);
      functions.add(statement.name.text);
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      names.add(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        collectBindingNames(declaration.name, names);
      }
    }
  }
  return { names, functions };
}

function collectBindingNames(name, output) {
  if (ts.isIdentifier(name)) {
    output.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    collectBindingNames(element.name, output);
  }
}

/** `const`, not let, var, using, or await using. */
function isPlainConst(declarationList) {
  return (
    (declarationList.flags & ts.NodeFlags.BlockScoped) === ts.NodeFlags.Const
  );
}

function hasModifier(node, kind) {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind)
  );
}

function countNewlines(text, start, end) {
  let count = 0;
  for (let index = start; index < end; index += 1) {
    if (text.charCodeAt(index) === 10) count += 1;
  }
  return count;
}

/** Escape text so a cooked template literal evaluates back to it exactly. */
export function escapeTemplateText(text) {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
}

function usage() {
  return [
    'Usage: node scripts/runtime-shared.mjs [--check | --write | --locate <runtime-file>:<line>]',
    '',
    '  --check   Fail when the generated module is out of date (default).',
    '  --write   Regenerate src/content-diff/generated/runtime-shared.ts.',
    '  --locate  Map a line of an emitted runtime file to its source line.',
  ].join('\n');
}

function main(argv) {
  const [mode = '--check', argument, ...extra] = argv;
  if (mode === '--help' || mode === '-h') {
    console.log(usage());
    return 0;
  }
  if (
    extra.length > 0 ||
    (mode === '--locate' ? argument === undefined : argument !== undefined) ||
    !['--check', '--write', '--locate'].includes(mode)
  ) {
    console.error(usage());
    return 2;
  }
  try {
    if (mode === '--locate') {
      const match = /^(.*):(\d+)$/.exec(argument);
      if (!match) {
        console.error(usage());
        return 2;
      }
      console.log(
        locateRuntimeLine(PACKAGE_ROOT, resolve(match[1]), Number(match[2])),
      );
      return 0;
    }
    if (mode === '--write') {
      writeGeneratedModule(PACKAGE_ROOT);
      return 0;
    }
    if (!isGeneratedModuleCurrent(PACKAGE_ROOT)) {
      console.error(OUT_OF_DATE_MESSAGE);
      return 1;
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (
  process.argv[1] &&
  realpathSync(resolve(process.argv[1])) ===
    realpathSync(fileURLToPath(import.meta.url))
) {
  process.exitCode = main(process.argv.slice(2));
}
