import { createHash } from 'node:crypto';
import { canonicalize, validateRevision } from '../domain/index.ts';
import type { Actor } from '../domain/index.ts';
import type { PrivateStore } from '../storage/private-store.ts';
import { decodeMarkdownImport } from '../import/markdown.ts';
import { MAX_SOURCE_FILES, MAX_SOURCE_BYTES, sourceId,sourcePath,sourceVersion,sourceMapping } from './source-contract.ts';
import type { SourceState,SourceEntry,SourceFileMapping } from './source-contract.ts';

export class SourceStoreError extends Error {
  readonly code:string;readonly status:number;readonly retryable:boolean;
  constructor(code:string,status:number){super(status===404?'원본을 찾을 수 없거나 접근할 수 없습니다.':status===409?'원본 버전 또는 같은 작업 ID의 내용이 달라졌습니다. 다시 확인해 주세요.':'비공개 원본 기록을 확인할 수 없습니다.');this.code=code;this.status=status;this.retryable=status===503;}
}
const iso=(value:unknown)=>typeof value==='string'&&value.length<=40&&Number.isFinite(Date.parse(value));
export function validateSourceState(value:any,id?:string):SourceState {
  try {
    if(!value||Object.keys(value).sort().join(',')!=='entries,source_id,updated_at,version'||sourceId(value.source_id)!==(id??value.source_id)||sourceVersion(value.version)<1||!iso(value.updated_at)||!Array.isArray(value.entries)||value.entries.length>MAX_SOURCE_FILES*2)throw new Error('Invalid source');
    const seen=new Set<string>();
    for(const entry of value.entries){
      if(!entry||Object.keys(entry).sort().join(',')!=='byte_length,draft_id,path,policy_id,policy_version,revision_digest,sha256,status,title,updated_at')throw new Error('Invalid entry');
      sourceMapping({path:entry.path,title:entry.title,policy_id:entry.policy_id,policy_version:entry.policy_version});sourceId(entry.draft_id);
      if(seen.has(entry.path)||!['present','removed'].includes(entry.status)||!iso(entry.updated_at)||!Number.isSafeInteger(entry.byte_length)||entry.byte_length<1||entry.byte_length>256*1024||!/^sha256:[a-f0-9]{64}$/.test(entry.revision_digest)||!/^[a-f0-9]{64}$/.test(entry.sha256))throw new Error('Invalid entry');seen.add(entry.path);
    }
    const present=value.entries.filter((entry:SourceEntry)=>entry.status==='present');
    if(present.length>MAX_SOURCE_FILES||present.reduce((sum:number,entry:SourceEntry)=>sum+entry.byte_length,0)>MAX_SOURCE_BYTES)throw new Error('Source limit');
    return value;
  }catch{throw new SourceStoreError('PRIVATE_SOURCE_CORRUPT',503);}
}

