import { test as base, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfiguredApp } from '../../../apps/api/configured-runtime.ts';
import { createProjectTemplate } from '../../../packages/config/template.ts';

const test=base.extend({workspace:async({},use)=>{
  const dataDir=mkdtempSync(join(tmpdir(),'knowledger-browser-'));const config=createProjectTemplate(['AlphaMSP','BetaMSP'],'browser-workspace');
  let app,origin;let writes=0;let deferredType=null;let held=null;let execute;
  const start=async(port=0)=>{
    app=await createConfiguredApp(config,{dataDir,port});execute=app.service.ledger.execute.bind(app.service.ledger);
    app.service.ledger.execute=async(actor,command)=>{writes++;if(command.type===deferredType){deferredType=null;held={actor,command};return {status:'pending',command_id:command.command_id,tx_id:'fixture-unconfirmed',payload_digest:'a'.repeat(64)};}return execute(actor,command);};
    origin=await app.listen(port);
  };
  await start();
  try {await use({get origin(){return origin;},get app(){return app;},get writes(){return writes;},defer(type){deferredType=type;},async completeDeferred(){if(!held)throw Error('No held request');await execute(held.actor,held.command);held=null;},async restart(){const port=Number(new URL(origin).port);await app.close();await start(port);}});}
  finally{await app.close();rmSync(dataDir,{recursive:true,force:true});}
}});
async function open(page,workspace){await page.goto(workspace.origin);await expect(page.locator('#persona-select')).toBeEnabled();await expect(page.locator('#metric-documents')).toHaveText('0');}
async function compose(page,title,body,{revise=false}={}){
  await page.getByRole('button',{name:revise?'이 문서의 새 개정본 작성':'새 지식 문서 작성',exact:true}).click();
  await page.locator('#draft-title').fill(title);await page.locator('#draft-body').fill(body);
  await page.locator('#save-draft').click();await page.getByRole('button',{name:'공유 게시 미리보기 생성',exact:true}).click();
  await page.locator('#preview-section input[type=checkbox]').check();
  await page.getByRole('button',{name:'공용 원장에 게시',exact:true}).click();
}
async function publish(page,title,body,options){await compose(page,title,body,options);await expect(page.locator('#document-title')).toHaveText(title);}
async function switchActor(page,org){await page.locator('#persona-select').selectOption(JSON.stringify({org_id:org,actor_id:'maintainer'}));await expect(page.locator('#footer-actor')).toContainText(org);}
// 주기적 개요 재렌더가 fill과 click 사이에 끼어들어 rationale이 지워지면 제출이 조용히 무시된다.
// actor 전환 직후 검토함이 이전 actor의 빈 상태를 잠시 보여줄 수 있으므로, 완료 신호는 UI가 아니라 서비스의 커밋된 결정 수로 잡고 성공할 때까지 재시도한다.
async function approve(page,workspace){const baseline=workspace.app.service.values('decision').length;await expect(async()=>{if(workspace.app.service.values('decision').length>baseline)return;await page.getByRole('textbox',{name:'이번 결정의 근거'}).fill('Browser test human review');await page.getByRole('button',{name:'승인',exact:true}).click();await expect.poll(()=>workspace.app.service.values('decision').length,{timeout:2000}).toBeGreaterThan(baseline);}).toPass({timeout:20000});}
// 활성화도 같은 이유로 카드 문구 대신 활성화된 제안 수를 완료 신호로 쓴다 — 카드가 이미 '합의 활성'을 보여도 교체 활성화는 새 제안 기준으로 판정한다.
async function activate(page,workspace){const baseline=workspace.app.service.values('proposal').filter(p=>p.status==='activated').length;await expect(async()=>{if(workspace.app.service.values('proposal').filter(p=>p.status==='activated').length>baseline)return;await page.getByRole('button',{name:'합의 활성화',exact:true}).click();await expect.poll(()=>workspace.app.service.values('proposal').filter(p=>p.status==='activated').length,{timeout:2000}).toBeGreaterThan(baseline);}).toPass({timeout:20000});}

