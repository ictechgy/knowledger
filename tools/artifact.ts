import { closeSync, constants, fchmodSync, fsyncSync, lstatSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

// 디렉터리 fsync를 지원하지 않는 플랫폼의 오류 코드 — 이 경우에만 rename의 원자적
// 가시성으로 진행한다. 그 외 I/O 실패는 쓰기 실패로 보고해 조용한 내구성 손실을 막는다.
const UNSUPPORTED_DIR_FSYNC = new Set(['ENOSYS', 'ENOTSUP', 'EINVAL', 'EPERM']);

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
      // 생성 모드는 umask가 비트를 지울 수 있으므로 명시적으로 되돌린다 — 0600 보장은 계약이다.
      fchmodSync(fd, 0o600);
      writeFileSync(fd, `${output}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const dest = lstatSync(path, { throwIfNoEntry: false });
    if (dest && (!dest.isFile() || dest.isSymbolicLink() || dest.nlink !== 1)) throw new Error('--out must be a regular file');
    renameSync(tmp, path);
    try {
      // rename 자체의 크래시 내구성은 디렉터리 fsync가 준다.
      const dirFd = openSync(dirname(path), constants.O_RDONLY);
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    } catch (error) {
      if (!UNSUPPORTED_DIR_FSYNC.has((error as NodeJS.ErrnoException)?.code ?? '')) throw error;
    }
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}
