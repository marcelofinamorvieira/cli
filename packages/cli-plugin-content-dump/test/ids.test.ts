import assert from 'node:assert/strict';
import { importedId } from '../src/import/ids';
import { fixtureId } from './fixture-id';

describe('importedId', () => {
  it('keeps UUID IDs', () => {
    const id = fixtureId('record');
    assert.equal(importedId(id), id);
  });

  it('gives a legacy numeric ID a version 4 UUID in URL-safe base64, always the same one', () => {
    const id = importedId('48291034');
    assert.match(id, /^[A-Za-z0-9_-]{22}$/);
    const bytes = Buffer.from(id, 'base64url');
    assert.equal(bytes[6]! >> 4, 4);
    assert.equal(bytes[8]! >> 6, 2);
    assert.equal(importedId('48291034'), id);
    assert.notEqual(importedId('48291035'), id);
  });
});
