import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectTemplate } from '../../packages/config/template.ts';
import { LocalVectorIndex } from '../../packages/storage/vector-index.ts';
import { createDevelopmentClient } from '../../packages/connectors/development-client.ts';
import { evaluateRetrieval } from '../../packages/measurement/retrieval.ts';

test('configured applications use the supplied embedding pair and index, including close ownership', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'knowledger-config-vector-')); t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const config = createProjectTemplate(); const index = new LocalVectorIndex(); let queries = 0; let revisions = 0; let closed = false;
  index.close = () => { closed = true; };
  const app = await createConfiguredApp(config, { dataDir, port: 0, vectorIndex: index,
    embedQuery: () => { queries++; return [1, 0]; }, embedRevision: () => { revisions++; return [1, 0]; } });
  try {
    const policy = config.genesis.policies[0]; const actor = config.bootstrap_actor;
    const draft = await app.service.draft(actor, { document_id: policy.document_id, context_id: policy.context_id, scope_id: policy.scope_id, usage_scope: policy.usage_scope, title: 'Embedding fixture', body_markdown: '# Shared' });
    const preview = await app.service.preview(actor, { draft_id: draft.draft_id });
    await app.service.publish(actor, { preview_id: preview.preview_id, confirm_shared: true, command_id: 'embedding-publish' });
    await app.service.rebuildVectorIndex(actor, {});
    const result = await app.service.vectorSearch(actor, { query: 'meaning', limit: 1 });
    assert.equal(result.results[0].revision_digest, draft.revision.revision_digest);
    assert.equal(revisions, 1); assert.equal(queries, 1);
    const client = await createDevelopmentClient({ baseUrl: await app.listen(0), workspaceId: config.workspace.id, orgId: actor.org_id, actorId: actor.actor_id });
    const report = await evaluateRetrieval(client, [{ id: 'case-unapproved', query: 'meaning', context_id: policy.context_id, scope_id: policy.scope_id, usage_scope: policy.usage_scope,
      relevant_revision_digests: [draft.revision.revision_digest], use: { document_ids: [policy.document_id], expected_status: 'withheld' } }], 1, { allowDevelopment: true });
    assert.equal(report.mean_reciprocal_rank_at_k, 1); assert.equal(report.status_accuracy, 1);
  } finally { await app.close(); }
  assert.equal(closed, true);
});
import { createConfiguredApp } from '../../apps/api/configured-runtime.ts';
import { createDemoApp } from '../../examples/order-workflow/application.ts';

for (const orgs of [['OrionMSP','VegaMSP'], ['ResearchMSP','ReviewMSP','DeliveryMSP','AuditMSP']]) {
  test(`configured ${orgs.length}-organization API starts empty and requires every configured representative`, async t => {
    const dataDir = mkdtempSync(join(tmpdir(), 'knowledger-configured-api-'));
    const config = createProjectTemplate(orgs,'custom-workspace');
    const app = await createConfiguredApp(config, {dataDir,port:0});
    t.after(async()=>{await app.close();rmSync(dataDir,{recursive:true,force:true});});
    const origin = await app.listen(0);
    const first = await fetch(`${origin}/api/session`);
    const cookie = first.headers.get('set-cookie')!.split(';')[0];
    let session:any = await first.json();
    assert.equal(session.demo,false);
    assert.equal(session.workspace.id,'custom-workspace');
    assert.deepEqual(session.personas.map((p:any)=>p.org_id),orgs);
    const base = `${origin}/v1/workspaces/custom-workspace`;
    let n=0;
    const post=async(path:string,input:any,status=200)=>{
      const response=await fetch(path==='/api/session'?`${origin}${path}`:base+path,{method:'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json','X-KNOWLEDGER-CSRF':session.csrf_token},body:JSON.stringify(input)});
      const value:any=await response.json(); assert.equal(response.status,status,`${path}: ${value.code}`);
      if(path==='/api/session'&&response.ok) session=value;
      return value;
    };
    const overview:any=await (await fetch(base+'/overview',{headers:{Cookie:cookie}})).json();
    assert.deepEqual(overview.documents,[]);assert.deepEqual(overview.proposals,[]);
    assert.equal((await fetch(`${origin}/v1/workspaces/demo/overview`,{headers:{Cookie:cookie}})).status,404);
    await post('/api/session',{actor_id:'maintainer'},400);
    await post('/api/session',{org_id:'UnknownMSP',actor_id:'maintainer'},404);
    const policy=config.genesis.policies[0];
    const draft=await post('/drafts',{document_id:policy.document_id,context_id:policy.context_id,scope_id:policy.scope_id,usage_scope:policy.usage_scope,title:'Shared guideline',body_markdown:'# Shared knowledge',source_kind:'human_authored'});
    await post('/api/session',{org_id:orgs[1],actor_id:'maintainer'});
    await post('/publication-previews',{draft_id:draft.draft_id},404);
    await post('/api/session',{org_id:orgs[0],actor_id:'maintainer'});
    const preview=await post('/publication-previews',{draft_id:draft.draft_id});
    assert.deepEqual([...preview.recipients].sort(),[...orgs].sort());
    await post('/revisions',{preview_id:preview.preview_id,confirm_shared:true,command_id:`command-publish-${++n}`});
    const proposal=await post('/agreement-proposals',{revision_digest:draft.revision.revision_digest,policy_id:policy.policy_id,policy_version:1,command_id:`command-propose-${++n}`});
    const proposalId=proposal.result.proposal_id;
    const resolveInput={document_ids:[policy.document_id],context_id:policy.context_id,scope_id:policy.scope_id,usage_scope:policy.usage_scope};
    assert.equal((await post('/resolve',resolveInput)).status,'withheld');
    for(const org_id of orgs){
      await post(`/agreement-proposals/${proposalId}/activate`,{expected_active_agreement_id:null,command_id:`command-activate-${++n}`},409);
      await post('/api/session',{org_id,actor_id:'maintainer'});
      await post(`/agreement-proposals/${proposalId}/decisions`,{decision:'approve',rationale:'Reviewed this revision',command_id:`command-approve-${++n}`});
    }
    await post(`/agreement-proposals/${proposalId}/activate`,{expected_active_agreement_id:null,command_id:`command-activate-${++n}`});
    const packet=await post('/resolve',resolveInput);
    assert.equal(packet.status,'provided');assert.equal(packet.manifest.approval_decisions.length,orgs.length);
  });
}