test('two-organization publication, private isolation, approvals, provided context and withdrawal',async({page,workspace})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));await open(page,workspace);
  await publish(page,'Shared guide','# Shared guide\n\nReviewed by two organizations.');
  await expect(page.locator('#revision-compare-content')).toContainText('이전 개정본');
  await page.getByRole('button',{name:'검토 제안 제출',exact:true}).click();await expect(page.locator('#review-inbox-count')).toHaveText('1');
  await approve(page,workspace);await switchActor(page,'BetaMSP');await expect(page.locator('#private-draft-list')).not.toContainText('Shared guide');
  await approve(page,workspace);await activate(page,workspace);
  await page.locator('#resolver-form button[type=submit]').click();await expect(page.locator('#resolver-result')).toContainText('권위 있는 컨텍스트');
  await page.getByRole('textbox',{name:'상태 변경 사유'}).fill('Browser test withdrawal');await page.getByRole('button',{name:'사용 철회',exact:true}).click();
  await expect(page.locator('.document-card')).toContainText('철회됨');
  await page.locator('#resolver-form button[type=submit]').click();await expect(page.locator('#resolver-result')).toContainText('보류');
  expect(errors).toEqual([]);
});

test('revision comparison is safe text and review inbox keeps the exact older revision',async({page,workspace})=>{
  await open(page,workspace);await publish(page,'Original guide','# Original\nold rule');
  await page.getByRole('button',{name:'검토 제안 제출',exact:true}).click();await expect(page.locator('#review-inbox-count')).toHaveText('1');
  await publish(page,'Changed guide','# Changed\n<img src=x onerror=alert(1)>',{revise:true});
  await expect(page.locator('#revision-compare-content')).toContainText('old rule');
  await expect(page.locator('#revision-compare-content')).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('#revision-compare-content img')).toHaveCount(0);
  await page.locator('.review-inbox-item').click();await expect(page.locator('#document-title')).toHaveText('Original guide');
  await expect(page.locator('#document-detail-content .markdown-source')).toHaveText('# Original\nold rule');
  await expect(page.locator('#revision-compare-content')).toContainText('이전 개정본');
  for(const width of [390,600,1440]){
    await page.setViewportSize({width,height:900});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
  await page.getByRole('button',{name:'검토함 내가 답할 제안'}).click();await expect(page.locator('#review-inbox-title')).toBeFocused();
});

test('pending survives application restart; only explicit retry submits the original request',async({page,workspace})=>{
  await open(page,workspace);workspace.defer('publish_revision');await compose(page,'Pending guide','# Pending guide');
  await expect(page.locator('#command-list')).toContainText('확인 중');const originalWrites=workspace.writes;
  await page.locator('#refresh-commands').click();expect(workspace.writes).toBe(originalWrites);
  await workspace.restart();await page.reload();await expect(page.locator('#command-list')).toContainText('확인 중');
  await page.getByRole('button',{name:'같은 요청 다시 보내기',exact:true}).click();
  await expect(page.locator('#command-list')).toContainText('커밋 확인됨');
  await expect(page.locator('#document-title')).toHaveText('Pending guide');
  expect(workspace.app.service.values('revision')).toHaveLength(1);
  await switchActor(page,'BetaMSP');await expect(page.locator('#command-list')).not.toContainText('커밋 확인됨');
  await page.reload();await expect(page.locator('#command-list')).not.toContainText('커밋 확인됨');
});

test('peer failure remains unconfirmed and polling discovers a delayed commit without resubmission',async({page,workspace})=>{
  await open(page,workspace);workspace.defer('publish_revision');await compose(page,'Delayed guide','# Delayed guide');
  await expect(page.locator('#command-list')).toContainText('확인 중');const writes=workspace.writes;
  await page.route('**/commands/*',async route=>{if(route.request().method()==='GET')await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({code:'FRESHNESS_UNAVAILABLE',message:'Test peer unavailable',retryable:true})});else await route.continue();});
  await expect(page.locator('#command-list')).toContainText('미확정 · 확인 불가');
  expect(workspace.writes).toBe(writes);
  await page.unroute('**/commands/*');await workspace.completeDeferred();
  await expect(page.locator('#command-list')).toContainText('커밋 확인됨',{timeout:12_000});
  await expect(page.locator('#document-title')).toHaveText('Delayed guide');expect(workspace.writes).toBe(writes);
});

