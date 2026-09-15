import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonStrict } from '../../apps/api/json.ts';

test('JSON ingress rejects duplicate keys even with different escape encodings', () => {
  assert.throws(() => parseJsonStrict('{"actor_id":"one","actor_\\u0069d":"two"}'), /duplicate/i);
  assert.throws(() => parseJsonStrict('{"nested":{"body":"one","body":"two"}}'), /duplicate/i);
});
test('JSON ingress handles braces in quoted Markdown and rejects malformed/trailing input', () => {
  const source = { body_markdown: '# Hello\n```json\n{"a": [1, 2]}\n```', list: [null, true, 3] };
  assert.deepEqual(parseJsonStrict(JSON.stringify(source)), source);
  assert.throws(() => parseJsonStrict('{"a":1} {"b":2}'));
  assert.throws(() => parseJsonStrict('{"a":}'));
  assert.throws(() => parseJsonStrict('[1,]'));
});
test('JSON ingress bounds depth and rejects prototype keys', () => {
  assert.throws(() => parseJsonStrict('['.repeat(80) + '0' + ']'.repeat(80)), /depth/i);
  assert.throws(() => parseJsonStrict('{"__proto__":{"admin":true}}'), /key/i);
});