test('configured storage pins authority, allows label changes and rejects demo reuse',async t=>{
  const dataDir=mkdtempSync(join(tmpdir(),'knowledger-config-restart-'));
  t.after(()=>rmSync(dataDir,{recursive:true,force:true}));
  const config=createProjectTemplate();
  const first=await createConfiguredApp(config,{dataDir,port:0});await first.close();
  config.workspace.label='Renamed';
  const reopened=await createConfiguredApp(config,{dataDir,port:0});await reopened.close();
  await assert.rejects(createDemoApp({dataDir}),/project configuration/);
  const { createRuntimeSnapshot, restoreRuntimeSnapshot }=await import('../../packages/storage/runtime-snapshot.ts');
  const snapshotDir=`${dataDir}-snapshot`, restoredDir=`${dataDir}-restored`;
  t.after(()=>{rmSync(snapshotDir,{recursive:true,force:true});rmSync(restoredDir,{recursive:true,force:true});});
  assert.equal(createRuntimeSnapshot({dataDir,snapshotDir}).mode,'configured-local');
  restoreRuntimeSnapshot({snapshotDir,dataDir:restoredDir});
  const restored=await createConfiguredApp(config,{dataDir:restoredDir,port:0});await restored.close();
  config.genesis.identities[0].can_propose=false;
  await assert.rejects(createConfiguredApp(config,{dataDir,port:0}),/bound|binding|scope/i);
});

test('configured HTTPS proxy origin pins Host and Origin and ignores forwarded headers',async t=>{
  const { createApp }=await import('../../apps/api/server.ts');
  const { applicationDefinition }=await import('../../packages/config/project.ts');
  const dataDir=mkdtempSync(join(tmpdir(),'knowledger-origin-test-'));
  const authentication:any={mode:'oidc',origin:'https://knowledge.example',handle:async()=>false,session:async()=>undefined,run:async(_s:any,fn:any)=>fn(),assertCurrentActor:async()=>{},close:()=>{}};
  const app=await createApp({dataDir,definition:applicationDefinition(createProjectTemplate()),authentication,publicOrigin:authentication.origin});
  t.after(async()=>{await app.close();rmSync(dataDir,{recursive:true,force:true});});
  await app.listen(0);const port=(app.server.address() as {port:number}).port;const origin=`http://127.0.0.1:${port}`;
  const { request }=await import('node:http');
  const status=(headers:Record<string,string>)=>new Promise<number|undefined>((resolve,reject)=>{const req=request(origin+'/api/session',{headers},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();});
  assert.equal(await status({Host:'knowledge.example',Origin:'https://knowledge.example'}),200);
  assert.equal(await status({Host:'other.example','X-Forwarded-Host':'knowledge.example'}),403);
  assert.equal(await status({Host:'knowledge.example',Origin:'https://other.example'}),403);
  assert.equal(await status({Host:'knowledge.example','X-Forwarded-Host':'other.example'}),200);
});

test('createConfiguredApp forwards the modelEgress policy to the service', async t => {
  const config = createProjectTemplate(['OrionMSP','VegaMSP'], 'custom-workspace');
  // 전달 누락이면 서비스 생성자 검증에 도달하지 않아 부팅이 성공한다 — 거부가 전달을 증명한다.
  const rejectedDir = mkdtempSync(join(tmpdir(), 'knowledger-configured-egress-reject-'));
  t.after(()=>rmSync(rejectedDir,{recursive:true,force:true}));
  await assert.rejects(createConfiguredApp(config, { dataDir: rejectedDir, port: 0, modelEgress: { require_adapter: 'yes' as any } }), TypeError);
  const dataDir = mkdtempSync(join(tmpdir(), 'knowledger-configured-egress-'));
  const app = await createConfiguredApp(config, { dataDir, port: 0, modelEgress: { policy_version: 7, allows: () => true } });
  t.after(async()=>{await app.close();rmSync(dataDir,{recursive:true,force:true});});
  assert.ok(app.service);
});
