import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateRevision, validatePolicy, validateDecision } from '../../packages/domain/index.ts';
import { LocalLedger } from '../../packages/storage/local-ledger.ts';
import { PrivateStore } from '../../packages/storage/private-store.ts';
import { KclService } from '../../apps/api/service.ts';
import { PERSONAS, actorIdentity } from '../../examples/order-workflow/config.ts';
import { seedDemo } from '../../examples/order-workflow/application.ts';
import { demoDefinition } from '../../examples/order-workflow/config.ts';

const example = (name: string) => JSON.parse(readFileSync(new URL(`../../examples/${name}.json`, import.meta.url), 'utf8'));
test('runtime validators accept published design fixtures and reject immutable-body tampering', () => {
  for (const name of ['sales', 'fulfillment', 'settlement', 'review_invitation']) validateRevision(example(`document_revision_${name}`));
  validatePolicy(example('agreement_policy'));
  validateDecision(example('approval_decision'));
  validateDecision(example('approval_decision_fulfillment'));
  assert.throws(() => validateRevision(example('negative_changed_body_old_digest')));
  assert.throws(() => validateRevision(example('negative_revision_runtime_agreement')));
});

test('generated run manifests conform to the baseline restricted design schema checker', async () => {
  const ledger = new LocalLedger(':memory:', 'kcl-demo');
  const vault = new PrivateStore(':memory:');
  try {
    const service = new KclService(ledger, vault, demoDefinition());
    await service.initialize();
    await seedDemo(service);
    const result = await service.resolve(actorIdentity(PERSONAS[0]), { document_ids: ['doc-sales-order-definition-001'], context_id: 'context-sales', scope_id: 'scope-order-2026-001', usage_scope: 'domain-definition/v1' });
    assert.equal(result.status, 'provided');
    const script = 'import json,sys\nfrom tools.validate_design import validate_instance\ns=json.load(open("schemas/run-context-manifest.schema.json"))\nvalidate_instance(json.load(sys.stdin),s,"$",s)\n';
    const validation = spawnSync('python3', ['-B', '-c', script], { cwd: fileURLToPath(new URL('../..', import.meta.url)), input: JSON.stringify(result.manifest), encoding: 'utf8' });
    assert.equal(validation.status, 0, validation.stderr);
  } finally { ledger.close(); vault.close(); }
});
