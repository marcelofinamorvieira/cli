import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'chai';
import { GENERATED_RUNTIME_SHARED_MODULES } from '../../src/content-diff/generated/runtime-shared';
import { renderRuntime } from '../../src/content-diff/runtime-template';
import { semanticHash } from '../../src/content-diff/shared/json';
import {
  uploadCollectionOrderContractError,
  uploadCollectionPlanContractError,
} from '../../src/content-diff/shared/upload-collection-contract';
import {
  expectedUploadPlanChanges,
  isPlainJsonObject,
  isUploadRequestFilenameFixedPoint,
  uploadBasenameFromFilename,
  uploadFilenameExtension,
  uploadPlanContractError,
  uploadStagingFilename,
} from '../../src/content-diff/shared/upload-contract';
import {
  ContentDiffError,
  type ContentDiffPlan,
  type UploadCollectionPlan,
  type UploadCollectionSnapshot,
  type UploadPlan,
  type UploadSnapshot,
} from '../../src/content-diff/types';

type RuntimeError = Error & { code: string; details: unknown };

interface RuntimeUploadContracts {
  __uploadFilenameExtension(filename: unknown): string;
  __uploadBasenameFromFilename(filename: unknown): string;
  __isUploadRequestFilenameFixedPoint(filename: unknown): boolean;
  __uploadStagingFilename(id: unknown): string;
  __expectedUploadPlanChanges(upload: unknown): UploadPlan['changes'] | null;
  __uploadPlanContractError(upload: unknown, schema: unknown): string | null;
  __uploadConsistencyContractError(value: unknown): string | null;
  __uploadDefaultFieldMetadataContractError(
    value: unknown,
    schema: unknown,
    snapshot: unknown,
    requireWritable: boolean,
  ): string | null;
  __uploadCollectionPlanContractError(plan: unknown): string | null;
  __uploadCollectionOrderContractError(
    plans: unknown,
    collectionOrder: unknown,
  ): string | null;
  __uploadNeedsBinaryTransfer(live: unknown, desired: unknown): boolean;
}

const COLLECTION_ID = 'LQQiCYCfSU6DTmCQ63-JRw';

function collectionSnapshot(label: string): UploadCollectionSnapshot {
  const state = { id: COLLECTION_ID, label, parentId: null, position: 1 };
  return { ...state, hash: semanticHash(state) };
}

function createCollectionPlan(
  desired: UploadCollectionSnapshot,
): UploadCollectionPlan {
  return {
    id: COLLECTION_ID,
    action: 'create',
    expectedTargetHash: null,
    baseline: null,
    desired,
  };
}

const UPLOAD_ID = 'QtiP3aRYQhK9jRVGDL6kPg';

const FIELD_KEYED_SCHEMA = {
  locales: ['en'],
  environmentSemantics: { nonLocalizedFocalPoints: true },
} as unknown as ContentDiffPlan['schema'];

const LEGACY_SCHEMA = {
  locales: ['en'],
  environmentSemantics: { nonLocalizedFocalPoints: false },
} as unknown as ContentDiffPlan['schema'];

function withInheritedPrototype<T extends object>(value: T): T {
  return Object.assign(Object.create({ inherited: true }) as T, value);
}

function refreshUploadHash(upload: UploadPlan): UploadPlan {
  const desired = upload.desired!;
  desired.hash = semanticHash({
    id: desired.id,
    md5: desired.md5,
    basename: desired.basename,
    filename: desired.filename,
    manual: desired.manual,
  });
  return upload;
}

function uploadCreatePlan(
  defaultFieldMetadata: unknown = {
    alt: { en: null },
    title: { en: null },
    custom_data: { en: {} },
    focal_point: null,
    poster_time: null,
  },
): UploadPlan {
  return refreshUploadHash({
    id: UPLOAD_ID,
    action: 'create',
    expectedTargetHash: null,
    baseline: null,
    desired: {
      id: UPLOAD_ID,
      md5: '900150983cd24fb0d6963f7d28e17f72',
      basename: 'asset',
      filename: 'asset.txt',
      hash: '',
      size: 3,
      mimeType: 'text/plain',
      transport: {
        sourceUrl: 'https://example.test/asset.txt',
        bundledPath: null,
        sha256: null,
      },
      consistency: { antivirusStatus: 'clean', updatedAt: null },
      manual: {
        author: null,
        collectionId: null,
        copyright: null,
        defaultFieldMetadata,
        notes: null,
        tags: [],
      },
    },
    changes: { binary: true, metadata: true, collection: true },
  } as unknown as UploadPlan);
}

