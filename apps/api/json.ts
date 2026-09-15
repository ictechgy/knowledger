/** Check lexical keys before JSON.parse can silently discard duplicate members. */
export function parseJsonStrict(source: string): any {
  let offset = 0;
  const whitespace = () => { while (/\s/.test(source[offset] ?? '') && offset < source.length) offset++; };
  const fail = (message = 'Invalid JSON') => { throw new Error(message); };
  const string = (): string => {
    if (source[offset++] !== '"') return fail();
    const start = offset - 1;
    while (offset < source.length) {
      const character = source[offset++];
      if (character === '\\') { offset++; continue; }
      if (character === '"') return JSON.parse(source.slice(start, offset));
    }
    return fail();
  };
  const value = (depth: number): void => {
    if (depth > 64) fail('JSON depth limit exceeded');
    whitespace();
    const next = source[offset];
    if (next === '{') {
      offset++; whitespace();
      const keys = new Set<string>();
      if (source[offset] === '}') { offset++; return; }
      for (;;) {
        whitespace();
        const key = string();
        if (keys.has(key)) fail('Duplicate JSON key');
        if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('Forbidden JSON key');
        keys.add(key);
        whitespace();
        if (source[offset++] !== ':') fail();
        value(depth + 1); whitespace();
        const delimiter = source[offset++];
        if (delimiter === '}') return;
        if (delimiter !== ',') fail();
      }
    }
    if (next === '[') {
      offset++; whitespace();
      if (source[offset] === ']') { offset++; return; }
      for (;;) {
        value(depth + 1); whitespace();
        const delimiter = source[offset++];
        if (delimiter === ']') return;
        if (delimiter !== ',') fail();
      }
    }
    if (next === '"') { string(); return; }
    const primitive = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(source.slice(offset));
    if (!primitive) fail();
    offset += primitive![0].length;
  };
  value(0); whitespace();
  if (offset !== source.length) fail();
  return JSON.parse(source);
}
