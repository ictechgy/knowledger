import { validateRefreshedManifest } from './knowledge-client.ts';
import type { ResolveSelection, ValidatedResolveResponse, KclClient } from './knowledge-client.ts';

export interface GenerationAuthorizationContext { phase:'generate'|'release'; manifest:any; adapterId:string }
export interface GuardedGenerationOptions<T> {
  client:Pick<KclClient,'resolve'|'revalidate'>;
  selection:ResolveSelection;
  allowDevelopment?:boolean;
  authorize:(context:GenerationAuthorizationContext)=>Promise<boolean>;
  adapterId:string;
  generate:(input:{documents:any[];manifest:any;signal?:AbortSignal})=>Promise<T>;
  signal?:AbortSignal;
  timeoutMs?:number;
}
export type GuardedGenerationResult<T>={status:'provided';output:T;manifest:any}|{status:'withheld';reason:string};
const withheld=(reason:string):{status:'withheld';reason:string}=>({status:'withheld',reason:/^[A-Z][A-Z0-9_]{1,63}$/.test(reason)?reason:'KNOWLEDGE_UNAVAILABLE'});

/** The adapter drafts only. Permission callbacks and fresh fences gate both egress and release. */
export async function guardedGeneration<T>(options:GuardedGenerationOptions<T>):Promise<GuardedGenerationResult<T>> {
  if(typeof options.authorize!=='function')throw new TypeError('authorize callback is required');
  if(typeof options.generate!=='function')throw new TypeError('generate callback is required');
  if(typeof options.adapterId!=='string'||!/^[A-Za-z][A-Za-z0-9._:-]{2,127}$/.test(options.adapterId))throw new TypeError('adapterId is required');
  const timeoutMs=options.timeoutMs??120_000;
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>600_000)throw new TypeError('timeoutMs must be between 1 and 600000');
  if(options.signal?.aborted)return withheld('GENERATION_CANCELLED');
  const controller=new AbortController();let timedOut=false;
  const onAbort=()=>controller.abort();options.signal?.addEventListener('abort',onAbort,{once:true});
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);
  const signal=controller.signal;
  const run=async<V>(operation:()=>Promise<V>):Promise<V>=>{
    if(signal.aborted)throw new Error('Cancelled');
    let listener:()=>void=()=>{};
    const aborted=new Promise<never>((_,reject)=>{listener=()=>reject(new Error('Cancelled'));signal.addEventListener('abort',listener,{once:true});});
    const work=Promise.resolve().then(()=>{if(signal.aborted)throw new Error('Cancelled');return operation();});
    try{return await Promise.race([work,aborted]);}finally{signal.removeEventListener('abort',listener);}
  };
  let phase='KNOWLEDGE_UNAVAILABLE';
  try {
    const result=await run(()=>options.client.resolve(options.selection,{allowDevelopment:options.allowDevelopment,signal}));
    if(result.status!=='provided'||!('revision' in result))return withheld(typeof result.reason==='string'?result.reason:'KNOWLEDGE_UNAVAILABLE');
    const resolved=result as ValidatedResolveResponse;let manifest=structuredClone(resolved.manifest);
    phase='AUTHORIZATION_UNAVAILABLE';
    if(await run(()=>options.authorize({phase:'generate',manifest:structuredClone(manifest),adapterId:options.adapterId}))!==true)return withheld('AUTHORIZATION_DENIED');
    phase='REVALIDATION_UNAVAILABLE';
    const before=await run(()=>options.client.revalidate(manifest.run_id,{signal}));
    if(before?.status!=='valid')return withheld(before?.reason??'KNOWLEDGE_CHANGED');
    try{manifest=structuredClone(validateRefreshedManifest(manifest,before.refreshed_manifest));}catch{return withheld('MANIFEST_CHANGED');}
    phase='GENERATION_FAILED';
    const output=await run(()=>options.generate({documents:structuredClone(resolved.documents),manifest:structuredClone(manifest),signal}));
    phase='AUTHORIZATION_UNAVAILABLE';
    if(await run(()=>options.authorize({phase:'release',manifest:structuredClone(manifest),adapterId:options.adapterId}))!==true)return withheld('AUTHORIZATION_DENIED');
    phase='RELEASE_UNAVAILABLE';
    const after=await run(()=>options.client.revalidate(manifest.run_id,{signal}));
    if(after?.status!=='valid')return withheld(after?.reason??'KNOWLEDGE_CHANGED');
    try{manifest=structuredClone(validateRefreshedManifest(manifest,after.refreshed_manifest));}catch{return withheld('MANIFEST_CHANGED');}
    if(signal.aborted)return withheld(timedOut?'TIMEOUT':'GENERATION_CANCELLED');
    return {status:'provided',output,manifest};
  }catch{return withheld(timedOut?'TIMEOUT':signal.aborted?'GENERATION_CANCELLED':phase);}
  finally{clearTimeout(timer);options.signal?.removeEventListener('abort',onAbort);}
}