describe('shared upload and upload-collection contracts', () => {
  const temporaryDirectories: string[] = [];
  let runtime: RuntimeUploadContracts;

  before(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'datocms-shared-uploads-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'runtime.cjs');
    await writeFile(
      path,
      [
        renderRuntime('js'),
        'module.exports.__uploadFilenameExtension = uploadFilenameExtension;',
        'module.exports.__uploadBasenameFromFilename = uploadBasenameFromFilename;',
        'module.exports.__isUploadRequestFilenameFixedPoint = isUploadRequestFilenameFixedPoint;',
        'module.exports.__uploadStagingFilename = uploadStagingFilename;',
        'module.exports.__expectedUploadPlanChanges = expectedUploadPlanChanges;',
        'module.exports.__uploadPlanContractError = uploadPlanContractError;',
        'module.exports.__uploadConsistencyContractError = uploadConsistencyContractError;',
        'module.exports.__uploadDefaultFieldMetadataContractError = uploadDefaultFieldMetadataContractError;',
        'module.exports.__uploadCollectionPlanContractError = uploadCollectionPlanContractError;',
        'module.exports.__uploadCollectionOrderContractError = uploadCollectionOrderContractError;',
        'module.exports.__uploadNeedsBinaryTransfer = uploadNeedsBinaryTransfer;',
        '',
      ].join('\n'),
    );
    runtime = createRequire(join(directory, 'loader.cjs'))(
      path,
    ) as RuntimeUploadContracts;
  });

  after(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it('is the upload contract code the generated runtime runs', () => {
    expect(GENERATED_RUNTIME_SHARED_MODULES).to.include.members([
      'src/content-diff/shared/upload-contract.ts',
      'src/content-diff/shared/upload-collection-contract.ts',
    ]);
  });

  it('reads missing and non-string filenames as empty in the planner and the runtime (D24)', () => {
    const table: Array<[unknown, string, string]> = [
      [undefined, '', ''],
      [null, '', ''],
      ['', '', ''],
      ['photo.JPG', '.JPG', 'photo'],
      ['archive.tar.gz', '.gz', 'archive.tar'],
      ['.hidden', '', '.hidden'],
      ['name.', '.', 'name'],
      ['dir.d/file', '', 'file'],
      ['C:\\images\\cover.png', '.png', 'cover'],
      [42, '', '42'],
    ];
    for (const [filename, extension, basename] of table) {
      const label = String(filename);
      expect(uploadFilenameExtension(filename), label).to.equal(extension);
      expect(runtime.__uploadFilenameExtension(filename), label).to.equal(
        extension,
      );
      expect(uploadBasenameFromFilename(filename), label).to.equal(basename);
      expect(runtime.__uploadBasenameFromFilename(filename), label).to.equal(
        basename,
      );
    }

    for (const [filename, expected] of [
      [undefined, false],
      [null, false],
      [42, false],
      [{ filename: 'photo.jpg' }, false],
      ['', false],
      ['photo.jpg', true],
      ['Photo.jpg', false],
      ['my-photo_1.webp', true],
      ['dir/photo.jpg', false],
    ] as Array<[unknown, boolean]>) {
      expect(
        isUploadRequestFilenameFixedPoint(filename),
        String(filename),
      ).to.equal(expected);
      expect(
        runtime.__isUploadRequestFilenameFixedPoint(filename),
        String(filename),
      ).to.equal(expected);
    }
  });

  it('reports a missing upload or collection plan entry as an invalid action (D24)', () => {
    const schema = {} as ContentDiffPlan['schema'];
    for (const entry of [null, undefined]) {
      expect(
        uploadPlanContractError(entry as unknown as UploadPlan, schema),
      ).to.equal('action is invalid');
      expect(runtime.__uploadPlanContractError(entry, schema)).to.equal(
        'action is invalid',
      );
      expect(
        uploadCollectionPlanContractError(
          entry as unknown as UploadCollectionPlan,
        ),
      ).to.equal('action is invalid');
      expect(runtime.__uploadCollectionPlanContractError(entry)).to.equal(
        'action is invalid',
      );
    }
  });

  it('keys collection labels and metadata locales the same way on both sides (D39)', () => {
    const occupantId = 'occupant';
    const occupant = { ...collectionSnapshot('Covers'), id: occupantId };
    const plans = [
      {
        id: occupantId,
        action: 'noop',
        expectedTargetHash: occupant.hash,
        baseline: occupant,
        desired: occupant,
      },
      createCollectionPlan(collectionSnapshot('Covers')),
    ] as UploadCollectionPlan[];
    const collision = `collection ${COLLECTION_ID} would claim label "Covers" under parent null while it is occupied by ${occupantId}`;
    expect(uploadCollectionOrderContractError(plans, [COLLECTION_ID])).to.equal(
      collision,
    );
    expect(
      runtime.__uploadCollectionOrderContractError(plans, [COLLECTION_ID]),
    ).to.equal(collision);

    const nested = [
      plans[0],
      createCollectionPlan({ ...collectionSnapshot('Covers'), parentId: 'p' }),
    ];
    expect(
      uploadCollectionOrderContractError(nested, [COLLECTION_ID]),
    ).to.equal(null);
    expect(
      runtime.__uploadCollectionOrderContractError(nested, [COLLECTION_ID]),
    ).to.equal(null);

    // A non-array locale list (never produced by the planner) is a contract
    // error on both sides, whether or not the metadata must be writable. The
    // runtime used to throw a TypeError or accept a string here.
    const upload = uploadCreatePlan();
    for (const locales of ['en', null, {}, { length: 1, 0: 'en' }]) {
      for (const nonLocalizedFocalPoints of [false, true]) {
        const schema = {
          locales,
          environmentSemantics: { nonLocalizedFocalPoints },
        };
        for (const requireWritable of [false, true]) {
          expect(
            runtime.__uploadDefaultFieldMetadataContractError(
              {},
              schema,
              { filename: 'cover.png' },
              requireWritable,
            ),
            JSON.stringify(locales),
          ).to.equal('schema locales are not an array');
        }
        for (const check of [
          uploadPlanContractError,
          runtime.__uploadPlanContractError,
        ]) {
          expect(
            check(upload, schema as unknown as ContentDiffPlan['schema']),
            JSON.stringify(locales),
          ).to.equal('desired snapshot is malformed');
        }
      }
    }
  });

  it('accepts only plain JSON objects as upload contract containers (D24)', () => {
    const plan = createCollectionPlan(collectionSnapshot('Covers'));
    const jsonPlan = JSON.parse(JSON.stringify(plan)) as UploadCollectionPlan;
    expect(uploadCollectionPlanContractError(jsonPlan)).to.equal(null);
    expect(runtime.__uploadCollectionPlanContractError(jsonPlan)).to.equal(
      null,
    );
    expect(
      uploadCollectionOrderContractError([jsonPlan], [COLLECTION_ID]),
    ).to.equal(null);
    expect(
      runtime.__uploadCollectionOrderContractError([jsonPlan], [COLLECTION_ID]),
    ).to.equal(null);

    const inherited = createCollectionPlan(
      Object.assign(
        Object.create({ inherited: true }) as UploadCollectionSnapshot,
        collectionSnapshot('Covers'),
      ),
    );
    expect(uploadCollectionPlanContractError(inherited)).to.equal(
      'baseline or desired snapshot is malformed',
    );
    expect(runtime.__uploadCollectionPlanContractError(inherited)).to.equal(
      'baseline or desired snapshot is malformed',
    );

    const consistency = { antivirusStatus: 'clean', updatedAt: null };
    expect(runtime.__uploadConsistencyContractError(consistency)).to.equal(
      null,
    );
    expect(
      runtime.__uploadConsistencyContractError(
        Object.assign(Object.create({ inherited: true }), consistency),
      ),
    ).to.equal('consistency must be an object');

    const legacyMetadata = () => ({
      en: {
        alt: null,
        title: null,
        custom_data: {},
        focal_point: null,
        poster_time: null,
      },
    });
    const uploadCases: Array<
      [string, ContentDiffPlan['schema'], (upload: UploadPlan) => void]
    > = [
      ['plain', FIELD_KEYED_SCHEMA, () => undefined],
      [
        'manual',
        FIELD_KEYED_SCHEMA,
        (upload) => {
          upload.desired!.manual = withInheritedPrototype(
            upload.desired!.manual,
          );
        },
      ],
      [
        'transport',
        FIELD_KEYED_SCHEMA,
        (upload) => {
          upload.desired!.transport = withInheritedPrototype(
            upload.desired!.transport,
          );
        },
      ],
      [
        'defaultFieldMetadata',
        FIELD_KEYED_SCHEMA,
        (upload) => {
          upload.desired!.manual.defaultFieldMetadata = withInheritedPrototype(
            upload.desired!.manual.defaultFieldMetadata,
          );
        },
      ],
      [
        'custom_data entry',
        FIELD_KEYED_SCHEMA,
        (upload) => {
          const metadata = upload.desired!.manual.defaultFieldMetadata as {
            custom_data: Record<string, object>;
          };
          metadata.custom_data.en = withInheritedPrototype({ tone: 'warm' });
        },
      ],
      [
        'nested custom_data value',
        FIELD_KEYED_SCHEMA,
        (upload) => {
          const metadata = upload.desired!.manual.defaultFieldMetadata as {
            custom_data: Record<string, object>;
          };
          metadata.custom_data.en = {
            nested: withInheritedPrototype({ tone: 'warm' }),
          };
        },
      ],
      [
        'legacy custom_data',
        LEGACY_SCHEMA,
        (upload) => {
          const metadata = legacyMetadata();
          metadata.en.custom_data = withInheritedPrototype({ tone: 'warm' });
          upload.desired!.manual.defaultFieldMetadata =
            metadata as unknown as UploadSnapshot['manual']['defaultFieldMetadata'];
        },
      ],
    ];
    for (const [label, schema, mutate] of uploadCases) {
      const upload = uploadCreatePlan();
      mutate(upload);
      refreshUploadHash(upload);
      const expected =
        label === 'plain' ? null : 'desired snapshot is malformed';
      expect(uploadPlanContractError(upload, schema), label).to.equal(expected);
      expect(runtime.__uploadPlanContractError(upload, schema), label).to.equal(
        expected,
      );
    }
    // The CMA client serves the field-keyed shape on every environment, so
    // the legacy locale-keyed one is refused even where it is the wire format.
    const localeKeyed = uploadCreatePlan(legacyMetadata());
    expect(uploadPlanContractError(localeKeyed, LEGACY_SCHEMA)).to.equal(
      'desired snapshot is malformed',
    );
    expect(
      runtime.__uploadPlanContractError(localeKeyed, LEGACY_SCHEMA),
    ).to.equal('desired snapshot is malformed');
    const fieldKeyed = uploadCreatePlan();
    expect(uploadPlanContractError(fieldKeyed, LEGACY_SCHEMA)).to.equal(null);
    expect(
      runtime.__uploadPlanContractError(fieldKeyed, LEGACY_SCHEMA),
    ).to.equal(null);

    expect(isPlainJsonObject({})).to.equal(true);
    expect(isPlainJsonObject(Object.create(null))).to.equal(true);
    expect(isPlainJsonObject([])).to.equal(false);
    expect(isPlainJsonObject(null)).to.equal(false);
    expect(isPlainJsonObject(new Date(0))).to.equal(false);
  });

  it('returns fresh expected change objects on every call (D32)', () => {
    for (const expectedChanges of [
      expectedUploadPlanChanges,
      runtime.__expectedUploadPlanChanges,
    ]) {
      for (const [action, value] of [
        ['create', true],
        ['delete', false],
        ['noop', false],
      ] as const) {
        const upload = { action } as UploadPlan;
        const first = expectedChanges(upload);
        const second = expectedChanges(upload);
        expect(first).to.deep.equal({
          binary: value,
          metadata: value,
          collection: value,
        });
        expect(first).not.to.equal(second);
        first!.binary = !value;
        expect(expectedChanges(upload)!.binary).to.equal(value);
      }
    }
  });

  it('derives one staging filename for bundling and execution (D38)', () => {
    for (const [id, expected] of [
      [COLLECTION_ID, COLLECTION_ID],
      ['12345', '12345'],
      ['a/b.c d', 'a_b_c_d'],
    ]) {
      expect(uploadStagingFilename(id)).to.equal(expected);
      expect(runtime.__uploadStagingFilename(id)).to.equal(expected);
    }

    const message = 'Cannot derive a staging filename from upload ID "".';
    let planner: unknown;
    try {
      uploadStagingFilename('');
    } catch (error) {
      planner = error;
    }
    expect(planner).to.be.instanceOf(ContentDiffError);
    expect((planner as ContentDiffError).code).to.equal(
      'UNSUPPORTED_CONTENT_STATE',
    );
    expect((planner as ContentDiffError).message).to.equal(message);

    let executed: RuntimeError | undefined;
    try {
      runtime.__uploadStagingFilename('');
    } catch (error) {
      executed = error as RuntimeError;
    }
    expect(executed?.name).to.equal('ContentDiffRuntimeError');
    expect(executed?.code).to.equal('INVALID_UPLOAD_ID');
    expect(executed?.message).to.equal(message);
    expect(executed?.details).to.equal(null);
  });

  it('compares binary extensions through the shared helper at execution', () => {
    const md5 = 'a'.repeat(32);
    expect(
      runtime.__uploadNeedsBinaryTransfer(
        { md5, filename: 'cover.png' },
        { md5, filename: 'cover.png' },
      ),
    ).to.equal(false);
    expect(
      runtime.__uploadNeedsBinaryTransfer(
        { md5, filename: undefined },
        { md5, filename: 'cover.png' },
      ),
    ).to.equal(true);
    expect(
      runtime.__uploadNeedsBinaryTransfer(
        { md5, filename: 'cover.PNG' },
        { md5, filename: 'cover.png' },
      ),
    ).to.equal(true);
    expect(
      runtime.__uploadNeedsBinaryTransfer(null, {
        md5,
        filename: 'cover.png',
      }),
    ).to.equal(true);
  });
});
