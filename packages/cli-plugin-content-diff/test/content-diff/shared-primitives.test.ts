import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect } from 'chai';
import {
  canonicalizeJson,
  isPortableDatoId,
  semanticHash,
  stableStringify,
} from '../../src/content-diff/canonicalize';
import { prettyStableStringify } from '../../src/content-diff/legacy-ids';
import { renderRuntime } from '../../src/content-diff/runtime-template';
import { fetchSchemaSnapshot } from '../../src/content-diff/schema';
import { mapWithConcurrency } from '../../src/content-diff/shared/concurrency';
import { isCanonicalLegacyDatoId } from '../../src/content-diff/shared/ids';
import {
  canonicalPrettyStringify,
  isObject,
  sha256,
  utf8ByteLength,
} from '../../src/content-diff/shared/json';
import {
  compareNullable,
  compareStrings,
} from '../../src/content-diff/shared/ordering';
import { ContentDiffError } from '../../src/content-diff/types';

type RuntimeError = Error & { code: string; details: unknown };

interface RuntimePrimitives {
  __canonicalizeJson(value: unknown): unknown;
  __isCanonicalLegacyDatoId(value: unknown): boolean;
  __isPortableDatoId(value: string): boolean;
  __compareNullable(left: unknown, right: unknown): number;
  __mapWithConcurrency<Input, Output>(
    values: readonly Input[],
    concurrency: number,
    mapper: (value: Input, index: number) => Promise<Output>,
  ): Promise<Output[]>;
}

const ROOT = resolve(__dirname, '../..');

