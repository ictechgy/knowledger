export const MAX_SOURCE_FILES = 100;
export const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
export interface SourceFileMapping { path:string; policy_id:string; policy_version:number; title:string }
export interface MarkdownSourceManifest { version:1; source_id:string; files:SourceFileMapping[] }
export interface SourceEntry extends SourceFileMapping {
  sha256:string; byte_length:number; draft_id:string; revision_digest:string; status:'present'|'removed'; updated_at:string;
}
export interface SourceState { source_id:string; version:number; entries:SourceEntry[]; updated_at:string }
export class SourceInputError extends Error {
  readonly code='INVALID_SOURCE';readonly status=400;readonly retryable=false;
}
export function sourceId(value:unknown):string {
  if(typeof value!=='string'||!/^[A-Za-z][A-Za-z0-9._:-]{2,63}$/.test(value))throw new SourceInputError('올바른 원본 식별자가 필요합니다.');return value;
}
export function sourcePath(value:unknown):string {
  if(typeof value!=='string'||Buffer.byteLength(value)>512||value.includes('\\')||/[\u0000-\u001f\u007f-\u009f]/u.test(value)||value.includes(':')||value.includes('%')
    ||value.split('/').length>10||value.split('/').some(part=>!part||part.startsWith('.')||part.trim()!==part)||! /\.(md|markdown)$/i.test(value))throw new SourceInputError('숨김 경로나 상위 이동이 없는 상대 Markdown 경로가 필요합니다.');return value;
}
export function sourceVersion(value:unknown):number {
  if(!Number.isSafeInteger(value)||Number(value)<0)throw new SourceInputError('올바른 원본 버전이 필요합니다.');return value as number;
}
export function sourceMapping(input:unknown):SourceFileMapping {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new SourceInputError('올바른 파일 연결 설정이 필요합니다.');
  const value=input as Record<string,unknown>;
  if(Object.keys(value).sort().join(',')!=='path,policy_id,policy_version,title'||!Number.isSafeInteger(value.policy_version)||Number(value.policy_version)<1
    ||typeof value.title!=='string'||!value.title.trim()||value.title.length>200||/[\u0000-\u001f\u007f]/.test(value.title))throw new SourceInputError('올바른 파일 연결 설정이 필요합니다.');
  return {path:sourcePath(value.path),policy_id:sourceId(value.policy_id),policy_version:value.policy_version as number,title:value.title};
}
export function validateSourceManifest(input:unknown):MarkdownSourceManifest {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new SourceInputError('올바른 원본 manifest가 필요합니다.');
  const value=input as Record<string,unknown>;
  if(Object.keys(value).sort().join(',')!=='files,source_id,version'||value.version!==1||!Array.isArray(value.files)||value.files.length>MAX_SOURCE_FILES)throw new SourceInputError('지원하는 원본 manifest 형식이 아닙니다.');
  const files=value.files.map(sourceMapping);if(new Set(files.map(file=>file.path)).size!==files.length)throw new SourceInputError('원본 경로가 중복됩니다.');
  return {version:1,source_id:sourceId(value.source_id),files};
}
