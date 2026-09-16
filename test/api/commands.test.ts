import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDemoApp } from '../../examples/order-workflow/application.ts';
import { PERSONAS, demoFixtures, actorIdentity } from '../../examples/order-workflow/config.ts';

async function fixture(t:any){
  const dataDir=mkdtempSync(join(tmpdir(),'knowledger-command-test-'));let app=await createDemoApp({dataDir});let origin=await app.listen(0);let cookie='';let csrf='';
  const session=async()=>{const r=await fetch(origin+'/api/session');cookie=r.headers.get('set-cookie')!.split(';')[0];csrf=(await r.json()).csrf_token;};await session();
  t.after(async()=>{await app.close();rmSync(dataDir,{recursive:true,force:true});});
  const get=async(path:string,status=200)=>{const r=await fetch(origin+'/v1/workspaces/demo'+path,{headers:{Cookie:cookie}});const value=await r.json();assert.equal(r.status,status,JSON.stringify(value));return value;};
  const post=async(path:string,input:any,status=200)=>{const r=await fetch(origin+(path==='/api/session'?path:'/v1/workspaces/demo'+path),{method:'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json','X-KNOWLEDGER-CSRF':csrf},body:JSON.stringify(input)});const value=await r.json();assert.equal(r.status,status,JSON.stringify(value));if(path==='/api/session'&&r.ok)csrf=value.csrf_token;return value;};
  return {get,post,app:()=>app,restart:async()=>{await app.close();app=await createDemoApp({dataDir});origin=await app.listen(0);await session();}};
}
const proposal='proposal-review-invitation-001';
const input={decision:'approve',rationale:'PRIVATE_COMMAND_RATIONALE',command_id:'command-tracked-approval'};

test('command history and detail are actor-private, bounded and do not reveal original inputs',async t=>{
  const api=await fixture(t);
  const result=await api.post(`/agreement-proposals/${proposal}/decisions`,input);
  const page=await api.get('/commands?limit=1');assert.equal(page.commands.length,1);
  assert.equal(page.commands[0].status,'committed');assert.equal(page.commands[0].command_id,input.command_id);
  assert.equal(JSON.stringify(page).includes(input.rationale),false);assert.equal(JSON.stringify(page).includes('request_digest'),false);
  const status=await api.get(`/commands/${input.command_id}`);assert.deepEqual(status.checkpoint,result.checkpoint);
  await api.post('/api/session',{org_id:PERSONAS[2].org_id,actor_id:PERSONAS[2].actor_id});
  assert.equal((await api.get('/commands')).commands.length,0);
  await api.get(`/commands/${input.command_id}`,404);await api.post(`/commands/${input.command_id}/retry`,{},404);
  await api.get('/commands?limit=51',400);await api.get('/commands?limit=1&limit=2',400);
});

test('pending commands survive restart and status queries never resubmit; explicit retry reuses exact command',async t=>{
  const api=await fixture(t);const ledger=api.app().service.ledger;const execute=ledger.execute.bind(ledger);let calls=0;
  ledger.execute=async(actor,command)=>{calls++;return {status:'pending',command_id:command.command_id,tx_id:'pending-test',payload_digest:'a'.repeat(64)};};
  await api.post(`/agreement-proposals/${proposal}/decisions`,input,202);
  assert.equal((await api.get(`/commands/${input.command_id}`)).status,'pending');assert.equal(calls,1);
  ledger.execute=execute;await api.restart();
  assert.equal((await api.get('/commands')).commands[0].status,'pending');
  const before=api.app().service.ledger.events(0,1000).length;
  const retried=await api.post(`/commands/${input.command_id}/retry`,{});
  assert.equal(retried.status,'committed');assert.equal(api.app().service.ledger.events(0,1000).length,before+1);
  assert.deepEqual((await api.post(`/commands/${input.command_id}/retry`,{})).checkpoint,retried.checkpoint);
  assert.equal(api.app().service.ledger.events(0,1000).length,before+1);
  assert.equal((await api.get(`/commands/${input.command_id}`)).status,'committed');
  await api.post(`/commands/${input.command_id}/retry`,{input:{decision:'object'}},400);
});

test('rejected preflight and unavailable status are not reported as committed',async t=>{
  const api=await fixture(t);
  await api.post(`/agreement-proposals/${proposal}/activate`,{command_id:'command-rejected-activate',expected_active_agreement_id:null},409);
  const rejected=await api.get('/commands/command-rejected-activate');assert.equal(rejected.status,'rejected');assert.equal(rejected.code,'APPROVAL_INCOMPLETE');
  const ledger=api.app().service.ledger;const refresh=ledger.refresh.bind(ledger);ledger.refresh=async()=>{throw new Error('peer unavailable');};
  await api.get('/commands',503);ledger.refresh=refresh;
});

test('command pagination handles equal timestamps and rejects another actors cursor',async t=>{
  const api=await fixture(t);
  for(let i=0;i<3;i++)await api.post(`/agreement-proposals/${proposal}/decisions`,{...input,command_id:`command-page-${i}`});
  const first=await api.get('/commands?limit=2');assert.equal(first.commands.length,2);assert.ok(first.next_cursor);
  const second=await api.get('/commands?limit=2&cursor='+first.next_cursor);assert.equal(second.commands.length,1);
  assert.equal(new Set([...first.commands,...second.commands].map((c:any)=>c.command_id)).size,3);
  await api.post('/api/session',{org_id:PERSONAS[2].org_id,actor_id:PERSONAS[2].actor_id});await api.get('/commands?cursor='+first.next_cursor,404);
});

test('same-organization different actor cannot claim a conflicting ledger receipt',async t=>{
  const api=await fixture(t);const service=api.app().service;
  const human=actorIdentity(PERSONAS[1]);const agent=actorIdentity(PERSONAS[3]);
  assert.equal(human.org_id,agent.org_id);
  await api.post(`/agreement-proposals/${proposal}/decisions`,input);
  const command=service.vault.get('command',input.command_id,human);
  service.vault.put('command',input.command_id,agent,command);
  await api.post('/api/session',{org_id:agent.org_id,actor_id:agent.actor_id});
  await api.get(`/commands/${input.command_id}`,409);
});
