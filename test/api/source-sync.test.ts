import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createConfiguredApp } from '../../apps/api/configured-runtime.ts';
import { createProjectTemplate } from '../../packages/config/template.ts';

async function fixture(t:any){
  const directory=mkdtempSync(join(tmpdir(),'kcl-source-api-'));const config=createProjectTemplate(['FirstMSP','SecondMSP'],'source-workspace');
  let app=await createConfiguredApp(config,{dataDir:directory,port:0});let origin=await app.listen(0);let cookie='';let csrf='';
  const login=async()=>{const r=await fetch(origin+'/api/session');cookie=r.headers.get('set-cookie')!.split(';')[0];csrf=(await r.json()).csrf_token;};await login();
  t.after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});});
  const request=async(method:string,path:string,input:any,status=200)=>{
    const r=await fetch(origin+(path==='/api/session'?path:'/v1/workspaces/source-workspace'+path),{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json','X-KCL-CSRF':csrf},...(method==='GET'?{}:{body:JSON.stringify(input)})});
    const value=await r.json();assert.equal(r.status,status,`${method} source API: ${value.code ?? value.status ?? 'response'}`);if(path==='/api/session'&&r.ok)csrf=value.csrf_token;return value;
  };
  return {directory,config,app:()=>app,get:(path:string,status=200)=>request('GET',path,undefined,status),post:(path:string,input:any,status=200)=>request('POST',path,input,status),
    restart:async()=>{await app.close();app=await createConfiguredApp(config,{dataDir:directory,port:0});origin=await app.listen(0);await login();}};
}
const input={operation_id:'sync-first-001',expected_version:0,path:'guides/private-source-canary.md',policy_id:'policy-shared-guideline',policy_version:1,title:'Imported guideline',content_base64:Buffer.from('\uFEFF# Source guideline\r\n\r\nExact bytes.\r\n').toString('base64')};
const source='/sources/repository-guides';

test('source import is private, idempotent and unchanged content creates no new draft',async t=>{
  const api=await fixture(t);const before=api.app().service.ledger.events(0,1000).length;
  const first=await api.post(source+'/markdown',input);assert.equal(first.status,'imported');assert.equal(first.source.version,1);
  assert.deepEqual(await api.post(source+'/markdown',input),first);
  const again=await api.post(source+'/markdown',{...input,operation_id:'sync-again-001',expected_version:1});
  assert.equal(again.status,'unchanged');assert.equal(again.draft_id,first.draft_id);assert.equal(again.source.version,1);
  assert.equal((await api.get('/drafts')).total,1);assert.equal(api.app().service.ledger.events(0,1000).length,before);
  const draft=await api.get('/drafts/'+first.draft_id);assert.equal(draft.revision.payload.body_markdown,Buffer.from(input.content_base64,'base64').toString());
  assert.equal(draft.source.path,input.path);
  const preview=await api.post('/publication-previews',{draft_id:first.draft_id});
  assert.equal(JSON.stringify(preview).includes('private-source-canary'),false);
  await api.post('/revisions',{preview_id:preview.preview_id,confirm_shared:true,command_id:'publish-source-001'});
  assert.equal(JSON.stringify(api.app().service.ledger.events(0,1000)).includes('private-source-canary'),false);
});

test('changed source makes a new draft with shared parent and removing source never withdraws knowledge',async t=>{
  const api=await fixture(t);const first=await api.post(source+'/markdown',input);
  const preview=await api.post('/publication-previews',{draft_id:first.draft_id});const published=await api.post('/revisions',{preview_id:preview.preview_id,confirm_shared:true,command_id:'publish-source-first'});
  const old=await api.get('/drafts/'+first.draft_id);const before=api.app().service.ledger.events(0,1000).length;
  const changed=await api.post(source+'/markdown',{...input,operation_id:'sync-change-001',expected_version:1,content_base64:Buffer.from('# Updated source').toString('base64')});
  assert.notEqual(changed.draft_id,first.draft_id);assert.equal(changed.source.version,2);
  const next=await api.get('/drafts/'+changed.draft_id);assert.deepEqual(next.revision.payload.parents,[old.revision.revision_digest]);
  assert.deepEqual(await api.get('/drafts/'+first.draft_id),old);
  const removed=await api.post(source+'/reconcile',{operation_id:'sync-remove-001',expected_version:2,present_paths:[]});
  assert.equal(removed.source.version,3);assert.equal(removed.removed_count,1);assert.equal(removed.source.entries[0].status,'removed');
  assert.equal(api.app().service.ledger.events(0,1000).length,before);
  assert.equal((await api.get('/overview')).documents[0].revision_digest,old.revision.revision_digest);
});

test('source CAS and operation replay survive restart without exposing another actors source',async t=>{
  const api=await fixture(t);const first=await api.post(source+'/markdown',input);
  await api.restart();assert.deepEqual(await api.post(source+'/markdown',input),first);
  await api.post(source+'/markdown',{...input,operation_id:'sync-stale-001'},409);
  await api.post(source+'/markdown',{...input,title:'Replay changed'},409);
  await api.post('/api/session',{org_id:'SecondMSP',actor_id:'maintainer'});
  assert.deepEqual((await api.get('/sources')).sources,[]);await api.get(source,404);
  await api.post(source+'/reconcile',{operation_id:'sync-guess-001',expected_version:1,present_paths:[]},409);
  await api.get('/drafts/'+first.draft_id,404);
});

test('source state and draft writes roll back atomically if the operation receipt cannot persist',async t=>{
  const api=await fixture(t);const db=new DatabaseSync(join(api.directory,'private-local.sqlite'));
  db.exec("CREATE TRIGGER source_operation_failure BEFORE INSERT ON private_records WHEN NEW.kind='source-operation' BEGIN SELECT RAISE(ABORT,'fixture'); END");db.close();
  await api.post(source+'/markdown',input,500);assert.equal((await api.get('/drafts')).total,0);await api.get(source,404);
});

test('source ingress rejects unsafe paths, unconfigured policies and malformed manifests',async t=>{
  const api=await fixture(t);
  for(const path of ['../secret.md','/secret.md','.env.md','docs/.auth/secret.md','docs\\secret.md','docs/%2e%2e/secret.md','secret.txt'])await api.post(source+'/markdown',{...input,path},400);
  await api.post(source+'/markdown',{...input,policy_id:'unknown-policy'},409);
  await api.post('/source-manifests/validate',{manifest_json:'{"version":1,"version":1}'},400);
  const manifest={version:1,source_id:'repository-guides',files:[{path:input.path,policy_id:input.policy_id,policy_version:1,title:input.title}]};
  assert.deepEqual((await api.post('/source-manifests/validate',{manifest_json:JSON.stringify(manifest)})).manifest,manifest);
  await api.post(source+'/reconcile',{operation_id:'sync-unknown-001',expected_version:0,present_paths:['unknown.md']},400);
});

test('HTTP source import enforces the aggregate 16 MiB limit and preserves the last valid state',async t=>{
  const api=await fixture(t);const large=Buffer.alloc(256*1024,'x').toString('base64');
  for(let i=0;i<64;i++)await api.post(source+'/markdown',{...input,content_base64:large,path:`file-${i}.md`,operation_id:`source-limit-${i}`,expected_version:i});
  await api.post(source+'/markdown',{...input,content_base64:large,path:'too-many-bytes.md',operation_id:'source-limit-overflow',expected_version:64},409);
  assert.equal((await api.get(source)).version,64);assert.equal((await api.get('/drafts')).total,64);
});

test('source IDs survive URL encoding and concurrent writes cannot overwrite the same version',async t=>{
  const api=await fixture(t);const encoded='/sources/repository%3Aguides';
  const first=await api.post(encoded+'/markdown',input);assert.equal(first.source.source_id,'repository:guides');assert.equal((await api.get(encoded)).version,1);
  const actor={org_id:'FirstMSP',actor_id:'maintainer',kind:'human' as const};
  const results=await Promise.allSettled([api.app().service.importSourceMarkdown(actor,'repository:guides',{...input,operation_id:'source-race-a',expected_version:1,content_base64:Buffer.from('# Change A').toString('base64')}),api.app().service.importSourceMarkdown(actor,'repository:guides',{...input,operation_id:'source-race-b',expected_version:1,content_base64:Buffer.from('# Change B').toString('base64')})]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal((await api.get(encoded)).version,2);assert.equal((await api.get('/drafts')).total,2);
});
