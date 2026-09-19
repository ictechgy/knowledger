import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, type Stats } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve, sep } from 'node:path';

// 디렉터리 fsync를 지원하지 않는 플랫폼의 오류 코드 — 이 경우에만 rename의 원자적
// 가시성으로 진행한다. 그 외 I/O 실패는 쓰기 실패로 보고해 조용한 내구성 손실을 막는다.
const UNSUPPORTED_DIR_FSYNC = new Set(['ENOSYS', 'ENOTSUP', 'EINVAL', 'EPERM']);

/** 보호할 입력 — path는 이름·하위 비교용, inode는 읽을 때 확정한 신원 보존용이다. */
export interface ProtectedInput {
  path: string;
  // 읽은 대상의 dev:ino — 있으면 경로 재조회 대신 이 신원으로 비교해 입력이 옮겨져도 본다.
  inode?: string;
}

export interface ArtifactGuard {
  // 대상이 이 입력들과 같은 파일이거나 그 하위면 거부한다 — 저널·관찰 입력 보호용.
  protectedPaths?: ProtectedInput[];
}

/**
 * realpath가 없는 경로 조각은 가장 가까운 기존 조상의 정규 경로 위에 얹어 해석한다.
 * ENOENT·ENOTDIR 외의 실패(권한·링크 루프·I/O)는 추측 경로가 아니라 닫힌 실패로 올린다.
 */
function canonicalPath(p: string): { canonical: string; ancestor: string } {
  const missing: string[] = [];
  for (let current = resolve(p);;) {
    try {
      const real = realpathSync(current);
      return { canonical: join(real, ...missing.reverse()), ancestor: real };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.push(basename(current));
      current = parent;
    }
  }
}

function inodeOf(p: string): string | undefined {
  const stat = lstatSync(p, { throwIfNoEntry: false });
  return stat ? `${stat.dev}:${stat.ino}` : undefined;
}

/**
 * dir이 속한 파일시스템이 대소문자를 접는지 마지막 조각의 다른 철자 조회로 조사한다 —
 * 같은 inode로 풀리면 접는 파일시스템이다. 조사가 불가능하면 접은 것으로 취급해
 * 별칭 우회를 닫는다(대소문자 구분 시스템에서는 다른 파일을 넓게 거부할 뿐이다).
 */
const swapCase = (name: string): string => name.replace(/[a-zA-Z]/g, (ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()));

function foldsCase(dir: string): boolean {
  const stat = lstatSync(dir, { throwIfNoEntry: false });
  const name = basename(dir);
  if (!stat || !name) return true;
  const swapped = swapCase(name);
  if (swapped === name) return true;
  const alt = lstatSync(join(dirname(dir), swapped), { throwIfNoEntry: false });
  return Boolean(alt && alt.dev === stat.dev && alt.ino === stat.ino);
}

/**
 * inode 고정 디렉터리 안에서만 호출한다 — 대상이 보호 경로와 같은 파일(부모 심볼릭
 * 링크 우회·하드링크·대소문자 별칭 포함)이거나 그 하위 경로면 거부한다. 대상의
 * 파일시스템이 대소문자를 접을 때만 철자 비교를 접는다.
 */
function assertNotProtected(targetCanonical: string, targetInode: string | undefined, protectedPaths: ProtectedInput[], fold: (p: string) => string): void {
  const targetFolded = fold(targetCanonical);
  for (const input of protectedPaths) {
    const base = fold(canonicalPath(input.path).canonical);
    if (targetFolded === base || targetFolded.startsWith(`${base}${sep}`)) throw new Error('--out must not overwrite its inputs');
    // 읽을 때 확정한 신원이 있으면 그것을 쓴다 — 입력이 옮겨진 뒤 대상 위치에 놓여도 잡는다.
    const inputInode = input.inode ?? inodeOf(input.path);
    if (targetInode !== undefined && inputInode !== undefined && inputInode === targetInode) throw new Error('--out must not overwrite its inputs');
  }
}

/**
 * 대상이 보호 경로와 충돌하는지 아무것도 만들지 않고 먼저 검사한다 — 디렉터리 생성보다
 * 먼저 호출해 거부된 출력이 보호 경로 위에 디렉터리를 남기지 않게 한다. 이 검사와
 * writeArtifact의 고정 안 재검증이 함께 네임스페이스 경합을 덮는다.
 */
export function assertWritableTarget(path: string, protectedPaths: ProtectedInput[]): void {
  const { canonical, ancestor } = canonicalPath(path);
  const fold = foldsCase(ancestor) ? (p: string) => p.normalize('NFC').toLowerCase() : (p: string) => p;
  assertNotProtected(canonical, inodeOf(canonical), protectedPaths, fold);
}

