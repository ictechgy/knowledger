import assert from "node:assert/strict";
import { test } from "node:test";
import { compareRevisions, RevisionComparisonError } from "../../apps/web/revision-diff.js";

function revision(overrides: Record<string, unknown> = {}) {
  const { revision_digest = "sha256-current", ...payloadOverrides } = overrides;
  return {
    revision_digest,
    payload: {
      title: "Current title",
      body_markdown: "one\ntwo\n",
      channel_id: "channel-a",
      document_id: "doc-a",
      context_id: "context-a",
      scope_id: "scope-a",
      usage_scope: "usage-a",
      dependencies: [],
      ...payloadOverrides,
    },
  };
}

test("compares exact revision content and dependencies within the same slot", () => {
  const result = compareRevisions(revision(), revision({ revision_digest: "sha256-previous", title: "Previous title", body_markdown: "one\nold\n", dependencies: [{ revision_digest: "dep-old" }] }));
  assert.equal(result.current_digest, "sha256-current");
  assert.equal(result.previous_digest, "sha256-previous");
  assert.equal(result.has_previous, true);
  assert.equal(result.title.before, "Previous title");
  assert.equal(result.title.after, "Current title");
  assert.deepEqual(result.dependencies.added, []);
  assert.deepEqual(result.dependencies.removed, ["dep-old"]);
  assert.ok(result.body.lines.some((line) => line.type === "removed" && line.text === "old"));
});

test("normalizes CRLF and final newline while retaining repeated lines", () => {
  const result = compareRevisions(revision({ body_markdown: "same\r\nrepeat\r\nrepeat\r\n" }), revision({ body_markdown: "same\nrepeat\nold\nrepeat" }));
  assert.equal(result.body.fallback, false);
  assert.ok(result.body.lines.some((line) => line.type === "removed" && line.text === "old"));
  assert.ok(result.body.lines.filter((line) => line.type === "context" && line.text === "repeat").length >= 2);
});

test("reports a first publication without inventing a previous revision", () => {
  const result = compareRevisions(revision({ body_markdown: "# first" }), null);
  assert.equal(result.has_previous, false);
  assert.equal(result.previous_digest, null);
  assert.equal(result.body.message, "이 문서 범위의 이전 개정본이 없습니다. 최초 게시본입니다.");
});

test("blocks comparisons across document slots", () => {
  assert.throws(() => compareRevisions(revision(), revision({ document_id: "other-doc" })), (error: unknown) => error instanceof RevisionComparisonError && error.code === "DIFFERENT_SLOT");
});

test("keeps malicious markdown as text and falls back safely for large inputs", () => {
  const malicious = "<img src=x onerror=alert(1)>";
  const result = compareRevisions(revision({ body_markdown: malicious }), revision({ body_markdown: "safe" }));
  assert.ok(result.body.lines.some((line) => line.text === malicious));
  const huge = "x\n".repeat(20_000);
  const fallback = compareRevisions(revision({ body_markdown: huge }), revision({ body_markdown: `y\n${huge}` }));
  assert.equal(fallback.body.fallback, true);
  assert.match(fallback.body.message, /커져|원문/);
});

test("rejects markdown beyond the intake bound", () => {
  assert.throws(() => compareRevisions(revision({ body_markdown: "x".repeat(262_145) }), null), /256 KiB/);
});

test('makes byte-only newline changes and changed dependency enforcement visible',()=>{
  const dependency={revision_digest:'dep-same',enforcement:'requires_active',relationship:'reference'};
  const result=compareRevisions(revision({body_markdown:'same\r\n',dependencies:[{...dependency,enforcement:'reference_only'}]}),revision({body_markdown:'same\n',dependencies:[dependency]}));
  assert.equal(result.body.line_endings_changed,true);
  assert.equal(result.dependencies.changed.length,1);
  assert.equal(result.dependencies.changed[0].before.enforcement,'requires_active');
  assert.equal(result.dependencies.changed[0].after.enforcement,'reference_only');
  const reordered={relationship:'reference',enforcement:'requires_active',revision_digest:'dep-same'};
  assert.equal(compareRevisions(revision({dependencies:[reordered]}),revision({dependencies:[dependency]})).dependencies.changed.length,0);
});
