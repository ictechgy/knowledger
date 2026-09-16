#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createConfiguredApp } from '../apps/api/configured-runtime.ts';
import { createProjectTemplate } from '../packages/config/template.ts';

// Fixed synthetic workload, isolated from every existing workspace and network.
const directory = mkdtempSync(join(tmpdir(), 'kcl-history-performance-'));
const config = createProjectTemplate(); const actor = config.bootstrap_actor;
const policy = config.genesis.policies[0];
let app: Awaited<ReturnType<typeof createConfiguredApp>> | undefined;
try {
  app = await createConfiguredApp(config, { dataDir: directory, port: 0 });
  const measurements = []; let previous: string | undefined;
  for (let index = 1; index <= 200; index++) {
    const draft = await app.service.draft(actor, { document_id: policy.document_id, context_id: policy.context_id,
      scope_id: policy.scope_id, usage_scope: policy.usage_scope, title: `Review fixture ${index}`,
      body_markdown: '# Synthetic review fixture', ...(previous ? { base_revision_digest: previous } : {}) });
    const preview = await app.service.preview(actor, { draft_id: draft.draft_id });
    await app.service.publish(actor, { preview_id: preview.preview_id, confirm_shared: true, command_id: `history-performance-${index}` });
    previous = draft.revision.revision_digest;
    if ([10, 50, 100, 200].includes(index)) {
      const timings = []; let overview;
      for (let sample = 0; sample < 5; sample++) { const start = performance.now(); overview = await app.service.overview(actor); timings.push(performance.now() - start); }
      const history = await app.service.revisionHistory(actor, previous!);
      if (overview!.documents.length !== 1 || history.total !== index || history.revisions.length > 20
        || 'body_markdown' in overview!.documents[0].payload || 'history' in overview!.documents[0]) throw new Error('Unbounded or incomplete browse result');
      const exact = await app.service.getRevision(actor, previous!);
      if (exact.payload.body_markdown !== '# Synthetic review fixture') throw new Error('Exact body changed');
      measurements.push({ revisions: index, overview_ms: timings, overview_json_bytes: Buffer.byteLength(JSON.stringify(overview)),
        history_page_json_bytes: Buffer.byteLength(JSON.stringify(history)), history_page_count: history.revisions.length,
        history_total: history.total, documents: overview!.documents.length });
    }
  }
  console.log(JSON.stringify({ mode: 'isolated-local-simulation', node: process.version, samples: 5, measurements, fabric_sla_proven: false }, null, 2));
} finally { await app?.close(); rmSync(directory, { recursive: true, force: true }); }