/**
 * 증거 아티팩트를 원자적으로 쓴다 — 같은 디렉터리의 임시 파일(0600, O_EXCL)에 전체
 * 내용을 쓰고 fsync한 뒤 rename으로 교체하므로, 쓰기 실패·크래시가 기존 아티팩트의
 * 부분 파일을 남기지 않는다. 목적지가 심볼릭 링크·비정규 파일·하드링크된 파일이면
 * rename 전에 거부한다. 대상 디렉터리는 realpath로 고정하고 cwd를 그 inode에 붙든 채
 * basename만 다룬다 — 쓰기 도중 상위 경로가 심볼릭 링크로 바뀌어 rename과 디렉터리
 * fsync가 다른 곳을 가리키는 것을 막는다. 보호 경로 검증도 같은 고정 안에서 수행해
 * 검증과 쓰기가 항상 같은 디렉터리를 본다.
 * 주의: cwd 고정은 Node에서 유일한 이식 가능한 inode 고정 수단이지만 프로세스 전역이다 —
 * 동기 단일 스레드 컨텍스트에서만 호출해야 하며 worker thread와 cwd를 공유해선 안 된다.
 * 출력 디렉터리는 쓰기 중 내용이 바뀌지 않는 신뢰 경로여야 한다 — 검증·게시 사이의
 * 하나의 syscall 간격은 이식 가능한 수단으로 없앨 수 없어 잔여 경합을 탐지해 거부한다.
 */
