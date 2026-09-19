import { closeSync, constants, fsyncSync, lstatSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

/**
 * 증거 아티팩트를 원자적으로 쓴다 — 같은 디렉터리의 임시 파일(0600, O_EXCL)에 전체
 * 내용을 쓰고 fsync한 뒤 rename으로 교체하므로, 쓰기 실패·크래시가 기존 아티팩트의
 * 부분 파일을 남기지 않는다. 목적지가 심볼릭 링크·비정규 파일·하드링크된 파일이면
 * rename 전에 거부한다.
 */
export function writeArtifact(path: string, output: string): void {
  const tmp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      writeFileSync(fd, `${output}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const dest = lstatSync(path, { throwIfNoEntry: false });
    if (dest && (!dest.isFile() || dest.isSymbolicLink() || dest.nlink !== 1)) throw new Error('--out must be a regular file');
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}
