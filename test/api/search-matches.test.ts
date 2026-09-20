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

test('oversized results stay cached for offset pagination alongside normal results', () => {
  const cache = new SearchMatchCache();
  const large = Array.from({ length: 12_000 }, (_, index) => `sha256:${index.toString(16).padStart(64, '0')}`);
  cache.put('large-first', large);
  // 상한 초과 결과도 페이지마다 전체 원장 재스캔을 피하려면 유지해야 한다 — 일반 작업 세트는 남는다.
  cache.put('oversized', [...large, ...large]);
  assert.equal(cache.get('oversized')?.length, 24_000);
  assert.equal(cache.get('large-first')?.length, 12_000, 'oversized results keep the normal working set');
  assert.equal(cache.get('oversized')?.length, 24_000, 'repeated reads keep serving the same snapshot');
});

test('normal entries cannot evict oversized results and alternating large queries stay cached', () => {
  const cache = new SearchMatchCache();
  const large = Array.from({ length: 24_000 }, (_, index) => `sha256:${index.toString(16).padStart(64, '0')}`);
  cache.put('oversized', large);
  // 교차 워크로드: 일반 질의가 들어와도 대형 항목은 다음 오프셋 페이지를 위해 남는다.
  for (let index = 0; index < 16; index++) cache.put(`small-${index}`, [`revision-${index}`]);
  assert.equal(cache.get('oversized')?.length, 24_000, 'normal puts must not evict the oversized entry');
  // 일반 항목끼리는 기존 예산 규칙대로 축출된다.
  assert.equal(cache.get('small-0'), undefined, 'normal entries still evict each other under budget');
  assert.deepEqual(cache.get('small-15'), ['revision-15']);
  // 대형 결과끼리도 합산 예산 안에서는 함께 남는다.
  cache.put('oversized-next', large);
  assert.equal(cache.get('oversized')?.length, 24_000);
  assert.equal(cache.get('oversized-next')?.length, 24_000);
  assert.equal(cache.stats.oversizedEntries, 2);
});

test('oversized pools enforce both total bytes and entry count with LRU eviction', () => {
  for (const limits of [{ maxEntries: 2, maxOversizedBytes: 1_000 }, { maxEntries: 8, maxOversizedBytes: 205 }]) {
    const cache = new SearchMatchCache({ ...limits, maxIds: 2, maxBytes: 100 });
    const ids = ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)];
    cache.put('small', ['one']);
    cache.put('a', ids); cache.put('b', ids);
    assert.deepEqual(cache.get('a'), ids); // a is the most recently used large query.
    cache.put('c', ids);
    assert.equal(cache.get('b'), undefined);
    assert.deepEqual(cache.get('a'), ids);
    assert.deepEqual(cache.get('c'), ids);
    assert.deepEqual(cache.get('small'), ['one']);
    assert.equal(cache.stats.oversizedEntries, 2);
    assert.equal(cache.stats.ids, 7);
    assert.ok(cache.stats.bytes <= 100 + limits.maxOversizedBytes);
    cache.put('rejected', Array(40).fill('x'.repeat(32)));
    assert.equal(cache.get('rejected'), undefined);
    assert.deepEqual(cache.get('a'), ids, 'an uncacheable result does not evict existing large queries');
    cache.put('a', ['one']);
    assert.equal(cache.stats.oversizedEntries, 1);
    cache.put('c', ['two']);
    assert.equal(cache.stats.oversizedEntries, 0);
    assert.equal(cache.stats.oversized, false);
    assert.equal(cache.stats.ids, 2, 'downsized entries return to the normal budget');
    cache.put('a', ids); cache.put('c', ids);
    assert.equal(cache.stats.oversizedEntries, 2, 'replacement accounting leaves the large budget reusable');
  }
});

test('re-putting the oversized key with a normal result resets oversized tracking', () => {
  const cache = new SearchMatchCache();
  const large = Array.from({ length: 24_000 }, (_, index) => `sha256:${index.toString(16).padStart(64, '0')}`);
  cache.put('big', large);
  // 같은 키에 일반 크기 결과가 오면 상주 대형 항목 지위를 잃고 일반 축출 대상이 된다.
  cache.put('big', ['revision-small']);
  for (let index = 0; index < 9; index++) cache.put(`normal-${index}`, [`revision-${index}`]);
  assert.equal(cache.get('big'), undefined, 'a downsized entry is no longer protected');
  assert.deepEqual(cache.get('normal-8'), ['revision-8']);
});

test('results beyond the oversized byte cap are not cached at all', () => {
  const cache = new SearchMatchCache({ maxIds: 4, maxBytes: 1_024, maxOversizedBytes: 4_096 });
  cache.put('small', ['revision-one']);
  // 건수 상한은 넘지만 바이트 상한도 넘는 결과는 상주 대상이 아니다 — 아무것도 캐시되지 않는다.
  const huge = Array.from({ length: 64 }, (_, index) => `sha256:${index.toString(16).padStart(64, '0')}`);
  cache.put('too-big', huge);
  assert.equal(cache.get('too-big'), undefined);
  assert.equal(cache.stats.oversized, false);
  assert.deepEqual(cache.get('small'), ['revision-one'], 'rejected oversized results keep the working set');
  // 상한 안의 대형 결과는 여전히 상주한다.
  cache.put('big-ok', huge.slice(0, 8));
  assert.equal(cache.stats.oversized, true);
});

test('byte-only oversized entries are not cached and keep the normal working set', () => {
  const cache = new SearchMatchCache();
  cache.put('empty', []); assert.deepEqual(cache.get('empty'), []);
  const hugeKey = 'large-key'.repeat(300_000);
  cache.put(hugeKey, ['revision-one']);
  cache.put('large-id', ['x'.repeat(2 * 1024 * 1024)]);
  // 건수는 작지만 바이트가 초과되는 항목은 캐시하지 않는다 — 상주 대상은
  // 페이지네이션이 재사용하는 큰 결과 집합뿐이고, 기존 작업 세트는 유지된다.
  assert.equal(cache.get('large-id'), undefined);
  assert.equal(cache.get(hugeKey), undefined);
  assert.deepEqual(cache.get('empty'), [], 'byte-overflow puts must not wipe the normal working set');
  assert.equal(cache.stats.entries, 1);
  assert.equal(cache.stats.oversized, false);
});