test('late request history and stale unauthorized responses cannot replace a new actor session',async({page,workspace})=>{
  await open(page,workspace);await publish(page,'Private history test','# Shared test');
  for(const unauthorized of [false,true]){
    await switchActor(page,'AlphaMSP');await expect(page.locator('#command-list')).toContainText('커밋 확인됨');
    let release;const gate=new Promise(resolve=>release=resolve);let reached;const intercepted=new Promise(resolve=>reached=resolve);let once=true;
    await page.route('**/commands?*',async route=>{if(!once){await route.continue();return;}once=false;const response=await route.fetch();reached();await gate;
      if(unauthorized)await route.fulfill({status:401,contentType:'application/json',body:JSON.stringify({code:'UNAUTHENTICATED',message:'Test expired session'})});else await route.fulfill({response});
    });
    await page.locator('#refresh-commands').click();await intercepted;
    await switchActor(page,'BetaMSP');await expect(page.locator('#command-list')).not.toContainText('커밋 확인됨');release();
    await expect(page.locator('#footer-actor')).toContainText('BetaMSP');await expect(page.locator('#command-list')).not.toContainText('커밋 확인됨');
    await page.unroute('**/commands?*');
  }
});

test('rapid duplicate approval clicks submit one command while the first response is outstanding',async({page,workspace})=>{
  await open(page,workspace);await publish(page,'Click once','# Single approval');
  await page.getByRole('button',{name:'검토 제안 제출',exact:true}).click();await page.getByRole('textbox',{name:'이번 결정의 근거'}).fill('One deliberate review');
  let release;const gate=new Promise(resolve=>release=resolve);let reached;const held=new Promise(resolve=>reached=resolve);let posts=0;
  await page.route('**/agreement-proposals/*/decisions',async route=>{posts++;reached();await gate;await route.continue();});
  await page.getByRole('button',{name:'승인',exact:true}).click();await held;
  await page.getByRole('button',{name:'승인',exact:true}).click();await expect(page.locator('#global-status')).toContainText('이미 보내는 중');expect(posts).toBe(1);
  release();await expect(page.locator('#review-inbox-count')).toHaveText('0');expect(workspace.app.service.values('decision')).toHaveLength(1);
});

test('lost publication response is reconciled from command history without another submission',async({page,workspace})=>{
  await open(page,workspace);let posts=0;
  await page.route('**/revisions',async route=>{posts++;await route.fetch();await route.abort('failed');});
  await compose(page,'Lost receipt','# Committed despite the lost response');
  await expect(page.locator('#command-list')).toContainText('커밋 확인됨');
  await expect(page.locator('#document-title')).toHaveText('Lost receipt');expect(posts).toBe(1);
});

