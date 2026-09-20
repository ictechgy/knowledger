import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfiguredApp } from '../../../apps/api/configured-runtime.ts';
import { createProjectTemplate } from '../../../packages/config/template.ts';

test('scheduled Confluence status and drafts remain visible only to their configured owner', async ({ page }) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'knowledger-browser-scheduler-')); const config = createProjectTemplate(['AlphaMSP', 'BetaMSP'], 'scheduled-browser');
  const app = await createConfiguredApp(config, { dataDir, port: 0, confluenceSync: { pollMs: 0, sources: [{ owner: { org_id: 'AlphaMSP', actor_id: 'maintainer' },
    source: { source_id: 'scheduled-browser', cloud_id: '11111111-1111-1111-1111-111111111111', pages: [{ page_id: '123', policy_id: 'policy-shared-guideline', policy_version: 1 }],
      getAccessToken: () => 'FAKE_TOKEN', allows: () => true, fetch: async () => new Response(JSON.stringify({ id: '123', status: 'current', title: 'Scheduled source', version: { number: 1 },
        body: { atlas_doc_format: { value: JSON.stringify({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Private scheduled content' }] }] }) } } }), { headers: { 'content-type': 'application/json' } }) } }] } });
  try {
    await app.service.confluenceSync.runOnce(); const origin = await app.listen(0); await page.goto(origin);
    await expect(page.locator('#source-automation-list')).toContainText('scheduled-browser · 수집 완료 · 수동 실행');
    await expect(page.locator('#private-draft-count')).toHaveText('1'); await expect(page.locator('#metric-documents')).toHaveText('0');
    await page.locator('#persona-select').selectOption(JSON.stringify({ org_id: 'BetaMSP', actor_id: 'maintainer' }));
    await expect(page.locator('#source-automation-list')).toBeEmpty(); await expect(page.locator('#source-list')).not.toContainText('scheduled-browser');
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});
