import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { createConfiguredApp } from '../apps/api/configured-runtime.ts';
import { createProjectTemplate } from '../packages/config/template.ts';
import { createDevelopmentClient } from '../packages/connectors/development-client.ts';
import { loadMarkdownSourceManifest,readMarkdownSource } from '../packages/connectors/filesystem-markdown.ts';
import { syncMarkdownSource } from '../packages/connectors/sync-markdown.ts';
import { guardedGeneration } from '../packages/client/guarded-generation.ts';

/** Explicitly fictional local integration example; uses a callback stub and no external model. */
export async function runKbDemo(){
  const directory=mkdtempSync(join(tmpdir(),'knowledger-kb-demo-'));
  const config=createProjectTemplate(['WriterMSP','ReviewerMSP'],'kb-demo');
  const app=await createConfiguredApp(config,{dataDir:directory,port:0,modelEgress:{allows:({adapter_id}:any)=>adapter_id==='example-local-generator'}});
  try{
    const origin=await app.listen(0);
    const writer=await createDevelopmentClient({baseUrl:origin,workspaceId:config.workspace.id,orgId:'WriterMSP',actorId:'maintainer'});
    const reviewer=await createDevelopmentClient({baseUrl:origin,workspaceId:config.workspace.id,orgId:'ReviewerMSP',actorId:'maintainer'});
    const root=fileURLToPath(new URL('../examples/markdown-kb',import.meta.url));
    const snapshot=await readMarkdownSource({root,manifest:loadMarkdownSourceManifest(join(root,'manifest.json'))});
    const initial=app.service.ledger.events(0,1000).length;
    const sync=await syncMarkdownSource(writer,snapshot);
    const noSharedImport=app.service.ledger.events(0,1000).length===initial;
    const repeated=await syncMarkdownSource(writer,snapshot);
    const policy=config.genesis.policies[0];
    const selection={document_ids:[policy.document_id] as [string],context_id:policy.context_id,scope_id:policy.scope_id,usage_scope:policy.usage_scope};
    let modelCalls=0;
    const generate=async()=>{modelCalls++;return 'A local callback drafted a result from approved shared knowledge.';};
    const run=()=>guardedGeneration({client:writer,selection,allowDevelopment:true,adapterId:'example-local-generator',authorize:async()=>true,generate});
    const before=await run();
    const preview=await writer.request('/publication-previews',{method:'POST',body:{draft_id:sync.source.entries[0].draft_id}});
    await writer.request('/revisions',{method:'POST',body:{preview_id:preview.preview_id,confirm_shared:true,command_id:'kb-demo-publish'}});
    const proposed=await writer.request('/agreement-proposals',{method:'POST',body:{revision_digest:preview.revision_digest,policy_id:policy.policy_id,policy_version:policy.policy_version,command_id:'kb-demo-propose'}});
    const proposalId=proposed.result.proposal_id;
    for(const [index,client] of [writer,reviewer].entries())await client.request(`/agreement-proposals/${proposalId}/decisions`,{method:'POST',body:{decision:'approve',rationale:'Fictional human review for this integration example',command_id:`kb-demo-approve-${index}`}});
    const activated=await writer.request(`/agreement-proposals/${proposalId}/activate`,{method:'POST',body:{expected_active_agreement_id:null,command_id:'kb-demo-activate'}});
    const after=await run();
    const withdrawn=await guardedGeneration({client:writer,selection,allowDevelopment:true,adapterId:'example-local-generator',authorize:async()=>true,generate:async()=>{
      modelCalls++;
      await reviewer.request(`/agreements/${activated.result.agreement_id}/withdraw`,{method:'POST',body:{reason:'Simulated revocation during generation',command_id:'kb-demo-withdraw'}});
      return 'This draft must not be released.';
    }});
    const result={mode:'local-simulation',model:'local-callback-stub',imported:sync.counts.imported,repeat_skipped:repeated.counts.skipped,no_shared_write_on_import:noSharedImport,
      before_approval:before.status,after_approval:after.status,withdrawal_during_generation:withdrawn.status,withdrawn_output_returned:'output' in withdrawn,model_calls:modelCalls};
    if(!noSharedImport||sync.counts.imported!==1||repeated.counts.skipped!==1||before.status!=='withheld'||after.status!=='provided'||withdrawn.status!=='withheld'||'output' in withdrawn||modelCalls!==2)throw new Error('KB integration example failed');
    return result;
  }finally{await app.close();rmSync(directory,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{process.stdout.write(JSON.stringify(await runKbDemo(),null,2)+'\n');}catch{process.stderr.write('KB integration example failed.\n');process.exitCode=1;}
}