test('repository source imports only allowlisted files and resumes changed private drafts',async({page,workspace})=>{
  const {writeFileSync}=await import('node:fs');const root=mkdtempSync(join(tmpdir(),'knowledger-source-browser-'));
  const manifest={version:1,source_id:'kb-browser',files:[{path:'guide.md',title:'KB guide',policy_id:'policy-shared-guideline',policy_version:1}]};
  const first='\uFEFF# KB guide\r\n\r\nOriginal bytes.\r\n';
  writeFileSync(join(root,'guide.md'),first);writeFileSync(join(root,'not-allowed.md'),'PRIVATE_EXCLUDED_SOURCE');
  try {
    await page.addInitScript(()=>{const read=File.prototype.arrayBuffer;window.sourceReads=[];File.prototype.arrayBuffer=function(){window.sourceReads.push(this.name);return read.call(this);};});
    await open(page,workspace);
    await page.locator('#source-manifest-file').setInputFiles({name:'source.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(manifest))});
    await expect(page.locator('#source-preview')).toContainText('guide.md');await page.locator('#source-folder').setInputFiles(root);
    await page.locator('#source-import').click();await expect(page.locator('#source-status')).toContainText('완료');
    await expect(page.locator('#private-draft-count')).toHaveText('1');await expect(page.locator('#metric-documents')).toHaveText('0');
    expect(await page.evaluate(()=>window.sourceReads.includes('not-allowed.md'))).toBe(false);
    await page.locator('#source-import').click();await expect(page.locator('#source-status')).toContainText('완료');await expect(page.locator('#private-draft-count')).toHaveText('1');
    writeFileSync(join(root,'guide.md'),'# Changed KB guide');await page.locator('#source-folder').setInputFiles(root);await page.locator('#source-import').click();
    await expect(page.locator('#private-draft-count')).toHaveText('2');await page.locator('#source-detail .source-entry').click();await expect(page.locator('#draft-body')).toHaveValue('# Changed KB guide');
    const events=JSON.stringify(workspace.app.service.ledger.events(0,1000));expect(events).not.toContain('KB guide');expect(events).not.toContain('PRIVATE_EXCLUDED_SOURCE');
    await switchActor(page,'BetaMSP');await expect(page.locator('#source-list')).not.toContainText('kb-browser');await expect(page.locator('#source-preview')).toBeEmpty();
  } finally{rmSync(root,{recursive:true,force:true});}
});

test('Confluence provenance stays private while the imported draft opens for review',async({page,workspace})=>{
  const actor={org_id:'AlphaMSP',actor_id:'maintainer',kind:'human'};
  const cloud='11111111-1111-1111-1111-111111111111';
  await workspace.app.service.importSourceMarkdown(actor,'confluence-browser',{operation_id:'cloud-import',expected_version:0,
    path:'confluence/123.md',title:'Imported cloud guide',policy_id:'policy-shared-guideline',policy_version:1,
    content_base64:Buffer.from('Private imported body').toString('base64'),origin:{kind:'confluence',cloud_id:cloud,page_id:'123',page_version:7,adf_sha256:'a'.repeat(64)}},'confluence');
  await open(page,workspace);await page.locator('#source-list button').filter({hasText:'confluence-browser'}).click();
  await expect(page.locator('#source-detail')).toContainText('Confluence 페이지 123 v7');
  await page.locator('#source-detail .source-entry').click();await expect(page.locator('#draft-body')).toHaveValue('Private imported body');
  await page.getByRole('button',{name:'공유 게시 미리보기 생성',exact:true}).click();
  await expect(page.locator('#preview-section')).not.toContainText(cloud);await expect(page.locator('#preview-section')).not.toContainText('adf_sha256');
  await switchActor(page,'BetaMSP');await expect(page.locator('#source-list')).not.toContainText('confluence-browser');
});

test('source file validation and actor changes stop uploads before any source mutation',async({page,workspace})=>{
  const {writeFileSync}=await import('node:fs');const root=mkdtempSync(join(tmpdir(),'knowledger-source-abort-'));
  const manifest={version:1,source_id:'kb-no-upload',files:[{path:'guide.md',title:'KB guide',policy_id:'policy-shared-guideline',policy_version:1}]};
  writeFileSync(join(root,'guide.md'),Buffer.from([0x41,0x01,0x42]));let uploads=0;
  page.on('request',request=>{if(/\/sources\/.*\/(markdown|reconcile)$/.test(new URL(request.url()).pathname))uploads++;});
  try {
    await open(page,workspace);await page.locator('#source-manifest-file').setInputFiles({name:'source.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(manifest))});
    await expect(page.locator('#source-preview')).toContainText('guide.md');await page.locator('#source-folder').setInputFiles(root);await page.locator('#source-import').click();
    await expect(page.locator('#source-status')).toContainText('중단');expect(uploads).toBe(0);
    writeFileSync(join(root,'guide.md'),'# Private source');await page.locator('#source-folder').setInputFiles(root);
    await page.evaluate(()=>{const read=File.prototype.arrayBuffer;window.sourceReading=false;File.prototype.arrayBuffer=async function(){if(this.name==='guide.md'){window.sourceReading=true;await new Promise(resolve=>window.releaseSourceRead=resolve);}return read.call(this);};});
    await page.locator('#source-import').click();await expect.poll(()=>page.evaluate(()=>window.sourceReading)).toBe(true);
    await switchActor(page,'BetaMSP');await page.evaluate(()=>window.releaseSourceRead());
    await expect(page.locator('#source-preview')).toBeEmpty();await expect(page.locator('#source-list')).not.toContainText('kb-no-upload');expect(uploads).toBe(0);
  } finally{rmSync(root,{recursive:true,force:true});}
});

test('invalid source manifest selection clears the previous selection',async({page,workspace})=>{
  const {writeFileSync}=await import('node:fs');const root=mkdtempSync(join(tmpdir(),'knowledger-manifest-clear-'));writeFileSync(join(root,'guide.md'),'# Guide');
  const manifest={version:1,source_id:'kb-manifest-clear',files:[{path:'guide.md',title:'KB guide',policy_id:'policy-shared-guideline',policy_version:1}]};
  try {
    await open(page,workspace);
    await page.locator('#source-manifest-file').setInputFiles({name:'valid.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(manifest))});
    await expect(page.locator('#source-preview')).toContainText('guide.md');await page.locator('#source-folder').setInputFiles(root);await expect(page.locator('#source-import')).toBeEnabled();
    await page.locator('#source-manifest-file').setInputFiles({name:'oversized.json',mimeType:'application/json',buffer:Buffer.alloc(131073,'x')});
    await expect(page.locator('#source-preview')).toBeEmpty();await expect(page.locator('#source-import')).toBeDisabled();
    await page.locator('#source-manifest-file').setInputFiles([]);await expect(page.locator('#source-preview')).toBeEmpty();await expect(page.locator('#source-import')).toBeDisabled();
  } finally{rmSync(root,{recursive:true,force:true});}
});

test('late source manifest validation cannot restore an earlier selection',async({page,workspace})=>{
  let release;let reached;const gate=new Promise(resolve=>release=resolve);const held=new Promise(resolve=>reached=resolve);let first=true;
  await page.route('**/source-manifests/validate',async route=>{
    if(route.request().method()!=='POST'||!first)return route.continue();
    first=false;const response=await route.fetch();reached();await gate;await route.fulfill({response});
  });
  const manifestA={version:1,source_id:'kb-manifest-a',files:[]};const manifestB={version:1,source_id:'kb-manifest-b',files:[]};
  await open(page,workspace);await page.locator('#source-manifest-file').setInputFiles({name:'a.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(manifestA))});await held;
  await page.locator('#source-manifest-file').setInputFiles({name:'b.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(manifestB))});await expect(page.locator('#source-preview')).toContainText('kb-manifest-b');release();
  await expect(page.locator('#source-preview')).toContainText('kb-manifest-b');await expect(page.locator('#source-preview')).not.toContainText('kb-manifest-a');
});

test('source list loads the next cursor page without losing the first page',async({page,workspace})=>{
  const first={source_id:'source-page-one',version:1,updated_at:'2026-01-01T00:00:00.000Z',present_count:1,removed_count:0};
  const second={source_id:'source-page-two',version:2,updated_at:'2026-01-02T00:00:00.000Z',present_count:2,removed_count:0};
  const cursors=[];
  await page.route('**/sources*',async route=>{
    const url=new URL(route.request().url());
    if(route.request().method()!=='GET'||!url.pathname.endsWith('/sources')) return route.continue();
    cursors.push(url.searchParams.get('cursor'));
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(cursors.length===1?{sources:[first],next_cursor:'source-page-2'}:{sources:[second],next_cursor:null})});
  });
  await open(page,workspace);
  await expect(page.locator('#source-list')).toContainText('source-page-one');
  await expect(page.locator('#more-sources')).toBeVisible();
  await page.locator('#more-sources').click();
  await expect(page.locator('#source-list')).toContainText('source-page-two');
  await expect(page.locator('#source-list')).toContainText('source-page-one');
  await expect(page.locator('#more-sources')).toBeHidden();
  expect(cursors).toEqual([null,'source-page-2']);
});

test('source list paginates more than twenty isolated fixture stores',async({page,workspace})=>{
  const actor={org_id:'AlphaMSP',actor_id:'maintainer',kind:'human'};
  for(let index=0;index<21;index++) {
    await workspace.app.service.importSourceMarkdown(actor,`source-fixture-${String(index).padStart(2,'0')}`,{operation_id:`source-fixture-${index}`,expected_version:0,path:'guide.md',title:`Fixture ${index}`,policy_id:'policy-shared-guideline',policy_version:1,content_base64:Buffer.from(`# Fixture ${index}`).toString('base64')});
  }
  await open(page,workspace);
  await expect(page.locator('#source-list .source-item')).toHaveCount(20);
  await expect(page.locator('#source-list-status')).toContainText('20개');
  await page.locator('#more-sources').click();
  await expect(page.locator('#source-list .source-item')).toHaveCount(21);
  await expect(page.locator('#source-list-status')).toContainText('21개');
  await expect(page.locator('#more-sources')).toBeHidden();
});

test('replacement activation sends the existing active agreement for the slot',async({page,workspace})=>{
  await open(page,workspace);
  await publish(page,'Stable guide','# Stable');
  await page.getByRole('button',{name:'검토 제안 제출',exact:true}).click();
  await switchActor(page,'BetaMSP');await approve(page,workspace);
  await switchActor(page,'AlphaMSP');await approve(page,workspace);
  await activate(page,workspace);
  const active=workspace.app.service.values('agreement').find((agreement)=>agreement.status==='active');expect(active?.agreement_id).toBeTruthy();
  await compose(page,'Replacement guide','# Replacement',{revise:true});
  await page.getByRole('button',{name:'검토 제안 제출',exact:true}).click();
  await switchActor(page,'BetaMSP');await approve(page,workspace);
  await switchActor(page,'AlphaMSP');await approve(page,workspace);
  let body;
  await page.route('**/agreement-proposals/*/activate',async route=>{body=route.request().postDataJSON();await route.continue();});
  await activate(page,workspace);
  expect(body.expected_active_agreement_id).toBe(active.agreement_id);
});

test('revising a compact overview document preserves its verified base digest',async({page,workspace})=>{
  await open(page,workspace);await publish(page,'Base guide','# Base');
  const base=workspace.app.service.values('revision').find((revision)=>revision.payload.title==='Base guide');expect(base?.revision_digest).toBeTruthy();
  await page.getByRole('button',{name:'이 문서의 새 개정본 작성',exact:true}).click();await page.locator('#draft-title').fill('Base guide revised');await page.locator('#draft-body').fill('# Revised');
  let payload;await page.route('**/drafts',async route=>{if(route.request().method()==='POST')payload=route.request().postDataJSON();await route.continue();});
  await page.locator('#save-draft').click();await expect(page.locator('#draft-status')).toContainText('저장됐습니다');expect(payload.base_revision_digest).toBe(base.revision_digest);
});

async function seedBrowseFixture(workspace, { documents = 23, proposals = 23 } = {}) {
  const service = workspace.app.service; const actor = service.definition.bootstrap_actor; const policy = service.definition.genesis.policies[0];
  let target;
  for (let index = 0; index < documents; index++) {
    const draft = await service.draft(actor, { document_id: index ? `browse-doc-${index}` : policy.document_id,
      context_id: policy.context_id, scope_id: policy.scope_id, usage_scope: policy.usage_scope,
      title: index ? `Browse ${index}` : 'Off-page policy document', body_markdown: `# Exact fixture ${index}` });
    const preview = await service.preview(actor, { draft_id: draft.draft_id });
    await service.publish(actor, { preview_id: preview.preview_id, confirm_shared: true, command_id: `browse-publish-${index}` });
    if (!index) target = draft.revision;
  }
  const ids = [];
  for (let index = 0; index < proposals; index++) {
    const proposal = await service.propose(actor, { revision_digest: target.revision_digest, policy_id: policy.policy_id, policy_version: 1, command_id: `browse-proposal-${index}` });
    ids.push(proposal.result.proposal_id);
  }
  return { target, proposalIds: ids };
}

test('document and proposal pages do not overwrite each other and block concurrent page merges', async ({ page, workspace }) => {
  await seedBrowseFixture(workspace);
  await page.goto(workspace.origin); await expect(page.locator('.document-card')).toHaveCount(20);
  await expect(page.locator('.review-inbox-item')).toHaveCount(20);
  await page.locator('#more-proposals').click(); await expect(page.locator('.review-inbox-item')).toHaveCount(23);
  await expect(page.locator('#more-proposals')).toBeHidden();
  await page.locator('#more-documents').click(); await expect(page.locator('.document-card')).toHaveCount(23);
  await expect(page.locator('.review-inbox-item')).toHaveCount(23); await expect(page.locator('#more-proposals')).toBeHidden();
  await page.locator('#refresh-overview').click(); await expect(page.locator('.document-card')).toHaveCount(20);
  let release; const gate = new Promise(resolve => { release = resolve; }); let started;
  const intercepted = new Promise(resolve => { started = resolve; });
  await page.route('**/overview?**', async route => {
    if (new URL(route.request().url()).searchParams.has('cursor')) { started(); await gate; }
    await route.continue();
  });
  try {
    await page.locator('#more-documents').click(); await intercepted;
    await expect(page.locator('#more-proposals')).toBeDisabled();
  } finally { release(); }
  await expect(page.locator('.document-card')).toHaveCount(23);
  await page.locator('#more-proposals').click(); await expect(page.locator('.review-inbox-item')).toHaveCount(23);
});

test('off-page policy draft keeps its parent and a selected old proposal survives refreshed pages', async ({ page, workspace }) => {
  const { target, proposalIds } = await seedBrowseFixture(workspace);
  await page.goto(workspace.origin); await expect(page.locator('.document-card')).toHaveCount(20);
  const lookup = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/documents/doc-shared-guideline') && response.status() === 200);
  await page.getByRole('button', { name: '새 지식 문서 작성', exact: true }).click();
  await (await lookup).finished();
  await page.locator('#draft-title').fill('Off-page revision'); await page.locator('#draft-body').fill('# Changed');
  await page.locator('#save-draft').click(); await expect(page.locator('#draft-status')).toContainText('저장됐습니다');
  const actor = workspace.app.service.definition.bootstrap_actor;
  const saved = (await workspace.app.service.listDrafts(actor, 50)).drafts.find(row => row.title === 'Off-page revision');
  const exact = await workspace.app.service.getDraft(actor, saved.draft_id);
  expect(exact.revision.payload.parents).toEqual([target.revision_digest]);
  await page.reload(); await expect(page.locator('.review-inbox-item')).toHaveCount(20);
  await page.locator('#more-proposals').click(); await expect(page.locator('.review-inbox-item')).toHaveCount(23);
  const oldest = proposalIds[0]; const pageData = await workspace.app.service.overview(workspace.app.service.definition.bootstrap_actor, { proposal_limit: 50 });
  const oldestIndex = pageData.proposals.findIndex(proposal => proposal.proposal_id === oldest);
  await page.locator('.review-inbox-item').nth(oldestIndex).click();
  await expect(page.locator('#document-title')).toHaveText('Off-page policy document');
  await expect(page.locator('#rationale-' + oldest)).toBeVisible();
  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/overview') && response.status() === 200);
  await page.locator('#refresh-overview').click();
  await refreshed; await expect(page.locator('#global-status')).toContainText('최신 상태를 읽었습니다');
  await expect(page.locator('#rationale-' + oldest)).toBeVisible();
  await page.locator('#rationale-' + oldest).fill('Selected exact old proposal');
  await expect(page.locator('#rationale-' + oldest)).toHaveValue('Selected exact old proposal');
  // 이후 개요 재조회를 차단해 지연 재렌더가 입력값을 비우지 않게 한다.
  await page.route('**/overview**', route => route.abort());
  let selectedId; await page.route('**/agreement-proposals/*/decisions', async route => { selectedId = new URL(route.request().url()).pathname.split('/').at(-2); await route.continue(); });
  const approve = page.getByRole('button', { name: '승인', exact: true });
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect.poll(() => selectedId, { timeout: 15000 }).toBe(oldest);
});

test('a newer full revision view overrides the older overview agreement state', async ({ page, workspace }) => {
  const { proposalIds } = await seedBrowseFixture(workspace, { documents: 1, proposals: 1 });
  const service = workspace.app.service; const actor = service.definition.bootstrap_actor; const id = proposalIds[0];
  for (const persona of service.definition.personas) await service.decide({ org_id: persona.org_id, actor_id: persona.actor_id, kind: persona.kind }, id,
    { decision: 'approve', rationale: 'Fixture approval', command_id: `view-approve-${persona.org_id}` });
  const receipt = await service.activate(actor, id, { expected_active_agreement_id: null, command_id: 'view-activate' });
  let changed = false;
  await page.route('**/revisions/*/view?**', async route => {
    if (!changed) { changed = true; await service.changeAgreement(actor, receipt.result.agreement_id, 'withdraw', { reason: 'Changed after overview', command_id: 'view-withdraw' }); }
    await route.continue();
  });
  await page.goto(workspace.origin);
  await expect(page.locator('#document-detail-content')).toContainText('철회됨');
  await expect(page.locator('#review-state-chip')).toContainText('철회됨');
});
