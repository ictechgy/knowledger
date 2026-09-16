const MAX_MARKDOWN_BYTES = 262_144;
const MAX_LCS_CELLS = 20_000;
const SLOT_FIELDS = ['channel_id', 'document_id', 'context_id', 'scope_id', 'usage_scope'];

export class RevisionComparisonError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RevisionComparisonError';
    this.code = code;
  }
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RevisionComparisonError('INVALID_REVISION', `${label}이 올바르지 않습니다.`);
  return value;
}

function revisionParts(value, label) {
  const revision = record(value, label);
  const payload = record(revision.payload, `${label}.payload`);
  if (typeof revision.revision_digest !== 'string' || revision.revision_digest.length === 0) throw new RevisionComparisonError('INVALID_REVISION', `${label} digest가 없습니다.`);
  if (typeof payload.body_markdown !== 'string' || typeof payload.title !== 'string') throw new RevisionComparisonError('INVALID_REVISION', `${label} 본문이 올바르지 않습니다.`);
  const bodyBytes = new TextEncoder().encode(payload.body_markdown).byteLength;
  if (bodyBytes > MAX_MARKDOWN_BYTES) throw new RevisionComparisonError('MARKDOWN_LIMIT', 'Markdown 본문은 256 KiB 이하여야 합니다.');
  return { revision, payload };
}

function sameSlot(current, previous) {
  return SLOT_FIELDS.every((field) => current.payload[field] === previous.payload[field]);
}

function lines(value) {
  return value.replace(/\r\n?/gu, '\n').split('\n');
}

function lineDiff(beforeText, afterText) {
  const before = lines(beforeText);
  const after = lines(afterText);
  if (before.length * after.length > MAX_LCS_CELLS) {
    return {
      fallback: true,
      message: '본문이 커서 줄 단위 비교를 생략했습니다. 아래에 두 개정본의 원문을 나란히 표시합니다.',
      lines: [],
      before_text: beforeText,
      after_text: afterText,
      line_endings_changed: beforeText !== afterText && before.join('\n') === after.join('\n'),
      before_line_count: before.length,
      after_line_count: after.length,
    };
  }
  const table = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1));
  for (let beforeIndex = before.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = after.length - 1; afterIndex >= 0; afterIndex -= 1) {
      table[beforeIndex][afterIndex] = before[beforeIndex] === after[afterIndex]
        ? table[beforeIndex + 1][afterIndex + 1] + 1
        : Math.max(table[beforeIndex + 1][afterIndex], table[beforeIndex][afterIndex + 1]);
    }
  }
  const output = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  while (beforeIndex < before.length || afterIndex < after.length) {
    if (beforeIndex < before.length && afterIndex < after.length && before[beforeIndex] === after[afterIndex]) {
      output.push({ type: 'context', text: before[beforeIndex], before_line: beforeIndex + 1, after_line: afterIndex + 1 });
      beforeIndex += 1; afterIndex += 1;
    } else if (afterIndex >= after.length || (beforeIndex < before.length && table[beforeIndex + 1][afterIndex] >= table[beforeIndex][afterIndex + 1])) {
      output.push({ type: 'removed', text: before[beforeIndex], before_line: beforeIndex + 1 });
      beforeIndex += 1;
    } else {
      output.push({ type: 'added', text: after[afterIndex], after_line: afterIndex + 1 });
      afterIndex += 1;
    }
  }
  return { fallback: false, line_endings_changed: beforeText !== afterText && before.join('\n') === after.join('\n'), lines: output, before_line_count: before.length, after_line_count: after.length };
}

function dependencyDiff(beforePayload, afterPayload) {
  const digest = (dependency) => dependency && typeof dependency.revision_digest === 'string' ? dependency.revision_digest : null;
  const before = (Array.isArray(beforePayload.dependencies) ? beforePayload.dependencies : []).map(digest).filter(Boolean);
  const after = (Array.isArray(afterPayload.dependencies) ? afterPayload.dependencies : []).map(digest).filter(Boolean);
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const signature = (value) => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))));
  const changed=[];
  for (const reference of afterPayload.dependencies || []) {
    const prior=(beforePayload.dependencies || []).find(item=>item.revision_digest===reference.revision_digest);
    if(prior && signature(prior)!==signature(reference)) changed.push({revision_digest:reference.revision_digest,before:prior,after:reference});
  }
  return {
    changed,
    before: [...before], after: [...after],
    added: [...afterSet].filter((value) => !beforeSet.has(value)),
    removed: [...beforeSet].filter((value) => !afterSet.has(value)),
  };
}

export function compareRevisions(currentValue, previousValue) {
  const current = revisionParts(currentValue, '현재 개정본');
  if (previousValue === null || previousValue === undefined) {
    return {
      has_previous: false,
      current_digest: current.revision.revision_digest,
      previous_digest: null,
      same_slot: true,
      title: { before: null, after: current.payload.title, changed: true },
      dependencies: { before: [], after: (current.payload.dependencies || []).map((item) => item?.revision_digest).filter(Boolean), added: [], removed: [], changed: [] },
      body: { fallback: false, line_endings_changed: false, message: '이 문서 범위의 이전 개정본이 없습니다. 최초 게시본입니다.', lines: [], before_line_count: 0, after_line_count: lines(current.payload.body_markdown).length },
    };
  }
  const previous = revisionParts(previousValue, '이전 개정본');
  if (!sameSlot(current, previous)) throw new RevisionComparisonError('DIFFERENT_SLOT', '서로 다른 문서 범위는 비교할 수 없습니다.');
  return {
    has_previous: true,
    current_digest: current.revision.revision_digest,
    previous_digest: previous.revision.revision_digest,
    same_slot: true,
    title: { before: previous.payload.title, after: current.payload.title, changed: previous.payload.title !== current.payload.title },
    dependencies: dependencyDiff(previous.payload, current.payload),
    body: lineDiff(previous.payload.body_markdown, current.payload.body_markdown),
  };
}

export const revisionDiffLimits = Object.freeze({ maxMarkdownBytes: MAX_MARKDOWN_BYTES, maxLcsCells: MAX_LCS_CELLS });