describe('shared runtime primitives', () => {
  const temporaryDirectories: string[] = [];
  let runtime: RuntimePrimitives;

  before(async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'datocms-shared-primitives-'),
    );
    temporaryDirectories.push(directory);
    const path = join(directory, 'runtime.cjs');
    await writeFile(
      path,
      [
        renderRuntime('js'),
        'module.exports.__canonicalizeJson = canonicalizeJson;',
        'module.exports.__isCanonicalLegacyDatoId = isCanonicalLegacyDatoId;',
        'module.exports.__isPortableDatoId = isPortableDatoId;',
        'module.exports.__compareNullable = compareNullable;',
        'module.exports.__mapWithConcurrency = mapWithConcurrency;',
        '',
      ].join('\n'),
    );
    runtime = createRequire(join(directory, 'loader.cjs'))(
      path,
    ) as RuntimePrimitives;
  });

  after(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  function runtimeFailure(operation: () => unknown): RuntimeError {
    try {
      operation();
    } catch (error) {
      return error as RuntimeError;
    }
    throw new Error('Expected the runtime operation to throw.');
  }

  it('rejects non-finite numbers with one message and each side keeping its code (D1)', () => {
    for (const value of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      { a: [1, Number.NEGATIVE_INFINITY] },
    ]) {
      let planner: unknown;
      try {
        canonicalizeJson(value);
      } catch (error) {
        planner = error;
      }
      expect(planner).to.be.instanceOf(ContentDiffError);
      expect((planner as ContentDiffError).code).to.equal(
        'UNSUPPORTED_CONTENT_STATE',
      );
      expect((planner as ContentDiffError).message).to.equal(
        'Content contains a non-finite numeric value.',
      );

      const executed = runtimeFailure(() => runtime.__canonicalizeJson(value));
      expect(executed.name).to.equal('ContentDiffRuntimeError');
      expect(executed.code).to.equal('INVALID_JSON');
      expect(executed.message).to.equal(
        'Content contains a non-finite numeric value.',
      );
      expect(executed.details).to.equal(null);
    }

    for (const [value, type] of [
      [BigInt(10), 'bigint'],
      [() => 1, 'function'],
      [Symbol('s'), 'symbol'],
      [undefined, 'undefined'],
    ] as const) {
      const message = `Content contains a non-JSON value (${type}).`;
      expect(() => canonicalizeJson(value)).to.throw(ContentDiffError, message);
      const executed = runtimeFailure(() => runtime.__canonicalizeJson(value));
      expect(executed.code).to.equal('INVALID_JSON');
      expect(executed.message).to.equal(message);
    }
  });

  it('canonicalizes JSON identically in the planner and the runtime', () => {
    const input = {
      b: [3, -0, { z: null, a: undefined, B: 'x' }],
      a: true,
      é: 'accent',
      Z: { y: 1, x: [] },
      _: '',
    };
    const expected = {
      Z: { x: [], y: 1 },
      _: '',
      a: true,
      b: [3, 0, { B: 'x', z: null }],
      é: 'accent',
    };
    expect(canonicalizeJson(input)).to.deep.equal(expected);
    expect(runtime.__canonicalizeJson(input)).to.deep.equal(expected);
    expect(Object.keys(canonicalizeJson(input) as object)).to.deep.equal([
      'Z',
      '_',
      'a',
      'b',
      'é',
    ]);
    expect(stableStringify(input)).to.equal(JSON.stringify(expected));
    expect(semanticHash(input)).to.equal(sha256(JSON.stringify(expected)));
    expect(sha256(Buffer.from('abc'))).to.equal(sha256('abc'));
    expect(prettyStableStringify).to.equal(canonicalPrettyStringify);
    expect(canonicalPrettyStringify({ b: 1, a: [2] })).to.equal(
      '{\n  "a": [\n    2\n  ],\n  "b": 1\n}',
    );
    expect(utf8ByteLength('é€')).to.equal(5);
    expect(isObject({})).to.equal(true);
    expect(isObject([])).to.equal(false);
    expect(isObject(null)).to.equal(false);
  });

  it('agrees on canonical legacy and portable DatoCMS IDs', () => {
    const legacy: Array<[unknown, boolean]> = [
      ['0', true],
      ['1', true],
      ['281474976710655', true],
      ['281474976710656', false],
      ['999999999999999', false],
      ['1000000000000000', false],
      ['01', false],
      ['-1', false],
      ['+1', false],
      ['1.0', false],
      [' 1', false],
      ['', false],
      [12, false],
      [null, false],
      [undefined, false],
    ];
    for (const [value, expected] of legacy) {
      expect(isCanonicalLegacyDatoId(value), String(value)).to.equal(expected);
      expect(runtime.__isCanonicalLegacyDatoId(value), String(value)).to.equal(
        expected,
      );
    }

    const portable: Array<[string, boolean]> = [
      ['LQQiCYCfSU6DTmCQ63-JRw', true],
      ['LQQiCYCfSU6DTmCQ63-JRw==', false],
      ['LQQiCYCfSU6DTmCQ63+JRw', false],
      ['123', false],
      ['', false],
    ];
    for (const [value, expected] of portable) {
      expect(isPortableDatoId(value), value).to.equal(expected);
      expect(runtime.__isPortableDatoId(value), value).to.equal(expected);
    }
  });

  it('orders strings by code unit and missing values first on both sides', () => {
    expect(['b', 'B', 'a', 'é', '_'].sort(compareStrings)).to.deep.equal([
      'B',
      '_',
      'a',
      'b',
      'é',
    ]);
    const cases: Array<[string | null | undefined, string | null | undefined]> =
      [
        [null, null],
        [null, undefined],
        [undefined, 'a'],
        ['a', null],
        ['a', 'b'],
        ['b', 'a'],
        ['a', 'a'],
      ];
    for (const [left, right] of cases) {
      expect(runtime.__compareNullable(left, right)).to.equal(
        compareNullable(left, right),
      );
    }
    expect(compareNullable(null, 'a')).to.equal(-1);
    expect(compareNullable('a', undefined)).to.equal(1);
    expect(compareNullable(null, undefined)).to.equal(-1);
  });

  describe('mapWithConcurrency (D19)', () => {
    for (const side of ['planner', 'runtime'] as const) {
      const map = <Input, Output>(
        values: readonly Input[],
        concurrency: number,
        mapper: (value: Input, index: number) => Promise<Output>,
      ): Promise<Output[]> =>
        side === 'planner'
          ? mapWithConcurrency(values, concurrency, mapper)
          : runtime.__mapWithConcurrency(values, concurrency, mapper);

      it(`keeps input order under bounded concurrency (${side})`, async () => {
        let active = 0;
        let peak = 0;
        const result = await map([5, 1, 4, 2, 3], 2, async (value, index) => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise<void>((done) => setTimeout(done, value));
          active -= 1;
          return `${index}:${value}`;
        });
        expect(result).to.deep.equal(['0:5', '1:1', '2:4', '3:2', '4:3']);
        expect(peak).to.equal(2);
        expect(await map([], 3, async () => 1)).to.deep.equal([]);
      });

      it(`starts no queued work after the first failure and drains active work (${side})`, async () => {
        let releaseActive!: () => void;
        const active = new Promise<void>((done) => {
          releaseActive = done;
        });
        const started: number[] = [];
        const completed: number[] = [];
        const first = new Error('first');
        let settled = false;
        const operation = map([0, 1, 2, 3, 4, 5], 3, async (value) => {
          started.push(value);
          if (value === 0) throw first;
          if (value === 1) {
            await Promise.resolve();
            throw new Error('second');
          }
          await active;
          completed.push(value);
          return value;
        }).then(
          () => {
            settled = true;
            return null;
          },
          (error: unknown) => {
            settled = true;
            return error;
          },
        );

        await new Promise<void>((done) => setImmediate(done));
        const settledWhileActive = settled;
        releaseActive();

        expect(await operation).to.equal(first);
        expect(settledWhileActive).to.equal(false);
        expect(started).to.deep.equal([0, 1, 2]);
        expect(completed).to.deep.equal([2]);
      });
    }

    it('makes schema capture stop scheduling field requests after a failure', async () => {
      const itemTypes = Array.from({ length: 8 }, (_, index) => ({
        id: `model-${index}`,
      }));
      let releaseActive!: () => void;
      const active = new Promise<void>((done) => {
        releaseActive = done;
      });
      const requested: string[] = [];
      const failure = new Error('fields unavailable');
      const client = {
        site: { find: async () => ({ id: 'site' }) },
        itemTypes: { list: async () => itemTypes },
        workflows: { list: async () => [] },
        fields: {
          list: async (itemTypeId: string) => {
            requested.push(itemTypeId);
            if (itemTypeId === 'model-0') throw failure;
            await active;
            return [];
          },
        },
      };
      let settled = false;
      const operation = fetchSchemaSnapshot(
        client as unknown as Parameters<typeof fetchSchemaSnapshot>[0],
        'main',
      ).then(
        () => {
          settled = true;
          return null;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );

      await new Promise<void>((done) => setImmediate(done));
      const settledWhileActive = settled;
      releaseActive();

      expect(await operation).to.equal(failure);
      expect(settledWhileActive).to.equal(false);
      expect(requested).to.deep.equal([
        'model-0',
        'model-1',
        'model-2',
        'model-3',
        'model-4',
      ]);
    });

    it('leaves no private concurrency helper in the planner modules', async () => {
      const directory = join(ROOT, 'src/content-diff');
      const offenders: string[] = [];
      for (const name of await readdir(directory)) {
        if (!name.endsWith('.ts')) continue;
        const text = await readFile(join(directory, name), 'utf8');
        if (/function mapWithConcurrency\b/.test(text)) offenders.push(name);
      }
      expect(offenders).to.deep.equal([]);
    });
  });
});
