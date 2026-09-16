import { test as base, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfiguredApp } from '../../../apps/api/configured-runtime.ts';
import { createProjectTemplate } from '../../../packages/config/template.ts';

const test=base.extend({workspace:async({},use)=>{
  const dataDir=mkdtempSync(join(tmpdir(),'kcl-browser-'));const config=createProjectTemplate(['AlphaMSP','BetaMSP'],'browser-workspace');
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
async function approve(page){await page.getByRole('textbox',{name:'이번 결정의 근거'}).fill('Browser test human review');await page.getByRole('button',{name:'승인',exact:true}).click();await expect(page.locator('#review-inbox-count')).toHaveText('0');}

test('two-organization publication, private isolation, approvals, provided context and withdrawal',async({page,workspace})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));await open(page,workspace);
  await publish(page,'Shared guide','# Shared guide\n\nReviewed by two organizations.');
  await expect(page.locator('#revision-compare-content')).toContainText('이전 개정본');
  await page.getByRole('button',{name:'검토 제안 제출',exact:true}).click();await expect(page.locator('#review-inbox-count')).toHaveText('1');
  await approve(page);await switchActor(page,'BetaMSP');await expect(page.locator('#private-draft-list')).not.toContainText('Shared guide');
  await approve(page);await page.getByRole('button',{name:'합의 활성화',exact:true}).click();
  await expect(page.locator('.document-card')).toContainText('합의 활성');
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
