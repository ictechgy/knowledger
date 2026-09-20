import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRetrieval } from '../../packages/measurement/retrieval.ts';
const digests = ['1', '2', '3'].map(value => `sha256:${value.repeat(64)}`);
const fixture = (id: string, relevant = digests.slice(0, 2), status: 'provided' | 'withheld' = 'provided') => ({
  id, query: 'PRIVATE_QUERY_CANARY', context_id: 'context-shared', scope_id: 'scope-primary', usage_scope: 'reference/v1',
  relevant_revision_digests: relevant, use: { document_ids: ['doc-source'], expected_status: status },
});
test('retrieval evaluation separates ranking quality from false releases and false withholding', async () => {
  const cases = [fixture('case-ranking'), fixture('case-withheld', [], 'withheld'), fixture('case-missed')]; let call = 0;
  const client: any = { request: async () => ({ results: [digests[2], digests[0]].map(revision_digest => ({ revision_digest })) }),
    resolve: async () => ({ status: ++call === 3 ? 'withheld' : 'provided' }) };
  const report = await evaluateRetrieval(client, cases, 2);
  assert.equal(report.cases[0].precision_at_k, .5); assert.equal(report.cases[0].recall_at_k, .5); assert.equal(report.cases[0].reciprocal_rank_at_k, .5);
  assert.equal(report.cases[1].recall_at_k, null); assert.equal(report.unexpected_provided, 1); assert.equal(report.unexpected_withheld, 1);
  assert.equal(report.status_accuracy, 1 / 3); assert.equal(JSON.stringify(report).includes('PRIVATE_QUERY_CANARY'), false);
});
test('evaluation validates every label before requests and rejects malformed or duplicate retrieval results', async () => {
  let calls = 0; const client: any = { request: async () => { calls++; return { results: digests.map(revision_digest => ({ revision_digest })) }; }, resolve: async () => ({ status: 'withheld' }) };
  await assert.rejects(evaluateRetrieval(client, [fixture('case-valid'), { ...fixture('case-bad'), scope_id: '' }])); assert.equal(calls, 0);
  await assert.rejects(evaluateRetrieval(client, [fixture('case-valid')], 2), /INVALID_RETRIEVAL_RESPONSE/);
  client.request = async () => ({ results: [{ revision_digest: digests[0] }, { revision_digest: digests[0] }] });
  await assert.rejects(evaluateRetrieval(client, [fixture('case-valid')], 2), /INVALID_RETRIEVAL_RESPONSE/);
  client.request = async () => ({ results: [] });
  const result = await evaluateRetrieval(client, [fixture('case-empty', [], 'withheld')], 5);
  assert.equal(result.mean_recall_at_k, null); assert.equal(result.mean_reciprocal_rank_at_k, null); assert.equal(result.status_accuracy, 1);
});
