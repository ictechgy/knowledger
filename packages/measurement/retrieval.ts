import type { KnowledgerClient } from '../client/knowledge-client.ts';

export interface RetrievalEvaluationCase {
  id: string; query: string; context_id: string; scope_id: string; usage_scope: string;
  relevant_revision_digests: string[];
  use: { document_ids: [string]; expected_status: 'provided' | 'withheld' };
}
export interface RetrievalCaseResult {
  id: string; retrieved_revision_digests: string[];
  precision_at_k: number; recall_at_k: number | null; reciprocal_rank_at_k: number | null;
  expected_status: 'provided' | 'withheld'; actual_status: 'provided' | 'withheld'; status_matched: boolean;
}
const ID = /^[A-Za-z][A-Za-z0-9._:-]{2,63}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const distinct = (values: unknown, pattern: RegExp, max: number): values is string[] => Array.isArray(values) && values.length <= max
  && values.every(value => typeof value === 'string' && pattern.test(value)) && new Set(values).size === values.length;

/** Compare labeled queries against an explicitly configured client. Resolve performs the
 * normal fresh-use checks and records a run; no model generation or approval is invoked.
 * Query text and document bodies are deliberately omitted from the report. */
export async function evaluateRetrieval(client: Pick<KnowledgerClient, 'request' | 'resolve'>, cases: RetrievalEvaluationCase[], k = 5,
  options: { allowDevelopment?: boolean; modelAdapterId?: string } = {}) {
  if (!Number.isSafeInteger(k) || k < 1 || k > 50 || !Array.isArray(cases) || cases.length < 1 || cases.length > 1000
    || new Set(cases.map(item => item?.id)).size !== cases.length) throw new Error('INVALID_RETRIEVAL_EVALUATION');
  for (const item of cases) {
    if (!item || Object.keys(item).sort().join(',') !== 'context_id,id,query,relevant_revision_digests,scope_id,usage_scope,use'
      || ![item.id, item.context_id, item.scope_id].every(value => typeof value === 'string' && ID.test(value))
      || typeof item.query !== 'string' || item.query.length > 1000 || typeof item.usage_scope !== 'string' || !/^[a-z][a-z0-9-]{1,40}\/v[1-9][0-9]*$/.test(item.usage_scope)
      || !distinct(item.relevant_revision_digests, DIGEST, 100) || !item.use || Object.keys(item.use).sort().join(',') !== 'document_ids,expected_status'
      || !distinct(item.use.document_ids, ID, 1) || item.use.document_ids.length !== 1 || !['provided', 'withheld'].includes(item.use.expected_status)) throw new Error('INVALID_RETRIEVAL_EVALUATION');
  }
  const results: RetrievalCaseResult[] = [];
  for (const item of structuredClone(cases)) {
    const scope = { context_id: item.context_id, scope_id: item.scope_id, usage_scope: item.usage_scope };
    const search = await client.request<{ results: { revision_digest: string }[] }>('/vector-search', { method: 'POST', body: { query: item.query, ...scope, limit: k } });
    const retrieved = search?.results?.map(result => result?.revision_digest);
    if (!distinct(retrieved, DIGEST, k)) throw new Error('INVALID_RETRIEVAL_RESPONSE');
    const resolution = await client.resolve({ ...scope, document_ids: item.use.document_ids }, options);
    if (resolution?.status !== 'provided' && resolution?.status !== 'withheld') throw new Error('INVALID_RETRIEVAL_RESPONSE');
    const relevant = new Set(item.relevant_revision_digests);
    const hits = retrieved.filter(digest => relevant.has(digest)).length;
    const first = retrieved.findIndex(digest => relevant.has(digest));
    results.push({ id: item.id, retrieved_revision_digests: retrieved, precision_at_k: hits / k,
      recall_at_k: relevant.size ? hits / relevant.size : null, reciprocal_rank_at_k: relevant.size ? first < 0 ? 0 : 1 / (first + 1) : null,
      expected_status: item.use.expected_status, actual_status: resolution.status, status_matched: item.use.expected_status === resolution.status });
  }
  const mean = (values: (number | null)[]) => { const measured = values.filter((value): value is number => value !== null); return measured.length ? measured.reduce((sum, value) => sum + value, 0) / measured.length : null; };
  return { schema_version: 1, k, evaluated_at: new Date().toISOString(), cases: results,
    mean_precision_at_k: mean(results.map(row => row.precision_at_k)), mean_recall_at_k: mean(results.map(row => row.recall_at_k)),
    mean_reciprocal_rank_at_k: mean(results.map(row => row.reciprocal_rank_at_k)),
    status_accuracy: results.filter(row => row.status_matched).length / results.length,
    unexpected_provided: results.filter(row => row.expected_status === 'withheld' && row.actual_status === 'provided').length,
    unexpected_withheld: results.filter(row => row.expected_status === 'provided' && row.actual_status === 'withheld').length };
}
