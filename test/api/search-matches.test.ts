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
});

test('oversized results stay cached for offset pagination as a single large entry', () => {
  const cache = new SearchMatchCache();
  const large = Array.from({ length: 12_000 }, (_, index) => `sha256:${index.toString(16).padStart(64, '0')}`);
  cache.put('large-first', large);
  // 상한 초과 결과도 페이지마다 전체 원장 재스캔을 피하려면 유지해야 한다 — 기존 항목은 비운다.
  cache.put('oversized', [...large, ...large]);
  assert.equal(cache.get('oversized')?.length, 24_000);
  assert.equal(cache.get('large-first'), undefined, 'oversized results clear smaller entries');
  assert.equal(cache.get('oversized')?.length, 24_000, 'repeated reads keep serving the same snapshot');
});

test('normal entries cannot evict the resident oversized entry; only another oversized replaces it', () => {
  const cache = new SearchMatchCache();
  const large = Array.from({ length: 24_000 }, (_, index) => `sha256:${index.toString(16).padStart(64, '0')}`);
  cache.put('oversized', large);
  // 교차 워크로드: 일반 질의가 들어와도 대형 항목은 다음 오프셋 페이지를 위해 남는다.
  for (let index = 0; index < 16; index++) cache.put(`small-${index}`, [`revision-${index}`]);
  assert.equal(cache.get('oversized')?.length, 24_000, 'normal puts must not evict the oversized entry');
  // 일반 항목끼리는 기존 예산 규칙대로 축출된다.
  assert.equal(cache.get('small-0'), undefined, 'normal entries still evict each other under budget');
  assert.deepEqual(cache.get('small-15'), ['revision-15']);
  // 다른 대형 결과만이 상주 대형 항목을 교체한다.
  cache.put('oversized-next', large);
  assert.equal(cache.get('oversized'), undefined, 'a newer oversized result replaces the resident one');
  assert.equal(cache.get('oversized-next')?.length, 24_000);
});

test('search match byte budget includes keys and retains oversized data as a single entry', () => {
  const cache = new SearchMatchCache();
  cache.put('empty', []); assert.deepEqual(cache.get('empty'), []);
  const hugeKey = 'large-key'.repeat(300_000);
  cache.put(hugeKey, ['revision-one']);
  cache.put('large-id', ['x'.repeat(2 * 1024 * 1024)]);
  assert.equal(cache.get('large-id')?.length, 1); assert.equal(cache.get(hugeKey), undefined);
  assert.equal(cache.get('empty'), undefined, 'oversized entries replace the normal working set');
});
