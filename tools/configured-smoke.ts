/** Configured runtime against the existing disposable order-workflow Fabric network. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startDevelopmentIssuer } from '../packages/auth/development-issuer.ts';
import { demoDefinition } from '../examples/order-workflow/config.ts';
import { createConfiguredApp } from '../apps/api/configured-runtime.ts';
import { loadProjectConfiguration } from '../packages/config/project.ts';
import type { ProjectConfiguration } from '../packages/config/types.ts';
import { configuredOutboxFile } from '../apps/api/configured-fabric-runtime.ts';
import { createRuntimeSnapshot, restoreRuntimeSnapshot } from '../packages/storage/runtime-snapshot.ts';
import { OidcTestBrowser } from './oidc-test-browser.ts';
import { KclClient } from '../packages/client/knowledge-client.ts';
import { guardedGeneration } from '../packages/client/guarded-generation.ts';

const root=fileURLToPath(new URL('..',import.meta.url));
mkdirSync(join(root,'.data'),{recursive:true});
const directory=mkdtempSync(join(root,'.data/configured-smoke-'));
const socketPath=join(mkdtempSync('/tmp/kcl-config-sign-'),'sign.sock');
const dataDir=join(directory,'runtime');const run=randomUUID().slice(0,8);
let app:Awaited<ReturnType<typeof createConfiguredApp>>|undefined;
let issuer:Awaited<ReturnType<typeof startDevelopmentIssuer>>|undefined;
let signer:ChildProcess|undefined;
let phase='startup';
const evidence:Record<string,unknown>={mode:'configured-real-fabric',run_id:run,network:'existing-three-organization-example'};
async function freePort(){const server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as {port:number}).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port;}
try {
  const port=await freePort();const origin=`http://127.0.0.1:${port}`;
  issuer=await startDevelopmentIssuer({port:0,redirectUri:`${origin}/auth/callback`,clientId:'configured-client',accounts:[{subject:'configured-reviewer',label:'Configured reviewer'},{subject:'unbound-reviewer',label:'Unbound reviewer'}]});
  const definition=demoDefinition();const actor=definition.personas.find(actor=>actor.org_id==='SalesMSP'&&actor.kind==='human')!;
  const domain='sales.kcl.test';const peerRoot=join(root,'.data/fabric-smoke/crypto/peerOrganizations',domain);
  const msp=join(peerRoot,'users',`User1@${domain}`,'msp');
  const cert=join(msp,'signcerts',`User1@${domain}-cert.pem`);
  const keyFiles=readdirSync(join(msp,'keystore')).filter(name=>name.endsWith('_sk'));assert.equal(keyFiles.length,1);
  const signingConfig=join(directory,'signing-references.json');
  writeFileSync(signingConfig,JSON.stringify({keys:[{key_id:'configured-reviewer-key',certificate_path:cert,private_key_path:join(msp,'keystore',keyFiles[0])}]}),{mode:0o600});
  signer=spawn(process.execPath,['infra/fabric/signing-service.ts','--config',signingConfig,'--socket',socketPath],{cwd:root,stdio:'ignore'});
  for(let attempt=0;!existsSync(socketPath);attempt++){if(signer.exitCode!==null||attempt>50)throw new Error('Signer did not start');await delay(100);}
  const configuration:ProjectConfiguration={version:1,workspace:{...definition.workspace,id:'configured-knowledge',label:'Configured knowledge'},organizations:definition.organizations,
    identities:definition.personas.map(({org_id,actor_id,kind,label})=>({org_id,actor_id,kind,label})),genesis:definition.genesis,bootstrap_actor:definition.bootstrap_actor,
    ledger:{mode:'fabric',channel_id:definition.genesis.channel_id},authentication:{mode:'oidc',issuer:issuer.issuer,client_id:'configured-client',allow_insecure_loopback:true,authorization_version_claim:'account_version',bindings:[{subject:'configured-reviewer',org_id:actor.org_id,actor_id:actor.actor_id}]},
    fabric:{chaincode_name:'kcl',chaincode_version:'0.1.0',identities:definition.personas.filter(actor=>actor.kind==='human').map(identity=>({org_id:identity.org_id,actor_id:identity.actor_id,
      certificate_path:identity.org_id===actor.org_id?cert:'unselected-nonexistent.pem',tls_ca_path:identity.org_id===actor.org_id?join(peerRoot,'peers',`peer0.${domain}`,'tls/ca.crt'):'unselected-tls.pem',
      signer_socket_path:socketPath,peer_endpoint:'127.0.0.1:17051',peer_host_alias:`peer0.${domain}`,key_id:'configured-reviewer-key'}))}};
  const configPath=join(directory,'project.json');writeFileSync(configPath,JSON.stringify(configuration,null,2),{mode:0o600});
  const config=loadProjectConfiguration(configPath);
  app=await createConfiguredApp(config,{dataDir,port,organization:actor.org_id});await app.listen(port);
  const browser=new OidcTestBrowser([origin,issuer.issuer]);let csrf='';
  const login=async()=>{assert.equal((await browser.login(origin,'configured-reviewer')).status,200);const session=await(await browser.request(`${origin}/api/session`)).json();assert.equal(session.actor.org_id,actor.org_id);assert.equal(session.demo,false);assert.equal(session.mode,'fabric');assert.deepEqual(session.personas,[]);csrf=session.csrf_token;};
  const get=async(path:string)=>{const response=await browser.request(`${origin}/v1/workspaces/configured-knowledge${path}`);assert.equal(response.status,200);return response.json();};
  const post=async(path:string,input:unknown,status=200)=>{
    for(let attempt=0;attempt<10;attempt++){
      const response=await browser.request(`${origin}${path.startsWith('/api/')?path:'/v1/workspaces/configured-knowledge'+path}`,{method:'POST',headers:{Origin:origin,'X-KCL-CSRF':csrf,'Content-Type':'application/json'},body:JSON.stringify(input)});
      const value=await response.json();if(response.status===202&&status===200){await delay(300);continue;}assert.equal(response.status,status,`${path}: ${value.code}`);return value;
    }throw new Error('Command stayed pending');
  };
  assert.equal((await browser.request(`${origin}/v1/workspaces/configured-knowledge/overview`)).status,401);
  await login();await post('/api/session',{org_id:actor.org_id,actor_id:actor.actor_id},403);
  phase='publication and agreement';
  const overview=await get('/overview');const candidates=overview.documents.filter((doc:any)=>doc.payload.document_id==='doc-sales-order-definition-001');
  const base=candidates.find((doc:any)=>doc.eligible)??candidates.at(-1);assert.ok(base);
  const sourceInput={operation_id:`source-import-${run}`,expected_version:0,path:`guides/private-source-${run}.md`,policy_id:'policy-sales-v1',policy_version:1,title:`Configured runtime ${run}`,content_base64:Buffer.from(`# Configured shared knowledge ${run}`).toString('base64')};
  const imported=await post('/sources/configured-kb/markdown',sourceInput);
  const draft=await get(`/drafts/${imported.draft_id}`);
  assert.equal((await post('/sources/configured-kb/markdown',sourceInput)).draft_id,imported.draft_id);
  const unchanged=await post('/sources/configured-kb/markdown',{...sourceInput,operation_id:`source-unchanged-${run}`,expected_version:imported.source.version});assert.equal(unchanged.status,'unchanged');
  evidence.source_private_import=true;
  const preview=await post('/publication-previews',{draft_id:draft.draft_id});
  const publish=await post('/revisions',{preview_id:preview.preview_id,confirm_shared:true,command_id:`config-publish-${run}`});
  assert.equal(publish.status,'committed');evidence.publication_checkpoint=publish.checkpoint;
  const tracked=await get(`/commands/config-publish-${run}`);assert.equal(tracked.status,'committed');assert.deepEqual(tracked.checkpoint,publish.checkpoint);
  assert.equal(JSON.stringify(await get('/commands')).includes('Configured shared knowledge'),false);
  const retried=await post(`/commands/config-publish-${run}/retry`,{});assert.deepEqual(retried.checkpoint,publish.checkpoint);
  const proposal=await post('/agreement-proposals',{revision_digest:draft.revision.revision_digest,policy_id:'policy-sales-v1',policy_version:1,command_id:`config-propose-${run}`});
  const approval=await post(`/agreement-proposals/${proposal.result.proposal_id}/decisions`,{decision:'approve',rationale:'Reviewed configured runtime publication',command_id:`config-approve-${run}`});evidence.approval_checkpoint=approval.checkpoint;
  const active=await post(`/agreement-proposals/${proposal.result.proposal_id}/activate`,{expected_active_agreement_id:candidates.find((doc:any)=>doc.eligible)?.agreement.agreement_id??null,command_id:`config-activate-${run}`});
  const scope={document_ids:[base.payload.document_id],context_id:base.payload.context_id,scope_id:base.payload.scope_id,usage_scope:base.payload.usage_scope};
  assert.equal((await post('/resolve',scope)).status,'provided');
  phase='SDK and guarded model release';
  const client=new KclClient({baseUrl:origin,workspaceId:config.workspace.id,fetch:async(input,init)=>browser.request(String(input),init),headers:()=>({Origin:origin,'X-KCL-CSRF':csrf})});
  const selection={...scope,document_ids:[base.payload.document_id] as [string]};
  const validated=await client.resolve(selection);assert.equal(validated.status,'provided');assert.equal(JSON.stringify(validated).includes('private-source-'),false);
  const generated=await guardedGeneration({client,selection,adapterId:'configured-local-stub',authorize:async()=>true,generate:async()=>({draft:'local stub output'})});assert.equal(generated.status,'provided');
  let generatedCalls=0;
  const withheld=await guardedGeneration({client,selection,adapterId:'configured-local-stub',authorize:async({phase})=>{
    if(phase==='release')await post(`/agreements/${active.result.agreement_id}/withdraw`,{reason:'Configured runtime verification completed',command_id:`config-withdraw-${run}`});return true;
  },generate:async()=>{generatedCalls++;return 'must be withheld';}});
  assert.equal(generatedCalls,1);assert.equal(withheld.status,'withheld');assert.equal('output' in withheld,false);
  evidence.sdk_exact_revision=true;evidence.release_authorization_withdrawal_withheld=true;
  assert.equal((await post('/resolve',scope)).status,'withheld');
  issuer.setAccountEnabled('configured-reviewer',false);assert.equal((await browser.request(`${origin}/v1/workspaces/configured-knowledge/overview`)).status,401);issuer.setAccountEnabled('configured-reviewer',true);
  const foreignBrowser=new OidcTestBrowser([origin,issuer.issuer]);assert.equal((await foreignBrowser.login(origin,'unbound-reviewer')).status,403);
  phase='snapshot and restore';
  await app.close();app=undefined;
  const snapshotDir=join(directory,'snapshot');const restoredDir=join(directory,'restored');
  const snapshot=createRuntimeSnapshot({dataDir,snapshotDir});assert.equal(JSON.parse(readFileSync(join(snapshotDir,'manifest.json'),'utf8')).version,3);assert.equal(snapshot.mode,'configured-fabric');
  restoreRuntimeSnapshot({snapshotDir,dataDir:restoredDir});
  app=await createConfiguredApp(config,{dataDir:restoredDir,port,organization:actor.org_id});await app.listen(port);await login();
  assert.equal((await get('/commands')).commands.some((item:any)=>item.command_id===`config-publish-${run}`&&item.status==='committed'),true);
  assert.equal((await get('/sources/configured-kb')).entries[0].draft_id,imported.draft_id);
  assert.equal((await get('/drafts')).total,1);assert.equal((await post('/resolve',scope)).status,'withheld');
  assert.ok(readdirSync(restoredDir).includes(configuredOutboxFile(actor.org_id,actor.actor_id)));
  evidence.checks=['private-source-sync','SDK-exact-revision','generation-release-revalidation','private-command-tracking-and-exact-retry','configured-oidc','unbound-subject-rejected','browser-role-switch-rejected','only-selected-organization-files-opened','generic-key-id-separate-signer','VALID-publication-and-approval','withdrawal-withholds','version3-snapshot-restore-private-draft'];
  writeFileSync(join(directory,'evidence.json'),JSON.stringify(evidence,null,2)+'\n',{mode:0o600});console.log(`Configured Fabric smoke passed. Evidence: ${join(directory,'evidence.json')}`);
} catch(error) {console.error(`Configured Fabric smoke failed during ${phase}: ${error instanceof Error?error.message:'unknown failure'}`);process.exitCode=1;}
finally {await app?.close();await issuer?.close();if(signer&&signer.exitCode===null){const closed=new Promise<void>(resolve=>signer!.once('exit',()=>resolve()));signer.kill('SIGTERM');await closed;}}
