import { closeSync, constants, fchmodSync, fstatSync, ftruncateSync, openSync, writeFileSync } from 'node:fs';

/** 증거 아티팩트를 쓴다 — 심볼릭 링크는 O_NOFOLLOW, FIFO는 O_NONBLOCK, 하드링크된 파일은 nlink 검사로 거부하고, 열린 디스크립터가 일반 파일인지 확인한 뒤 항상 0600으로 쓴다. */
export function writeArtifact(path: string, output: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    // 하드링크된 기존 파일은 같은 inode를 truncate·chmod해 다른 경로의 내용을 덮어쓴다 — 단독 링크만 허용한다.
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('--out must be a regular file');
    ftruncateSync(fd, 0);
    fchmodSync(fd, 0o600);
    writeFileSync(fd, `${output}\n`);
  } finally {
    closeSync(fd);
  }
}