export function writeArtifact(path: string, output: string, guard?: ArtifactGuard): void {
  const realDir = realpathSync(dirname(path));
  const fileName = basename(path);
  // 임시 이름은 대상 이름 길이와 무관하게 짧게 둔다 — 긴 --out 이름이 임시 생성에서
  // 실패해 검증 없이 끝나지 않게 한다.
  const tmp = `.kcl-artifact-${randomUUID()}.tmp`;
  const cwd = process.cwd();
  // 실제 cwd inode를 '.'로 캡처한다 — 경로명으로 조회하면 이름이 바뀐 대체 디렉터리를
  // 잘못 신원으로 삼을 수 있다.
  const cwdStat = statSync('.');
  // realpath와 chdir 사이의 네임스페이스 변경은 고정된 inode와의 비교로 잡는다 — 하나의
  // syscall 간격만 남는 잔여 창은 이식 가능한 수단으로는 더 좁힐 수 없다.
  const expected = statSync(realDir);
  process.chdir(realDir);
  let failure: unknown;
  // 만든 임시 inode의 신원 — catch의 정리가 이 inode를 나타내는 이름만 지우게 한다.
  let tmpStat: Stats | undefined;
  // 게시 검증을 통과한 뒤의 실패는 게시된 아티팩트를 걷지 않는다 — 이미 교체된 예전
  // 대상은 되돌릴 수 없고, 내구성 보고 실패가 새 아티팩트까지 지우면 둘 다 잃는다.
  let published = false;
  try {
    const pinned = statSync('.');
    if (pinned.dev !== expected.dev || pinned.ino !== expected.ino) throw new Error('--out directory changed during open');
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      // 만든 inode의 신원을 열린 디스크립터에서 바로 확보한다 — 이후 이름이 다른
      // 객체로 바뀌어도 우리 것만 판별·정리한다.
      tmpStat = fstatSync(fd);
      // 생성 모드는 umask가 비트를 지울 수 있으므로 명시적으로 되돌린다 — 0600 보장은 계약이다.
      fchmodSync(fd, 0o600);
      writeFileSync(fd, `${output}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // 닫힌 뒤 임시 이름이 다른 객체로 대체됐을 수 있다 — 만든 inode와 같은지 확인한다.
    const tmpCheck = lstatSync(tmp, { throwIfNoEntry: false });
    if (!tmpCheck || !tmpCheck.isFile() || tmpCheck.dev !== tmpStat.dev || tmpCheck.ino !== tmpStat.ino || tmpCheck.nlink !== 1) {
      throw new Error('--out temporary file was replaced');
    }
    // 대상 파일시스템의 자식 조회가 대소문자를 접는지 임시 파일로 조사한다 — 다른 철자가
    // 같은 inode로 풀리면 접는 파일시스템이다(부모 디렉터리 조회가 아닌 실제 쓰기 위치).
    const tmpAlt = lstatSync(swapCase(tmp), { throwIfNoEntry: false });
    const fold = tmpAlt && tmpAlt.dev === tmpStat.dev && tmpAlt.ino === tmpStat.ino
      ? (p: string) => p.normalize('NFC').toLowerCase()
      : (p: string) => p;
    const dest = lstatSync(fileName, { throwIfNoEntry: false });
    if (guard?.protectedPaths?.length) {
      // 고정된 inode의 현재 경로로 검증한다 — 붙든 뒤 디렉터리가 옮겨져도 검증 대상이
      // 옛 경로 문자열에 남지 않는다.
      assertNotProtected(join(realpathSync('.'), fileName), dest ? `${dest.dev}:${dest.ino}` : undefined, guard.protectedPaths, fold);
    }
    if (dest && (!dest.isFile() || dest.isSymbolicLink() || dest.nlink !== 1)) throw new Error('--out must be a regular file');
    // 게시 직전 고정 디렉터리와 임시·대상 신원을 다시 확인한다 — 하나의 syscall
    // 간격의 잔여 창만 남긴다. 대상이 검증과 다른 inode로 바뀌면 rename이 외부
    // 객체를 지우므로 거부한다 — 출력 디렉터리는 쓰기 중 바뀌지 않는 신뢰 경로여야 한다.
    const repin = statSync('.');
    if (repin.dev !== expected.dev || repin.ino !== expected.ino) throw new Error('--out directory changed during write');
    const tmpFinal = lstatSync(tmp, { throwIfNoEntry: false });
    if (!tmpFinal || !tmpFinal.isFile() || tmpFinal.dev !== tmpStat.dev || tmpFinal.ino !== tmpStat.ino || tmpFinal.nlink !== 1) {
      throw new Error('--out temporary file was replaced');
    }
    const destFinal = lstatSync(fileName, { throwIfNoEntry: false });
    if (destFinal?.dev !== dest?.dev || destFinal?.ino !== dest?.ino) throw new Error('--out changed during write');
    renameSync(tmp, fileName);
    // 게시된 객체가 쓴 inode인지 확인한다 — 재검증과 rename 사이의 잔여 창에서 이름이
    // 대체돼도 대상 경로에 외부 객체를 남기지 않고 닫힌 실패로 둔다.
    const publishedCheck = lstatSync(fileName, { throwIfNoEntry: false });
    if (!publishedCheck || !publishedCheck.isFile() || publishedCheck.dev !== tmpStat.dev || publishedCheck.ino !== tmpStat.ino || publishedCheck.nlink !== 1) {
      // 대상에 놓인 것이 우리 inode가 아니면 절대 지우지 않는다 — 경합자가 놓은 파일이나
      // 디렉터리일 수 있어 거부만 하고 그대로 둔다.
      throw new Error('--out was replaced during publish');
    }
    published = true;
    try {
      // rename 자체의 크래시 내구성은 디렉터리 fsync가 준다 — 같은 inode를 가리키는 '.'을 연다.
      const dirFd = openSync('.', constants.O_RDONLY);
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    } catch (error) {
      if (!UNSUPPORTED_DIR_FSYNC.has((error as NodeJS.ErrnoException)?.code ?? '')) throw error;
    }
  } catch (error) {
    failure = error;
    // 정리는 우리가 만든 inode를 나타내는 이름만 지운다 — 임시 이름은 rename 후 비어
    // 있을 수 있고 대상 이름은 우리 inode로 게시됐다가 대체됐을 수 있다. 이름이 다른
    // 객체로 대체됐으면 경합자의 파일을 지우지 않고 그대로 둔다. 정리 실패는 원
    // 오류를 가리지 않는다.
    try {
      for (const name of published ? [tmp] : [tmp, fileName]) {
        const leftover = lstatSync(name, { throwIfNoEntry: false });
        if (leftover && tmpStat && leftover.isFile() && leftover.dev === tmpStat.dev && leftover.ino === tmpStat.ino) rmSync(name, { force: true });
      }
    } catch { /* 복귀와 원 오류를 우선한다 */ }
  }
  // 원래 inode로 복귀했는지 확인한다 — 대체된 디렉터리로의 복귀나 조용한 실패를 표면화한다.
  try { process.chdir(cwd); } catch { try { process.chdir(realpathSync(cwd)); } catch { /* 복귀 시도 계속 */ } }
  let restored = false;
  try {
    const now = statSync('.');
    restored = now.dev === cwdStat.dev && now.ino === cwdStat.ino;
  } catch { /* 복귀 확인 불가 */ }
  // 복귀 실패를 먼저 던진다 — cwd는 프로세스 전역이므로 오염된 상태로 계속 도는 것보다
  // 원 쓰기 오류를 cause로 싣고 복귀 실패를 우선 보고한다.
  if (!restored) throw new Error('작업 디렉터리 복귀에 실패했습니다.', { cause: failure });
  if (failure) throw failure;
}