/** Source state is private bookkeeping. No operation here submits to the shared ledger. */
export class SourceStore {
  private vault:PrivateStore;
  constructor(vault:PrivateStore){this.vault=vault;}
  get(actor:Actor,id:string):SourceState|undefined {
    sourceId(id);
    try {const value=this.vault.get('source',id,actor);return value===undefined?undefined:validateSourceState(value,id);}
    catch{throw new SourceStoreError('PRIVATE_SOURCE_CORRUPT',503);}
  }
  list(actor:Actor,limit=20,cursor?:string){
    let page;
    try{page=this.vault.sourcePage(actor,limit,cursor);}catch{throw new SourceStoreError('PRIVATE_SOURCE_CORRUPT',503);}
    if(!page)throw new SourceStoreError('NOT_FOUND',404);
    return {sources:page.values.map(value=>{const state=validateSourceState(value);return {source_id:state.source_id,version:state.version,updated_at:state.updated_at,present_count:state.entries.filter(e=>e.status==='present').length,removed_count:state.entries.filter(e=>e.status==='removed').length};}),next_cursor:page.nextCursor};
  }
  private operation(actor:Actor,id:string,input:any,kind:string,perform:(state:SourceState|undefined)=>any){
    sourceId(id);sourceId(input.operation_id);sourceVersion(input.expected_version);
    const operationId='source-op-'+createHash('sha256').update(JSON.stringify([id,input.operation_id])).digest('hex').slice(0,48);
    const requestDigest=createHash('sha256').update(canonicalize({kind,source_id:id,input})).digest('hex');
    return this.vault.atomic(()=>{
      const receipt=this.vault.get('source-operation',operationId,actor);
      if(receipt){
        if(receipt.request_digest!==requestDigest)throw new SourceStoreError('IDEMPOTENCY_CONFLICT',409);
        const result=receipt.result;validateSourceState(result?.source,id);
        const keys=Object.keys(result).sort().join(',');
        if(kind==='markdown' ? keys!=='draft_id,source,status'||!['imported','unchanged'].includes(result.status)||!result.source.entries.some((entry:SourceEntry)=>entry.draft_id===result.draft_id&&entry.path===input.path)
          : keys!=='removed_count,source,status'||result.status!=='reconciled'||!Number.isSafeInteger(result.removed_count)||result.removed_count<0)throw new SourceStoreError('PRIVATE_SOURCE_CORRUPT',503);
        return result;
      }
      const state=this.get(actor,id);
      if((state?.version??0)!==input.expected_version)throw new SourceStoreError('SOURCE_VERSION_CONFLICT',409);
      const result=perform(state);
      validateSourceState(result.source,id);
      this.vault.saveSource(id,actor,result.source);
      this.vault.put('source-operation',operationId,actor,{request_digest:requestDigest,result});
      return result;
    });
  }
  importMarkdown(actor:Actor,id:string,input:any,build:(mapping:SourceFileMapping,content:string)=>{draft_id:string;revision:any}){
    const mapping=sourceMapping({path:input.path,policy_id:input.policy_id,policy_version:input.policy_version,title:input.title});
    const decoded=decodeMarkdownImport(mapping.path.split('/').at(-1),input.content_base64);
    return this.operation(actor,id,input,'markdown',state=>{
      const before=state?.entries.find(entry=>entry.path===mapping.path);
      const unchanged=before&&before.sha256===decoded.sha256&&before.title===mapping.title&&before.policy_id===mapping.policy_id&&before.policy_version===mapping.policy_version;
      let draft_id:string;let revision:any;
      if(unchanged){
        const draft=this.vault.get('draft',before.draft_id,actor);
        try{revision=validateRevision(draft?.revision);if(revision.payload.body_markdown!==decoded.content||revision.payload.title!==mapping.title||revision.revision_digest!==before.revision_digest||revision.payload.metadata.author_org_id!==actor.org_id||revision.payload.metadata.author_id!==actor.actor_id)throw new Error('Invalid source draft');}
        catch{throw new SourceStoreError('PRIVATE_SOURCE_CORRUPT',503);}
        draft_id=before.draft_id;
      }else{
        const built=build(mapping,decoded.content);draft_id=built.draft_id;revision=built.revision;
        this.vault.put('draft',draft_id,actor,{revision,import:{kind:'local_markdown',filename:decoded.filename,byte_length:decoded.byteLength,sha256:decoded.sha256},source:{source_id:id,path:mapping.path,policy_id:mapping.policy_id,policy_version:mapping.policy_version}});
      }
      if(unchanged&&before.status==='present')return {status:'unchanged',source:state!,draft_id};
      const now=new Date().toISOString();let entries=[...(state?.entries??[])];
      if(!before&&entries.length>=MAX_SOURCE_FILES*2)entries=entries.filter(entry=>entry.status!=='removed');
      if(!before&&entries.length>=MAX_SOURCE_FILES*2)throw new SourceStoreError('SOURCE_LIMIT',409);
      const entry:SourceEntry={...mapping,sha256:decoded.sha256,byte_length:decoded.byteLength,draft_id,revision_digest:revision.revision_digest,status:'present',updated_at:now};
      entries=entries.filter(item=>item.path!==mapping.path);entries.push(entry);
      const present=entries.filter(item=>item.status==='present');
      if(present.length>MAX_SOURCE_FILES||present.reduce((sum,item)=>sum+item.byte_length,0)>MAX_SOURCE_BYTES)throw new SourceStoreError('SOURCE_LIMIT',409);
      return {status:unchanged?'unchanged':'imported',source:{source_id:id,version:(state?.version??0)+1,entries,updated_at:now},draft_id};
    });
  }
  reconcile(actor:Actor,id:string,input:any){
    if(!Array.isArray(input.present_paths)||input.present_paths.length>MAX_SOURCE_FILES)throw new SourceStoreError('INVALID_SOURCE',400);
    const present=new Set(input.present_paths.map(sourcePath));if(present.size!==input.present_paths.length)throw new SourceStoreError('INVALID_SOURCE',400);
    return this.operation(actor,id,input,'reconcile',state=>{
      if([...present].some(path=>!state?.entries.some(entry=>entry.path===path&&entry.status==='present')))throw new SourceStoreError('INVALID_SOURCE',400);
      const now=new Date().toISOString();let removed_count=0;let changed=!state;
      const entries=(state?.entries??[]).flatMap(entry=>{
        if(present.has(entry.path))return [entry];
        if(entry.status==='removed')return [entry];
        changed=true;removed_count++;return [{...entry,status:'removed' as const,updated_at:now}];
      });
      return {status:'reconciled',source:{source_id:id,version:(state?.version??0)+(changed?1:0),entries,updated_at:changed?now:state!.updated_at},removed_count};
    });
  }
}
