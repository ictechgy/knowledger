import { createHash } from "node:crypto";
import { canonicalize as domainCanonicalize } from "../domain/index.ts";

export function canonicalJson(value: unknown): string {
  return domainCanonicalize(value);
}

export function jcsBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(domainCanonicalize(value));
}

export function sha256Digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(jcsBytes(value)).digest("hex")}`;
}

export function parseStrictJson(bytes: Uint8Array): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let offset = 0;
  const whitespace = () => { while (offset < text.length && /\s/.test(text[offset] ?? "")) offset += 1; };
  const fail = (): never => { throw new Error("invalid JSON command"); };
  const parseString = (): string => {
    if (text[offset++] !== '"') return fail();
    const start = offset - 1;
    while (offset < text.length) {
      const character = text[offset++];
      if (character === "\\") { offset += 1; continue; }
      if (character === '"') return JSON.parse(text.slice(start, offset)) as string;
    }
    return fail();
  };
  const parseValue = (depth: number): void => {
    if (depth > 64) return fail();
    whitespace();
    const next = text[offset];
    if (next === "{") {
      offset += 1; whitespace();
      const keys = new Set<string>();
      if (text[offset] === "}") { offset += 1; return; }
      for (;;) {
        const key = parseString();
        if (keys.has(key) || ["__proto__", "constructor", "prototype"].includes(key)) return fail();
        keys.add(key); whitespace();
        if (text[offset++] !== ":") return fail();
        parseValue(depth + 1); whitespace();
        const delimiter = text[offset++];
        if (delimiter === "}") return;
        if (delimiter !== ",") return fail();
        whitespace();
      }
    }
    if (next === "[") {
      offset += 1; whitespace();
      if (text[offset] === "]") { offset += 1; return; }
      for (;;) {
        parseValue(depth + 1); whitespace();
        const delimiter = text[offset++];
        if (delimiter === "]") return;
        if (delimiter !== ",") return fail();
        whitespace();
      }
    }
    if (next === '"') { parseString(); return; }
    const primitive = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(offset));
    if (!primitive) return fail();
    offset += primitive[0].length;
  };
  parseValue(0); whitespace();
  if (offset !== text.length) fail();
  return JSON.parse(text);
}
