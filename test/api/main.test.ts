import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('incomplete authentication flags fail before any unauthenticated runtime is created', t => {
  const directory = mkdtempSync(join(tmpdir(), 'kcl-auth-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const flags of [['--oidc-development-issuer'], ['--oidc-development-issuer', '', '--signer-socket', '']]) {
    const result = spawnSync(process.execPath, ['apps/api/main.ts', '--data', directory, ...flags], { encoding: 'utf8', timeout: 1000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /OIDC development requires/);
    assert.equal(existsSync(join(directory, 'shared-ledger.sqlite')), false);
  }
});
