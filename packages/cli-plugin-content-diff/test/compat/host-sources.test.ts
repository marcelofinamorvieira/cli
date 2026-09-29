import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { expect } from 'chai';

/**
 * The host sources this plugin's migrations:new and migrations:run were copied
 * from, as they were when the copies were last brought in line with them.
 *
 * The plugin replaces the host's migrations commands with its own versions, so
 * a change to any of these files must reach the plugin too. When this test
 * fails, port the host change into the plugin's copy (src/commands/migrations,
 * src/utils), then record the new digests here.
 */
const MIRRORED_HOST_SOURCES: Record<string, string> = {
  'src/commands/migrations/new.ts':
    '49622faf8d8fc7524f826fb6a714e73022df4234b8b01f04139c9e7375d311b6',
  'src/commands/migrations/run.ts':
    'fb175882bc22119796ceb2a93efd7bfe2c062d499182e3bdb0a042299c89a983',
  'src/utils/find-nearest-file.ts':
    '398970df89501958d7ff8c6251893fe15d7f4658a171a9be7957bb8d361f59b7',
  'src/utils/environments-diff/fetch-schema.ts':
    'd0bddc0318c19aa5442665c7bac2f68ed8084a7971770acbf13ef645b098ef16',
  'src/utils/environments-diff/index.ts':
    'c1e38ce6c0dc1d166277e5dd3e074908cf5dd2c6a2788512e9e57a25b90bf697',
  'src/utils/environments-diff/resources/comments.ts':
    '5edd45b0530a51b6cf2f2dec145f2ca0a1dd9c08b3d5233a6f83f9cd939e474d',
  'src/utils/environments-diff/resources/create-new-fields-and-fieldsets.ts':
    '5fd33c039bc50c3ce09d1e62d6d6e9be1c45fd5abb7b5708a6ea203dd5697502',
  'src/utils/environments-diff/resources/create-new-item-types.ts':
    '8996da956d19111f3d5d38f3ba8f0e8efe5fdabce88ca62ca3873be6c6e580e0',
  'src/utils/environments-diff/resources/delete-missing-fields-and-fieldsets-in-existing-item-types.ts':
    'dc7236ebdec6cde71db135d4dabaeb6ce88472fc61e4ca736d240c6c5d21e17b',
  'src/utils/environments-diff/resources/delete-missing-item-types.ts':
    'cedac2995cd30c8ac214c731ef148d917396cfbaa7f65b8197726c14fadc8d4b',
  'src/utils/environments-diff/resources/finalize-item-types.ts':
    '8b51bceb9a1daaec3fd52fd75371bf974d2f56a4af70294dbec2b614a4c31ebe',
  'src/utils/environments-diff/resources/manage-item-type-filters.ts':
    '12e721b4ccf98e69c6f89bce860638eb3c45ac54466cc5ea9a65e7777c925abe',
  'src/utils/environments-diff/resources/manage-menu-items.ts':
    '0f616a19308d31199438c555052fd66a9ec9d65b7372ff4eb9852095d80e6954',
  'src/utils/environments-diff/resources/manage-plugins.ts':
    'a82b432de44b4afb0fb08931b7b571f717692b528f3a8210a36749591389abd5',
  'src/utils/environments-diff/resources/manage-schema-menu-items.ts':
    '56eb801adf9092ff30ce46edf191fafc25fec7797971236bee11c336de5a76f2',
  'src/utils/environments-diff/resources/manage-upload-filters.ts':
    '795686e39b3d460f3b261c50e09e3376cf1cbb47845a9671466689aaac62c17a',
  'src/utils/environments-diff/resources/manage-workflows.ts':
    '82f81e42753b08533dbdd02da7a90e275c60651177b7607e6b603672e54d331b',
  'src/utils/environments-diff/resources/update-fields-and-fieldsets.ts':
    '68a9d26620c37f3b5c5057c7e1805b497ed243d48bb925dcf9a631cafd3ee47c',
  'src/utils/environments-diff/resources/update-roles.ts':
    'c249e708216f57b87ccb29921b05afa6ebc3cc019e9e448def7c1fa629f33049',
  'src/utils/environments-diff/resources/update-site.ts':
    'aa77185e14e778af9b8e47489a561787e5d049e5178cc9e79a46db6b24c058ad',
  'src/utils/environments-diff/types.ts':
    '92eb06c28d9d4a8091a7f30cf57da6022cf913f990faa0e9d0a424f506818283',
  'src/utils/environments-diff/utils.ts':
    'e94fe3ada867fd4c9dbf8414554d444737ff41ffe435e5d86bebd64462ea712d',
  'src/utils/environments-diff/write/api-calls.ts':
    'd5f2c5d482383ef78c9fe6e1d2bdbcd7d3020e551d0cf280939fe2320ed48a7f',
  'src/utils/environments-diff/write/comments.ts':
    'efb6262df14f6a913fc4eb969eb600c0d54a7f4c200775af0c7932a410c06651',
  'src/utils/environments-diff/write/get-entity-ids-to-be-recreated.ts':
    '7a41617cccff6128a5cdf5f8b0c28d3c9912bfa5df4e71e297570069c6b34bb9',
  'src/utils/environments-diff/write/index.ts':
    '5b0fa8515e24ca6ef8522e3b612058adab6cbcd25f66d0e1885ce9523f0e684f',
};

const HOST_ROOT = dirname(require.resolve('datocms/package.json'));

function hostSourceFiles(): string[] {
  const walk = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(join(directory, entry.name))
        : [relative(HOST_ROOT, join(directory, entry.name))],
    );
  return [
    'src/commands/migrations/new.ts',
    'src/commands/migrations/run.ts',
    'src/utils/find-nearest-file.ts',
    ...walk(join(HOST_ROOT, 'src/utils/environments-diff')),
  ].map((path) => path.split('\\').join('/'));
}

describe('datocms host sources', () => {
  it('match the ones the plugin migrations commands mirror', function () {
    // Only the workspace host has its sources; an npm install ships lib/.
    if (!existsSync(join(HOST_ROOT, 'src'))) this.skip();

    const actual = Object.fromEntries(
      hostSourceFiles()
        .sort()
        .map((path) => [
          path,
          createHash('sha256')
            .update(
              readFileSync(join(HOST_ROOT, path), 'utf8').replace(
                /\r\n/g,
                '\n',
              ),
            )
            .digest('hex'),
        ]),
    );

    expect(
      actual,
      'the host migrations code changed: port the change into the plugin, then update MIRRORED_HOST_SOURCES',
    ).to.deep.equal(MIRRORED_HOST_SOURCES);
  });
});
