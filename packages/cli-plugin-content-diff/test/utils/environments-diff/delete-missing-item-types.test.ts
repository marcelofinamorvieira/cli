import type { CmaClient } from '@datocms/cli-utils';
import { expect } from 'chai';
import { deleteMissingItemTypes } from '../../../src/utils/environments-diff/resources/delete-missing-item-types';
import type {
  Command,
  ItemTypeInfo,
  Schema,
} from '../../../src/utils/environments-diff/types';

function itemType(
  id: string,
  modularBlock: boolean,
  fields: CmaClient.RawApiTypes.Field[] = [],
): ItemTypeInfo {
  return {
    entity: {
      id,
      type: 'item_type',
      attributes: {
        name: id,
        api_key: id,
        modular_block: modularBlock,
      },
    } as CmaClient.RawApiTypes.ItemType,
    fieldsById: Object.fromEntries(fields.map((field) => [field.id, field])),
    fieldsetsById: {},
  };
}

function blockField(
  id: string,
  fieldType: 'rich_text' | 'single_block' | 'structured_text',
  referencedBlockIds: string[],
): CmaClient.RawApiTypes.Field {
  const validators =
    fieldType === 'rich_text'
      ? { rich_text_blocks: { item_types: referencedBlockIds } }
      : fieldType === 'single_block'
        ? { single_block_blocks: { item_types: referencedBlockIds } }
        : {
            structured_text_blocks: { item_types: referencedBlockIds },
            structured_text_inline_blocks: {
              item_types: referencedBlockIds,
            },
          };

  return {
    id,
    type: 'field',
    attributes: {
      field_type: fieldType,
      validators,
    },
  } as CmaClient.RawApiTypes.Field;
}

function schema(itemTypesById: Record<string, ItemTypeInfo>): Schema {
  return { itemTypesById } as Schema;
}

function destroyedIds(commands: Command[]): string[] {
  return commands.flatMap((command) =>
    command.type === 'apiCallClientCommand' &&
    command.call === 'client.itemTypes.destroy'
      ? [command.arguments[0]]
      : [],
  );
}

describe('delete missing item types', () => {
  it('deletes recursive block referrers before the blocks they reference', () => {
    const leaf = itemType('leaf-block', true);
    const container = itemType('container-block', true, [
      blockField('nested-block', 'single_block', [leaf.entity.id]),
    ]);
    const article = itemType('article', false, [
      blockField('body', 'structured_text', [container.entity.id]),
    ]);
    const oldSchema = schema({
      [leaf.entity.id]: leaf,
      [container.entity.id]: container,
      [article.entity.id]: article,
    });

    expect(destroyedIds(deleteMissingItemTypes(schema({}), oldSchema))).to.eql([
      article.entity.id,
      container.entity.id,
      leaf.entity.id,
    ]);
  });

  it('falls back to stable source order for an unorderable block cycle', () => {
    const left = itemType('left-block', true, [
      blockField('left-body', 'rich_text', ['right-block']),
    ]);
    const right = itemType('right-block', true, [
      blockField('right-body', 'single_block', ['left-block']),
    ]);
    const oldSchema = schema({
      [left.entity.id]: left,
      [right.entity.id]: right,
    });

    expect(destroyedIds(deleteMissingItemTypes(schema({}), oldSchema))).to.eql([
      left.entity.id,
      right.entity.id,
    ]);
  });
});
