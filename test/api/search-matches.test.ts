import test from 'node:test';
import assert from 'node:assert/strict';
import { SearchMatchCache } from '../../apps/api/search-matches.ts';

test('search matches retain only immutable ID lists with bounded entry and total-ID budgets', () => {
  const cache = new SearchMatchCache(); const original = ['revision-one'];
  cache.put('first', original); original.push('must-not-appear');
  assert.deepEqual(cache.get('first'), ['revision-one']);
  for (let index = 1; index <= 8; index++) cache.put(`query-${index}`, [`revision-${index}`]);
  assert.equal(cache.get('first'), undefined);
  const large = Array.from({ length: 12_000 }, (_, index) => `sha256:${index.toString(16).padStart(64, '0')}`);
  cache.put('large-first', large); cache.put('large-second', large);
  assert.equal(cache.get('large-first'), undefined); assert.equal(cache.get('large-second')?.length, 12_000);
  cache.put('oversized', [...large, ...large]); assert.equal(cache.get('oversized'), undefined);
  assert.equal(cache.get('large-second')?.length, 12_000, 'oversized results do not evict useful cached pages');
});

test('search match byte budget includes keys and does not retain oversized data', () => {
  const cache = new SearchMatchCache();
  cache.put('empty', []); assert.deepEqual(cache.get('empty'), []);
  cache.put('large-key'.repeat(300_000), ['revision-one']);
  cache.put('large-id', ['x'.repeat(2 * 1024 * 1024)]);
  assert.equal(cache.get('large-id'), undefined); assert.deepEqual(cache.get('empty'), []);
});
