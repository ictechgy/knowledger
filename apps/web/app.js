import { compareRevisions, RevisionComparisonError } from './revision-diff.js';

let apiBase = '';

const state = {
  session: null,
  overview: null,
  selectedDocumentKey: null,
  selectedRevisionDigest: null,
  selectedProposalId: null,
  compareRevisionDigest: null,
  draft: null,
  draftBaseDigest: null,
  composerVersion: 0,
  markdownImportRequest: null,
  draftSourceId: null,
  draftEditRequest: null,
  privateDrafts: { drafts: [], total: 0, next_cursor: null },
  draftListVersion: 0,
  commands: { commands: [], next_cursor: null },
  commandListVersion: 0,
  commandPollTimer: null,
  commandPollBusy: false,
  commandPollDelay: 5000,
  commandPollToken: 0,
  sources: { sources: [] },
  sourceDetail: null,
  sourceManifest: null,
  sourceFiles: new Map(),
  sourceListVersion: 0,
  sourceOperationVersion: 0,
  sourceBusy: false,
  sourceBusyVersion: null,
  sourceFolderSelected: false,
  commandPollOffset: 0,
  commandInFlight: new Map(),
  commandUnavailable: new Set(),
  activeSpace: 'documents',
};

const el = (id) => document.getElementById(id);
const text = (node, value) => { if (node) node.textContent = value == null ? '' : String(value); };
const setValue = (node, value) => { if (node) node.value = value == null ? '' : String(value); };
const shortDigest = (value) => value ? `${value.slice(0, 19)}…${value.slice(-8)}` : '—';
const nowCommand = () => `command-${crypto.randomUUID()}`;
const validId = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/.test(value);
function setApiBase(workspace) {
  const id = workspace?.id;
  if (!validId(id)) throw new Error('워크스페이스 식별자를 확인할 수 없습니다.');
  apiBase = `/v1/workspaces/${encodeURIComponent(id)}`;
}
const formatDate = (value) => {
  if (!value) return '날짜 없음';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium' }).format(date);
};

function renderMode(mode, authMode = null) {
  const fabric = mode === 'fabric' || mode === 'fabric-test-network';
  if (authMode) {
    const loginLabel = authMode === 'oidc-development' ? '계정 로그인 · 개발 환경' : '계정 로그인';
    text(el('environment-label'), fabric ? `Fabric · ${loginLabel}` : loginLabel);
    text(el('mode-note-title'), fabric ? `Fabric · ${loginLabel}` : loginLabel);
    text(el('mode-note-copy'), authMode === 'oidc-development'
      ? ' — 개발용 로그인 서버의 테스트 계정을 사용합니다. 로그인한 계정으로 승인·철회를 요청합니다.'
      : ' — 확인된 조직 계정으로만 공유 지식과 합의 작업을 사용할 수 있습니다.');
    return;
  }
  text(el('environment-label'), fabric ? 'Fabric 테스트 원장' : '로컬 시뮬레이션');
  text(el('mode-note-title'), fabric ? 'Fabric 테스트 네트워크 · 가상 사용자' : '로컬 시뮬레이션');
  text(el('mode-note-copy'), fabric
    ? ' — 가상 조직 사용자로 실제 Fabric 테스트 원장에 문서를 게시하고 승인·철회할 수 있습니다.'
    : ' — 이 화면의 상태는 개발용 로컬 원장 어댑터에서 옵니다. 실제 Fabric VALID 커밋이나 운영 독립성을 증명하지 않습니다.');
}

function showStatus(message, tone = 'success') {
  const node = el('global-status');
  text(node, message);
  node.dataset.tone = tone;
  node.hidden = false;
  window.clearTimeout(showStatus.timer);
  if (tone !== 'error' && tone !== 'pending') showStatus.timer = window.setTimeout(() => { node.hidden = true; }, 6500);
}

function clearStatus() { const node = el('global-status'); if (node) node.hidden = true; }

async function request(path, options = {}) {
  const { sessionGuard, ...fetchOptions } = options;
  if (sessionGuard && sessionGuard !== state.session) { const error = new Error('이전 계정의 요청 결과를 버렸습니다.'); error.status = 401; error.stale = true; throw error; }
  const headers = new Headers(fetchOptions.headers || {});
  headers.set('Accept', 'application/json');
  if (fetchOptions.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (fetchOptions.method && fetchOptions.method !== 'GET' && state.session?.csrf_token) headers.set('X-KCL-CSRF', state.session.csrf_token);
  let response;
  try {
    response = await fetch(path, { ...fetchOptions, headers, credentials: 'same-origin', redirect: 'error' });
  } catch {
    throw new Error('서버에 연결할 수 없습니다. 로컬 API가 실행 중인지 확인한 뒤 다시 시도하세요.');
  }
  const raw = await response.text();
  let body = null;
  if (raw) { try { body = JSON.parse(raw); } catch { body = null; } }
  if (!response.ok) {
    if ((response.status === 401 || (state.session?.auth_mode && ['AUTHORIZATION_REVOKED', 'AUTHORIZATION_REQUIRED', 'SESSION_EXPIRED'].includes(body?.code))) && (!sessionGuard || sessionGuard === state.session)) {
      const authMode = state.session?.auth_mode;
      state.session = null;
      state.overview = null;
      if (authMode) renderAuthState({ auth_mode: authMode, actor: null, login_url: '/auth/login' });
      else { state.selectedDocumentKey = null; state.selectedRevisionDigest = null; state.selectedProposalId = null; resetComposer(); clearPrivateDrafts(); clearCommands(); renderOverview(); }
    }
    const apiError = body && body.code ? `${body.code}: ${body.message || '요청이 거절되었습니다.'}` : `요청 실패 (${response.status})`;
    const error = new Error(apiError);
    error.api = body;
    error.status = response.status;
    throw error;
  }
  if (response.status === 202) {
    const error = new Error(body?.message || '요청이 접수됐지만 아직 VALID 커밋으로 확인되지 않았습니다.');
    error.api = body;
    error.status = response.status;
    error.pending = true;
    throw error;
  }
  return body || {};
}

async function loadSession() {
  const session = await request('/api/session');
  state.session = session;
  if (session.workspace) { setApiBase(session.workspace); text(el('workspace-label'), session.workspace.label); }
  renderAuthState(session);
  renderMode(session.mode, session.auth_mode);
  const picker = el('persona-select');
  picker.replaceChildren();
  (session.personas || []).forEach((persona) => {
    const option = document.createElement('option');
    option.value = JSON.stringify({ org_id: persona.org_id, actor_id: persona.actor_id });
    option.textContent = persona.label || `${organizationLabel(persona.org_id)} · ${persona.actor_id}`;
    option.selected = persona.org_id === session.actor?.org_id && persona.actor_id === session.actor?.actor_id;
    picker.append(option);
  });
  picker.disabled = !(session.personas || []).length;
  text(el('footer-actor'), session.actor ? `${session.actor.org_id} · ${session.actor.actor_id}` : '검토자 없음');
}

function renderAuthState(session) {
  const authenticatedMode = Boolean(session?.auth_mode);
  const anonymous = authenticatedMode && !session.actor;
  const controls = el('auth-controls');
  const picker = el('persona-select')?.closest('.persona-picker');
  const login = el('login-link');
  const logout = el('logout-button');
  const authRequired = el('auth-required');
  const requiredLink = el('auth-required-link');
  if (controls) controls.hidden = !authenticatedMode;
  if (picker) picker.hidden = authenticatedMode;
  if (login) {
    login.hidden = !anonymous;
    login.href = typeof session?.login_url === 'string' && session.login_url.startsWith('/auth/login') ? session.login_url : '/auth/login';
  }
  if (requiredLink) requiredLink.href = login?.href || '/auth/login';
  if (logout) logout.hidden = !authenticatedMode || anonymous;
  text(el('auth-actor'), session?.actor ? `${session.actor.org_id} · ${session.actor.actor_id}` : '로그인 필요');
  if (authRequired) authRequired.hidden = !anonymous;
  document.querySelector('.page-intro')?.toggleAttribute('hidden', anonymous);
  document.querySelector('.metric-grid')?.toggleAttribute('hidden', anonymous);
  document.querySelector('.workspace-layout')?.toggleAttribute('hidden', anonymous);
  el('refresh-overview')?.toggleAttribute('hidden', anonymous);
  if (anonymous) {
    state.overview = null;
    state.selectedDocumentKey = null;
    state.selectedRevisionDigest = null;
    state.selectedProposalId = null;
    state.compareRevisionDigest = null;
    resetComposer();
    clearPrivateDrafts();
    clearSourceState();
    clearCommands();
    renderOverview();
    const result = el('resolver-result');
    if (result) { result.replaceChildren(); result.hidden = true; }
    el('resolver-form')?.reset();
    text(el('resolver-status'), '로그인 후 다시 조회해 주세요.');
    text(el('footer-actor'), '로그인 필요');
  }
}

function clearPrivateDrafts() {
  state.draftListVersion++;
  state.privateDrafts = { drafts: [], total: 0, next_cursor: null };
  el('private-draft-list').replaceChildren();
  text(el('private-draft-count'), '—');
  text(el('private-draft-status'), '');
  el('more-drafts').hidden = true;
  el('refresh-drafts').disabled = false;
}

function clearSourceState() {
  state.sourceListVersion++;
  state.sourceOperationVersion++;
  state.sources = { sources: [] };
  state.sourceDetail = null;
  state.sourceManifest = null;
  state.sourceFiles = new Map();
  state.sourceBusy = false; state.sourceBusyVersion = null;
  state.sourceFolderSelected = false;
  if (el('source-manifest-file')) el('source-manifest-file').value = '';
  if (el('source-folder')) el('source-folder').value = '';
  el('source-preview')?.replaceChildren();
  el('source-list')?.replaceChildren();
  el('source-detail')?.replaceChildren();
  text(el('source-status'), '');
  text(el('source-count'), '—');
  el('source-import')?.toggleAttribute('disabled', true);
  if (el('source-manifest-file')) el('source-manifest-file').disabled = false;
  if (el('source-folder')) el('source-folder').disabled = false;
}

function sourceStatusLabel(status) { return status === 'present' ? '동기화에서 확인됨' : '동기화에서 누락'; }

function renderSources() {
  const list = el('source-list');
  if (!list) return;
  list.replaceChildren();
  const sources = state.sources.sources || [];
  text(el('source-count'), sources.length);
  if (!sources.length) { const empty = document.createElement('li'); empty.className = 'empty-state'; empty.textContent = '가져온 저장소가 없습니다.'; list.append(empty); return; }
  sources.forEach((source) => {
    const item = document.createElement('li'); const button = document.createElement('button'); button.type = 'button'; button.className = 'source-item';
    const title = document.createElement('strong'); title.textContent = source.source_id;
    const meta = document.createElement('span'); meta.textContent = `버전 ${source.version} · 현재 ${source.present_count ?? 0} · 없음 ${source.removed_count ?? 0}`;
    button.append(title, meta); button.addEventListener('click', () => loadSourceDetail(source.source_id)); item.append(button); list.append(item);
  });
}

async function loadSources() {
  if (!state.session?.actor || !apiBase) { renderSources(); return; }
  const session = state.session; const version = ++state.sourceListVersion;
  try {
    const page = await request(`${apiBase}/sources`, { sessionGuard: session });
    if (session !== state.session || version !== state.sourceListVersion) return;
    state.sources = page; renderSources();
  } catch (error) { if (session === state.session && version === state.sourceListVersion) text(el('source-status'), `저장소 목록을 불러오지 못했습니다. ${error.message}`); }
}

async function loadSourceDetail(sourceId) {
  const session = state.session; const version = ++state.sourceListVersion;
  try {
    const detail = await request(`${apiBase}/sources/${encodeURIComponent(sourceId)}`, { sessionGuard: session });
    if (session !== state.session || version !== state.sourceListVersion) return;
    state.sourceDetail = detail; renderSourceDetail();
  } catch (error) {
    if (error.status === 404 && session === state.session && version === state.sourceListVersion) { state.sourceDetail = { source_id: sourceId, version: 0, entries: [] }; renderSourceDetail(); return; }
    if (session === state.session && version === state.sourceListVersion) text(el('source-status'), `저장소 상세를 불러오지 못했습니다. ${error.message}`);
  }
}

function renderSourceDetail() {
  const detail = el('source-detail');
  if (!detail || !state.sourceDetail) return;
  detail.replaceChildren();
  const heading = document.createElement('h3'); heading.textContent = `${state.sourceDetail.source_id} · 버전 ${state.sourceDetail.version}`; detail.append(heading);
  (state.sourceDetail.entries || []).forEach((entry) => { const row = document.createElement('button'); row.type = 'button'; row.className = 'source-entry'; row.textContent = `${entry.path} · ${entry.title || '제목 없음'} · ${sourceStatusLabel(entry.status)}`; row.addEventListener('click', () => { if (entry.draft_id) openSavedDraft(entry.draft_id); }); detail.append(row); });
}

function selectedManifestFile() { return el('source-manifest-file')?.files?.[0] || null; }

async function readSourceManifest() {
  const file = selectedManifestFile();
  if (!file) { text(el('source-status'), 'manifest JSON 파일을 선택하세요.'); return; }
  if (file.size > 131072) { text(el('source-status'), 'manifest JSON은 128 KiB 이하여야 합니다.'); return; }
  const version = ++state.sourceOperationVersion; const session = state.session;
  state.sourceManifest = null; state.sourceDetail = null; state.sourceFiles = new Map(); renderSourcePreview(); renderSourceDetail(); el('source-import')?.toggleAttribute('disabled', true);
  try {
    const manifestJson = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
    if (version !== state.sourceOperationVersion || session !== state.session) return;
    const result = await request(`${apiBase}/source-manifests/validate`, { method: 'POST', body: jsonBody({ manifest_json: manifestJson }), sessionGuard: session });
    if (version !== state.sourceOperationVersion || session !== state.session) return;
    state.sourceManifest = result.manifest; state.sourceFiles = new Map();
    renderSourcePreview();
    renderSelectedSourceFiles();
    await loadSourceDetail(state.sourceManifest.source_id);
    if(version===state.sourceOperationVersion&&session===state.session)renderSelectedSourceFiles();
  } catch (error) { if (version === state.sourceOperationVersion && session === state.session) text(el('source-status'), `manifest를 확인하지 못했습니다. ${error.message}`); }
}

function renderSourcePreview() {
  const preview = el('source-preview'); preview.replaceChildren();
  const manifest = state.sourceManifest; if (!manifest) return;
  const heading = document.createElement('p'); heading.className = 'form-hint'; heading.textContent = `${manifest.source_id} · ${manifest.files.length}개 파일 · 아래 목록에 있는 파일만 읽습니다.`; preview.append(heading);
  manifest.files.forEach((entry) => { const row = document.createElement('div'); row.className = 'source-preview-row'; row.textContent = `${entry.path} · ${entry.title || '제목 없음'} · ${entry.policy_id} v${entry.policy_version}`; preview.append(row); });
  text(el('source-status'), 'manifest가 확인됐습니다. 폴더를 선택한 뒤 비공개 가져오기를 누르세요.');
}

function selectedSourceFiles() {
  const files = [...(el('source-folder')?.files || [])];
  const allowed = new Map((state.sourceManifest?.files || []).map((entry) => [entry.path, entry]));
  const selected = new Map();
  files.forEach((file) => { const relative = file.webkitRelativePath || file.name; const parts = relative.split('/'); const path = parts.length > 1 ? parts.slice(1).join('/') : relative; if (allowed.has(path)) selected.set(path, { file, entry: allowed.get(path) }); });
  return selected;
}

function renderSelectedSourceFiles() {
  const selected = selectedSourceFiles(); const manifest = state.sourceManifest;
  if (!manifest) return;
  state.sourceFiles = selected;
  const missing = manifest.files.length - selected.size;
  text(el('source-selection-status'), manifest.files.length === 0 ? 'manifest에 파일이 없습니다. 선택한 폴더를 비공개로 동기화하면 기존 누락 파일을 정리합니다.' : `${selected.size}/${manifest.files.length}개 파일 선택됨 · 누락 ${missing}개${missing === manifest.files.length ? ' · 모든 파일이 누락되었습니다.' : ''}`);
  const enabled = !state.sourceBusy && state.sourceFolderSelected && state.sourceDetail?.source_id === manifest.source_id;
  el('source-import')?.toggleAttribute('disabled', !enabled);
  text(el('source-import'), manifest.files.length === 0 || missing > 0 ? '비공개 동기화' : '선택 파일을 비공개로 가져오기');
}

async function importSourceFiles() {
  const manifest = state.sourceManifest; if (!manifest) return;
  const selected = selectedSourceFiles(); if (!state.sourceFolderSelected) { text(el('source-status'), '원본 폴더를 선택하세요. 누락 파일만 있어도 비공개 동기화를 실행할 수 있습니다.'); return; }
  if (state.sourceBusy) return;
  state.sourceBusy = true; el('source-manifest-file').disabled = true; el('source-folder').disabled = true; el('source-import').disabled = true;
  const session = state.session; const version = ++state.sourceOperationVersion; state.sourceBusyVersion = version;
  try {
    let removedCount = 0;
    let detail = state.sourceDetail?.source_id === manifest.source_id ? state.sourceDetail : null;
    if (!detail) throw new Error('저장소의 현재 버전을 확인하지 못했습니다. 다시 확인한 뒤 시도하세요.');
    const payloads = [];
    let totalBytes = 0;
    for (const entry of manifest.files) {
      const chosen = selected.get(entry.path); if (!chosen) continue;
      if (version !== state.sourceOperationVersion || session !== state.session) return;
      const bytes = new Uint8Array(await chosen.file.arrayBuffer());
      if (version !== state.sourceOperationVersion || session !== state.session) return;
      if (bytes.byteLength === 0 || bytes.byteLength > 262144) throw new Error(`${entry.path} 파일은 비어 있지 않은 256 KiB 이하 UTF-8 Markdown이어야 합니다.`);
      totalBytes += bytes.byteLength; if (totalBytes > 16 * 1024 * 1024) throw new Error('선택한 Markdown 파일의 합계가 16 MiB를 초과합니다.');
      try { const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); if (!content.length || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(content)) throw new Error('Invalid Markdown'); } catch { throw new Error('선택한 파일이 올바른 UTF-8 Markdown이 아닙니다.'); }
      let binary = ''; for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      payloads.push({ entry, content_base64: btoa(binary) });
    }
    if (version !== state.sourceOperationVersion || session !== state.session) return;
    const present = new Set((detail.entries || []).filter((entry) => entry.status === 'present').map((entry) => entry.path));
    const retained = [...present].filter((path) => selected.has(path));
    if (detail.version > 0 && detail.entries) {
      const reconciled = await request(`${apiBase}/sources/${encodeURIComponent(manifest.source_id)}/reconcile`, { method: 'POST', body: jsonBody({ operation_id: `source-${crypto.randomUUID()}`, expected_version: detail.version, present_paths: retained }), sessionGuard: session });
      if (version !== state.sourceOperationVersion || session !== state.session) return;
      detail = reconciled.source; state.sourceDetail = detail; removedCount += reconciled.removed_count || 0;
    }
    for (const payload of payloads) {
      if (version !== state.sourceOperationVersion || session !== state.session) return;
      const result = await request(`${apiBase}/sources/${encodeURIComponent(manifest.source_id)}/markdown`, { method: 'POST', body: jsonBody({ operation_id: `source-${crypto.randomUUID()}`, expected_version: detail.version, path: payload.entry.path, policy_id: payload.entry.policy_id, policy_version: payload.entry.policy_version, title: payload.entry.title, content_base64: payload.content_base64 }), sessionGuard: session });
      if (version !== state.sourceOperationVersion || session !== state.session) return;
      detail = result.source; state.sourceDetail = detail;
    }
    const result = await request(`${apiBase}/sources/${encodeURIComponent(manifest.source_id)}/reconcile`, { method: 'POST', body: jsonBody({ operation_id: `source-${crypto.randomUUID()}`, expected_version: detail.version, present_paths: [...selected.keys()] }), sessionGuard: session });
    if (version !== state.sourceOperationVersion || session !== state.session) return;
    state.sourceDetail = result.source; renderSourceDetail(); await loadSources(); await loadPrivateDrafts();
    if(version===state.sourceOperationVersion&&session===state.session)text(el('source-status'), `비공개 가져오기를 완료했습니다. ${removedCount + (result.removed_count || 0)}개 파일은 원본 없음으로 표시됐습니다.`);
  } catch (error) {
    if (version === state.sourceOperationVersion && session === state.session) { text(el('source-status'), `비공개 가져오기를 중단했습니다. ${error.message} 이미 저장된 파일은 유지됩니다. 상태를 다시 확인한 뒤 같은 요청을 재시도하세요.`); await loadSourceDetail(manifest.source_id); }
  } finally {
    if (state.sourceBusyVersion === version && session === state.session) { state.sourceBusy = false; state.sourceBusyVersion = null; el('source-manifest-file').disabled = false; el('source-folder').disabled = false; renderSelectedSourceFiles(); }
  }
}

function renderPrivateDrafts() {
  const list = el('private-draft-list'); list.replaceChildren();
  text(el('private-draft-count'), state.privateDrafts.total);
  for (const draft of state.privateDrafts.drafts) {
    const item = document.createElement('li');
    const button = document.createElement('button'); button.type = 'button';
    const title = document.createElement('strong'); title.textContent = draft.title;
    const details = document.createElement('span');
    const origin = draft.source_kind === 'approved_import' ? '가져온 문서' : draft.source_kind === 'llm_drafted' ? 'AI 초안' : '작성한 초안';
    details.textContent = `${formatDate(draft.created_at)} · ${origin}`;
    button.append(title, details); button.addEventListener('click', () => openSavedDraft(draft.draft_id));
    item.append(button); list.append(item);
  }
  if (!state.privateDrafts.drafts.length) {
    const item = document.createElement('li'); item.className = 'form-hint'; item.textContent = '저장한 비공개 초안이 없습니다.'; list.append(item);
  }
  el('more-drafts').hidden = !state.privateDrafts.next_cursor;
}

async function loadPrivateDrafts(append = false) {
  if (!state.session?.actor) { clearPrivateDrafts(); return; }
  const session = state.session; const version = ++state.draftListVersion;
  const cursor = append ? state.privateDrafts.next_cursor : null;
  text(el('private-draft-status'), '내 초안을 불러오는 중…');
  el('refresh-drafts').disabled = true; el('more-drafts').disabled = true;
  try {
    const page = await request(`${apiBase}/drafts?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { sessionGuard: session });
    if (version !== state.draftListVersion || session !== state.session) return;
    const drafts = append ? [...state.privateDrafts.drafts, ...page.drafts] : page.drafts;
    state.privateDrafts = { ...page, drafts: [...new Map(drafts.map(draft => [draft.draft_id, draft])).values()] };
    renderPrivateDrafts(); text(el('private-draft-status'), '');
  } catch (error) {
    if (version === state.draftListVersion && session === state.session) text(el('private-draft-status'), `초안을 불러오지 못했습니다. ${error.message}`);
  } finally {
    if (version === state.draftListVersion) { el('refresh-drafts').disabled = false; el('more-drafts').disabled = false; }
  }
}

const commandStatusLabel = {
  pending: '확인 중', committed: '커밋 확인됨', rejected: '거절됨', cancelled: '취소됨',
};
const commandTypeLabel = {
  publish_revision: '공유 게시', propose: '검토 제안', decide: '대표자 결정', activate: '합의 활성화', suspend: '합의 정지', withdraw: '합의 철회',
};

function commandTargetLabel(command) {
  if (!command?.target_id) return '대상 확인 중';
  return shortDigest(command.target_id);
}

function clearCommands() {
  state.commandListVersion++;
  state.commands = { commands: [], next_cursor: null };
  state.commandUnavailable = new Set();
  if (state.commandPollTimer) window.clearTimeout(state.commandPollTimer);
  state.commandPollTimer = null;
  state.commandPollBusy = false;
  state.commandPollToken++;
  state.commandInFlight.clear();
  state.commandPollOffset = 0;
  el('command-list')?.replaceChildren();
  text(el('command-count'), '—');
  el('more-commands')?.toggleAttribute('hidden', true);
}

function renderCommands() {
  const list = el('command-list');
  if (!list) return;
  list.replaceChildren();
  text(el('command-count'), state.commands.commands.length);
  if (!state.commands.commands.length) { const empty = document.createElement('li'); empty.className = 'empty-state'; empty.textContent = '최근 요청이 없습니다.'; list.append(empty); }
  state.commands.commands.forEach((command) => {
    const item = document.createElement('li'); item.className = 'command-item';
    const head = document.createElement('div'); head.className = 'command-item-head';
    const title = document.createElement('strong'); title.textContent = commandTypeLabel[command.command_type] || '원장 요청';
    const status = document.createElement('span'); status.className = `status-chip ${command.status === 'committed' ? 'state-chip-active' : command.status === 'pending' ? 'state-chip-review' : 'state-chip-blocked'}`; status.textContent = state.commandUnavailable.has(command.command_id) ? '미확정 · 확인 불가' : commandStatusLabel[command.status] || command.status;
    head.append(title, status);
    const meta = document.createElement('span'); meta.className = 'command-item-meta'; meta.textContent = `${commandTargetLabel(command)} · ${formatDate(command.created_at)}`;
    item.append(head, meta);
    const evidence = document.createElement('details'); evidence.className = 'technical-evidence'; const summary = document.createElement('summary'); summary.textContent = '요청 증거 보기'; const evidenceBody = document.createElement('div'); evidenceBody.className = 'metadata-row';
    const idItem = document.createElement('span'); const idLabel = document.createElement('strong'); idLabel.textContent = 'command_id '; idItem.append(idLabel, document.createTextNode(command.command_id || '—')); evidenceBody.append(idItem);
    if (command.checkpoint) { const checkpoint = document.createElement('span'); const checkpointLabel = document.createElement('strong'); checkpointLabel.textContent = '검증된 checkpoint '; checkpoint.append(checkpointLabel, document.createTextNode(`block ${command.checkpoint.block_number ?? '—'} · tx ${command.checkpoint.transaction_index ?? '—'}`)); evidenceBody.append(checkpoint); }
    evidence.append(summary, evidenceBody); item.append(evidence);
    if (command.code) { const code = document.createElement('span'); code.className = 'command-item-code'; code.textContent = command.code; item.append(code); }
    if (command.status !== 'committed') {
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'outline-button'; retry.textContent = '같은 요청 다시 보내기'; retry.addEventListener('click', () => retryCommand(command)); item.append(retry);
    }
    list.append(item);
  });
  el('more-commands').hidden = !state.commands.next_cursor;
}

async function loadCommands(append = false) {
  if (!state.session?.actor || !apiBase) { clearCommands(); return; }
  state.commandPollToken++;
  state.commandPollBusy = false;
  const session = state.session; const version = ++state.commandListVersion;
  const cursor = append ? state.commands.next_cursor : null;
  el('refresh-commands').disabled = true; el('more-commands').disabled = true;
  try {
    const page = await request(`${apiBase}/commands?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { sessionGuard: session });
    if (version !== state.commandListVersion || session !== state.session) return;
    const commands = append ? [...state.commands.commands, ...(page.commands || [])] : (page.commands || []);
    state.commands = { ...page, commands: [...new Map(commands.map((command) => [command.command_id, command])).values()] };
    renderCommands();
    state.commandPollDelay = 5000;
    scheduleCommandPoll();
  } catch (error) {
    if (version === state.commandListVersion && session === state.session) showStatus(`요청 목록을 불러오지 못했습니다. ${error.message}`, 'error');
  } finally {
    if (version === state.commandListVersion) { el('refresh-commands').disabled = false; el('more-commands').disabled = false; }
  }
}

function scheduleCommandPoll() {
  if (state.commandPollTimer || document.hidden || !state.session?.actor) return;
  if (!state.commands.commands.some((command) => command.status === 'pending')) return;
  state.commandPollTimer = window.setTimeout(() => { state.commandPollTimer = null; void pollPendingCommands(); }, state.commandPollDelay);
}

async function pollPendingCommands() {
  if (state.commandPollBusy || document.hidden || !state.session?.actor) return;
  state.commandPollBusy = true;
  const token = ++state.commandPollToken;
  const session = state.session; const version = state.commandListVersion;
  const waiting = state.commands.commands.filter((command) => command.status === 'pending');
  const offset = state.commandPollOffset % Math.max(waiting.length, 1);
  const pending = waiting.slice(offset, offset + 3);
  state.commandPollOffset = (offset + pending.length) % Math.max(waiting.length, 1);
  let committed = false;
  try {
    for (const command of pending) {
      if (session !== state.session || version !== state.commandListVersion || token !== state.commandPollToken) return;
      try {
        const detail = await request(`${apiBase}/commands/${encodeURIComponent(command.command_id)}`, { sessionGuard: session });
        if (session !== state.session || version !== state.commandListVersion || token !== state.commandPollToken) return;
        const updated = detail.command || detail;
        state.commands.commands = state.commands.commands.map((item) => item.command_id === command.command_id ? updated : item);
        if (updated.status === 'committed' || updated.status === 'valid') committed = true;
        state.commandUnavailable.delete(command.command_id);
        renderCommands();
      } catch (error) {
        if (session !== state.session || version !== state.commandListVersion || token !== state.commandPollToken) return;
        if (error.status === 503 || error.api?.retryable) state.commandUnavailable.add(command.command_id);
      }
    }
    if (committed && session === state.session && version === state.commandListVersion && token === state.commandPollToken) await loadOverview();
  } finally {
    if (token !== state.commandPollToken) return;
    if (session !== state.session || version !== state.commandListVersion) { state.commandPollBusy = false; return; }
    state.commandPollBusy = false;
    state.commandPollDelay = Math.min(Math.max(state.commandPollDelay * 1.5, 5000), 30000);
    renderCommands();
    scheduleCommandPoll();
  }
}

async function retryCommand(command) {
  if (!state.session?.actor) return;
  const session = state.session; const version = state.commandListVersion;
  const key = `${session.actor.org_id}|${session.actor.actor_id}|retry|${command.command_id}`;
  if (state.commandInFlight.has(key)) { showStatus('이 요청은 이미 다시 보내는 중입니다. 결과를 확인하세요.', 'pending'); return; }
  state.commandInFlight.set(key, command.command_id);
  showStatus(`${commandTypeLabel[command.command_type] || '원장 요청'} · ${commandTargetLabel(command)}를 같은 요청으로 다시 보냅니다.`, 'pending');
  try {
    const result = await request(`${apiBase}/commands/${encodeURIComponent(command.command_id)}/retry`, { method: 'POST', body: jsonBody({}), sessionGuard: session });
    if (session !== state.session || version !== state.commandListVersion) return;
    if (result.status === 'pending') showStatus('같은 요청을 다시 보냈습니다. 아직 VALID 커밋으로 확인되지 않았습니다.', 'pending');
    else if (result.status === 'committed' && result.checkpoint) { showStatus('같은 요청의 커밋을 확인했습니다.', 'success'); await loadOverview(); }
    else showStatus('요청 결과를 아직 확인하지 못했습니다.', 'pending');
  } catch (error) {
    if (session === state.session && version === state.commandListVersion) showStatus(error.pending || error.status === 202 ? '같은 요청의 결과가 아직 미확정입니다. 내 요청에서 다시 확인하세요.' : `같은 요청 재전송 실패: ${error.message}`, error.pending || error.status === 202 ? 'pending' : 'error');
  } finally { if (state.commandInFlight.get(key) === command.command_id) state.commandInFlight.delete(key); if (session === state.session && version === state.commandListVersion) void loadCommands(); }
}

function setDraftSlotReadOnly(readOnly) {
  for (const id of ['draft-context', 'draft-scope', 'draft-usage']) el(id).readOnly = readOnly;
}

function draftPolicies() {
  const currentPersona = (state.session?.personas || []).find((persona) => persona.org_id === state.session?.actor?.org_id && persona.actor_id === state.session?.actor?.actor_id);
  const publishContexts = state.session?.capabilities?.publish_contexts || currentPersona?.publish_contexts || state.session?.actor?.publish_contexts || [];
  return (state.overview?.policies || []).filter((policy) => publishContexts.includes('*') || publishContexts.includes(policy.context_id));
}

function canPropose() {
  const currentPersona = (state.session?.personas || []).find((persona) => persona.org_id === state.session?.actor?.org_id && persona.actor_id === state.session?.actor?.actor_id);
  return state.session?.capabilities?.can_propose ?? currentPersona?.can_propose ?? state.session?.actor?.can_propose ?? false;
}

function selectedDraftPolicy() {
  const id = el('draft-policy')?.value;
  return draftPolicies().find((policy) => `${policy.policy_id}|${policy.policy_version}` === id) || null;
}

function syncDraftPolicies(preferred = null) {
  const select = el('draft-policy');
  if (!select) return;
  const policies = draftPolicies();
  const current = preferred || select.value;
  select.replaceChildren();
  policies.forEach((policy) => {
    const option = document.createElement('option'); option.value = `${policy.policy_id}|${policy.policy_version}`; option.textContent = `${policy.label || policy.policy_id} · ${metadataLabel('contexts', policy.context_id)} · v${policy.policy_version}`; option.dataset.documentId = policy.document_id; select.append(option);
  });
  if (current && policies.some((policy) => `${policy.policy_id}|${policy.policy_version}` === current)) select.value = current;
  else if (policies.length) select.value = `${policies[0].policy_id}|${policies[0].policy_version}`;
  const hint = el('draft-policy-status');
  text(hint, policies.length ? '선택한 정책의 문서 범위가 자동으로 입력됩니다.' : '작성 가능한 정책이 없습니다. 관리자가 정책과 게시 범위를 먼저 설정해야 합니다.');
  select.disabled = state.draftSourceId !== null || !policies.length;
  const allowed = Boolean(policies.length);
  el('save-draft')?.toggleAttribute('disabled', !allowed || Boolean(state.draft));
  el('import-markdown')?.toggleAttribute('disabled', !allowed);
}

function applyDraftPolicy(policy, { preserveBase = true } = {}) {
  if (!policy) return false;
  setDraftSlotReadOnly(true);
  setValue(el('draft-context'), policy.context_id);
  setValue(el('draft-scope'), policy.scope_id);
  setValue(el('draft-usage'), policy.usage_scope);
  const existing = currentDocuments().find((doc) => slotKeyFor(doc.payload) === slotKeyFor({ channel_id: policy.channel_id, document_id: policy.document_id, context_id: policy.context_id, scope_id: policy.scope_id, usage_scope: policy.usage_scope }));
  if (preserveBase) state.draftBaseDigest = existing?.revision_digest || null;
  return true;
}

function enterSavedDraftMode(draft) {
  state.draft = draft; state.draftSourceId = draft.draft_id;
  setDraftSlotReadOnly(true); document.querySelector('.markdown-import').hidden = true;
  text(el('composer-title'), '저장한 초안 검토');
  text(el('save-draft'), '수정 내용을 새 초안으로 저장');
  text(el('draft-origin'), draft.import ? `가져온 원본 파일: ${draft.import.filename}. 수정하면 원래 초안을 보존하고 새 초안으로 저장합니다.` : '수정하면 문서의 범위와 원래 초안을 보존하고 새 초안으로 저장합니다.');
  el('draft-origin').hidden = false;
  setDraftBusy(false);
}

async function openSavedDraft(id) {
  resetComposer();
  const version = state.composerVersion; const session = state.session;
  text(el('private-draft-status'), '선택한 초안을 여는 중…');
  try {
    const draft = await request(`${apiBase}/drafts/${encodeURIComponent(id)}`, { sessionGuard: session });
    if (version !== state.composerVersion || session !== state.session) return;
    const payload = draft.revision.payload;
    state.draftBaseDigest = payload.parents[0] ?? null;
    for (const [field, input] of [['title', 'draft-title'], ['body_markdown', 'draft-body'], ['context_id', 'draft-context'], ['scope_id', 'draft-scope'], ['usage_scope', 'draft-usage']]) setValue(el(input), payload[field]);
    const policy = (state.overview?.policies || []).find((candidate) => candidate.document_id === payload.document_id && candidate.context_id === payload.context_id && candidate.scope_id === payload.scope_id && candidate.usage_scope === payload.usage_scope);
    syncDraftPolicies(policy ? `${policy.policy_id}|${policy.policy_version}` : null);
    setValue(el('draft-source-kind'), payload.metadata.source_kind);
    enterSavedDraftMode(draft);
    text(el('draft-status'), '저장한 초안입니다. 그대로 공유 검토하거나 수정 후 새 초안으로 저장하세요.');
    text(el('private-draft-status'), '');
    renderPreviewStep(draft); el('composer-panel').hidden = false; el('draft-title').focus();
  } catch (error) {
    if (version === state.composerVersion && session === state.session) text(el('private-draft-status'), `초안을 열지 못했습니다. ${error.message}`);
  }
}

async function loadOverview({ preserveSelection = true } = {}) {
  const session = state.session;
  const previous = preserveSelection ? state.selectedDocumentKey : null;
  const overview = await request(`${apiBase}/overview`, { sessionGuard: session });
  if (session !== state.session) return;
  state.overview = overview;
  renderMode(overview.mode, state.session?.auth_mode);
  const docs = currentDocuments();
  state.selectedDocumentKey = docs.some((doc) => slotKeyFor(doc.payload) === previous) ? previous : slotKeyFor(docs[0]?.payload) || null;
  if (state.selectedRevisionDigest && !(overview.documents || []).some((doc) => doc.revision_digest === state.selectedRevisionDigest)) state.selectedRevisionDigest = null;
  if (state.selectedProposalId && !(overview.proposals || []).some((proposal) => proposal.proposal_id === state.selectedProposalId)) state.selectedProposalId = null;
  renderOverview();
}

function renderOverview() {
  const overview = state.overview || {};
  const docs = currentDocuments();
  const proposals = overview.proposals || [];
  const active = (overview.documents || []).filter((doc) => doc.eligible && doc.agreement?.status === 'active').length;
  text(el('metric-agreements'), active);
  text(el('metric-proposals'), proposals.filter((proposal) => !proposal.agreement_id).length);
  text(el('metric-documents'), docs.length);
  text(el('document-count'), docs.length);
  text(el('metric-epoch'), overview.channel?.membership_epoch ?? '—');
  text(el('metric-config'), overview.channel?.config_version ? `config ${overview.channel.config_version}` : 'config 확인 불가');
  const checkpoint = overview.checkpoint;
  text(el('checkpoint-value'), checkpoint ? `block ${checkpoint.block_number ?? '—'} · tx ${checkpoint.transaction_index ?? '—'}` : '확인 불가');
  renderDocumentList(docs);
  renderDocumentDetail(findSelectedDocument());
  renderReview(findSelectedDocument());
  renderRevisionComparison(findSelectedDocument());
  renderResolverDocuments(docs);
  renderReviewInbox();
  syncDraftPolicies();
}

function metadataCollection(name) {
  return state.overview?.workspace?.[name] || state.session?.workspace?.[name] || [];
}

function metadataLabel(collection, id) {
  return metadataCollection(collection).find((item) => item.id === id)?.label || id || '미지정';
}

function organizationLabel(orgId) {
  return state.overview?.organizations?.find((organization) => organization.org_id === orgId)?.label
    || state.session?.organizations?.find((organization) => organization.org_id === orgId)?.label
    || orgId || '조직 미지정';
}

function currentDocuments() {
  const latest = new Map();
  (state.overview?.documents || []).forEach((doc) => {
    const key = slotKeyFor(doc.payload);
    if (!key) return;
    const current = latest.get(key);
    if (!current || compareDocumentOrder(doc, current) > 0) latest.set(key, doc);
  });
  return [...latest.values()].sort((left, right) => String(left.payload?.title || '').localeCompare(String(right.payload?.title || ''), 'ko'));
}

function slotKeyFor(payload) {
  if (!payload) return '';
  return [payload.channel_id, payload.document_id, payload.context_id, payload.scope_id, payload.usage_scope].join('|');
}

function checkpointOrder(doc) {
  const checkpoint = doc?.published_checkpoint || doc?.checkpoint || {};
  return [Number.isSafeInteger(checkpoint.block_number) ? checkpoint.block_number : -1, Number.isSafeInteger(checkpoint.transaction_index) ? checkpoint.transaction_index : -1, String(checkpoint.transaction_id || '')];
}

function compareDocumentOrder(left, right) {
  const a = checkpointOrder(left); const b = checkpointOrder(right);
  for (let index = 0; index < 3; index += 1) { if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1; }
  return String(left?.payload?.metadata?.created_at || '').localeCompare(String(right?.payload?.metadata?.created_at || ''));
}

function findSelectedDocument() {
  if (state.selectedRevisionDigest) return (state.overview?.documents || []).find((doc) => doc.revision_digest === state.selectedRevisionDigest) || null;
  return currentDocuments().find((doc) => slotKeyFor(doc.payload) === state.selectedDocumentKey) || null;
}

function renderDocumentList(documents) {
  const list = el('document-list');
  list.replaceChildren();
  if (!documents.length) {
    const empty = document.createElement('p'); empty.className = 'empty-state'; empty.textContent = '공유된 문서가 없습니다.'; list.append(empty); return;
  }
  documents.forEach((doc) => {
    const payload = doc.payload || {};
    const button = document.createElement('button');
    const key = slotKeyFor(payload);
    button.type = 'button'; button.className = 'document-card'; button.dataset.documentKey = key;
    button.setAttribute('aria-current', key === state.selectedDocumentKey ? 'true' : 'false');
    const title = document.createElement('span'); title.className = 'document-card-title'; title.textContent = payload.title || '제목 없는 문서';
    const meta = document.createElement('span'); meta.className = 'document-card-meta';
    const context = document.createElement('span'); context.className = 'document-card-context'; context.textContent = metadataLabel('contexts', payload.context_id);
    const presentation = statusForDocument(doc);
    const status = document.createElement('span'); status.className = `status-chip ${presentation.className}`; status.textContent = presentation.label;
    meta.append(context, status); button.append(title, meta); list.append(button);
    button.addEventListener('click', () => { state.selectedDocumentKey = key; state.selectedRevisionDigest = null; state.selectedProposalId = null; state.compareRevisionDigest = null; renderOverview(); el('document-title')?.focus?.(); });
  });
}

function contextLabel(contextId) {
  return metadataLabel('contexts', contextId);
}

function statusForDocument(doc) {
  if (!doc) return { label: '문서 선택 필요', className: 'state-chip-neutral' };
  if (doc.eligible && doc.agreement?.status === 'active') return { label: '합의 활성', className: 'state-chip-active' };
  if (doc.agreement?.status === 'suspended') return { label: '정지됨', className: 'state-chip-blocked' };
  if (doc.agreement?.status === 'withdrawn') return { label: '철회됨', className: 'state-chip-blocked' };
  if (doc.agreement?.status === 'superseded') return { label: '대체됨', className: 'state-chip-neutral' };
  if (doc.agreement?.status === 'active') return { label: '합의 활성 · 현재 사용 보류', className: 'state-chip-withheld' };
  const proposed = (state.overview?.proposals || []).some(proposal => proposal.revision_digest === doc.revision_digest);
  return proposed ? { label: '합의 검토 중', className: 'state-chip-review' } : { label: '공유 게시됨 · 합의 전', className: 'state-chip-neutral' };
}

function reasonLabel(reason) {
  if (reason === 'NO_ACTIVE_AGREEMENT') return '아직 채택된 합의가 없습니다. 지정된 책임자의 검토가 필요합니다.';
  if (reason?.startsWith('DEPENDENCY_')) return '이 문서가 의존하는 지식의 합의를 먼저 확인해 주세요.';
  if (reason?.startsWith('CORRUPT_')) return '원문이나 승인 이력을 확인할 수 없어 사용을 보류합니다.';
  if (reason === 'SERVING_FROZEN') return '공유 지식 제공이 일시 중지되어 있습니다.';
  return '활성 합의와 사용 범위를 다시 확인해 주세요.';
}

function setWorkspace(space) {
  if (!['review', 'documents', 'resolver'].includes(space)) return;
  state.activeSpace = space;
  document.querySelectorAll('[data-workspace]').forEach((button) => button.setAttribute('aria-current', button.dataset.workspace === space ? 'page' : 'false'));
}

function renderDocumentDetail(doc) {
  const container = el('document-detail-content');
  container.replaceChildren();
  if (!doc) { const empty = document.createElement('p'); empty.className = 'empty-state'; empty.textContent = '표시할 문서가 없습니다.'; container.append(empty); return; }
  const payload = doc.payload || {}; const status = statusForDocument(doc);
  const top = document.createElement('div'); top.className = 'detail-topline';
  const type = document.createElement('span'); type.textContent = `${contextLabel(payload.context_id)}  /  ${payload.usage_scope || 'scope 미지정'}`;
  const chip = document.createElement('span'); chip.className = `status-chip ${status.className}`; chip.textContent = status.label; top.append(type, chip);
  const body = document.createElement('div'); body.className = 'detail-body';
  const title = document.createElement('h2'); title.id = 'document-title'; title.className = 'detail-title'; title.tabIndex = -1; title.textContent = payload.title || '제목 없는 문서';
  const description = document.createElement('p'); description.className = 'detail-description'; description.textContent = doc.reason ? reasonLabel(doc.reason) : '이 도메인이 책임지는 의미의 최신 개정본입니다.';
  const evidence = document.createElement('details'); evidence.className = 'technical-evidence'; const evidenceSummary = document.createElement('summary'); evidenceSummary.textContent = '기술 증거 보기'; const metadata = document.createElement('div'); metadata.className = 'metadata-row';
  [['revision', shortDigest(doc.revision_digest)], ['document', payload.document_id], ['scope', payload.scope_id], ['channel', payload.channel_id], ['작성', formatDate(payload.metadata?.created_at)]].forEach(([label, value]) => { const item = document.createElement('span'); const strong = document.createElement('strong'); strong.textContent = `${label} `; item.append(strong, document.createTextNode(value || '—')); metadata.append(item); }); evidence.append(evidenceSummary, metadata);
  const source = document.createElement('div'); source.className = 'source-view';
  const sourceHead = document.createElement('div'); sourceHead.className = 'source-view-heading'; const sourceLabel = document.createElement('span'); sourceLabel.textContent = 'FULL MARKDOWN SOURCE'; const sourceBytes = document.createElement('span'); sourceBytes.textContent = `${new TextEncoder().encode(payload.body_markdown || '').length.toLocaleString()} bytes`; sourceHead.append(sourceLabel, sourceBytes);
  const pre = document.createElement('pre'); pre.className = 'markdown-source'; pre.textContent = payload.body_markdown || ''; source.append(sourceHead, pre);
  const detailActions = document.createElement('div'); detailActions.className = 'detail-actions'; const revise = document.createElement('button'); revise.type = 'button'; revise.className = 'outline-button'; revise.textContent = '이 문서의 새 개정본 작성'; revise.addEventListener('click', () => openComposer('revise', doc)); detailActions.append(revise);
  body.append(title, description, evidence, source, detailActions);
  if (doc.history?.length) {
    const history = document.createElement('div'); history.className = 'history-section'; const heading = document.createElement('h3'); heading.className = 'subheading'; heading.textContent = '개정 이력'; const list = document.createElement('div'); list.className = 'history-list';
    doc.history.forEach((item) => { const row = document.createElement('div'); row.className = 'history-item'; const name = document.createElement('strong'); name.textContent = item.title || '제목 없음'; const date = document.createElement('span'); date.textContent = `${shortDigest(item.revision_digest)} · ${formatDate(item.created_at)}`; row.append(name, date); list.append(row); }); history.append(heading, list); body.append(history);
  }
  const note = document.createElement('div'); note.className = 'eligibility-note'; const noteStrong = document.createElement('strong'); noteStrong.textContent = doc.eligible ? '✓ 조회 시점에 유효한 합의' : '· 이 개정본은 검토 필요'; const noteText = document.createElement('span'); noteText.textContent = doc.eligible ? '실제 사용 전 아래에서 실행 컨텍스트를 확인해 주세요.' : (!doc.reason && activeAgreementForSlot(doc) ? '새 개정본을 채택하기 전까지 조회에는 기존 채택본이 사용됩니다.' : reasonLabel(doc.reason)); note.append(noteStrong, noteText); body.append(note);
  container.append(top, body);
}

function getSelectedProposal(doc) {
  if (state.selectedProposalId) return (state.overview?.proposals || []).find((proposal) => proposal.proposal_id === state.selectedProposalId && proposal.revision_digest === doc?.revision_digest) || null;
  return (state.overview?.proposals || []).filter((proposal) => proposal.revision_digest === doc?.revision_digest).sort((left, right) => {
    const leftDate = left.created_at || left.proposed_at || '';
    const rightDate = right.created_at || right.proposed_at || '';
    return String(leftDate).localeCompare(String(rightDate));
  }).at(-1) || null;
}

function proposalStatus(proposal) {
  const agreementStatus = proposal?.agreement?.status;
  if (agreementStatus) return agreementStatus;
  if (proposal?.status === 'activated') return 'active';
  return proposal?.status || (proposal?.agreement_id ? 'active' : 'open');
}

function proposalStatusLabel(status) {
  return { active: '활성 합의', open: '검토 중', activated: '활성 합의', suspended: '정지됨', withdrawn: '철회됨' }[status] || status || '검토 중';
}

function matchingPolicy(doc) {
  const slot = doc?.payload || {};
  return (state.overview?.policies || []).find((policy) => policy.document_id === slot.document_id && policy.context_id === slot.context_id && policy.scope_id === slot.scope_id && policy.usage_scope === slot.usage_scope && policy.channel_id === slot.channel_id);
}

function outstandingReviews() {
  const actor = state.session?.actor;
  if (!actor) return [];
  return (state.overview?.proposals || []).filter((proposal) => {
    if (proposalStatus(proposal) !== 'open') return false;
    return (proposal.required_representatives || []).some((representative) => {
      if (representative.actor_org_id !== actor.org_id || representative.actor_id !== actor.actor_id) return false;
      return !(proposal.decisions || []).some((decision) => decision.actor_org_id === actor.org_id && decision.actor_id === actor.actor_id && decision.actor_domain_role === representative.domain_role && decision.decision !== 'retract');
    });
  });
}

function renderReviewInbox() {
  const list = el('review-inbox');
  const count = el('review-inbox-count');
  if (!list) return;
  const reviews = outstandingReviews();
  text(count, reviews.length);
  list.replaceChildren();
  if (!reviews.length) {
    const empty = document.createElement('p'); empty.className = 'empty-state'; empty.textContent = '지금 처리할 검토가 없습니다.'; list.append(empty); return;
  }
  reviews.forEach((proposal) => {
    const doc = (state.overview?.documents || []).find((candidate) => candidate.revision_digest === proposal.revision_digest);
    const button = document.createElement('button'); button.type = 'button'; button.className = 'review-inbox-item';
    const title = document.createElement('strong'); title.textContent = doc?.payload?.title || proposal.proposal_id || '검토 제안';
    const meta = document.createElement('span'); meta.textContent = `${metadataLabel('contexts', doc?.payload?.context_id)} · 검토 정책`;
    button.append(title, meta);
    button.addEventListener('click', () => {
      if (doc) { state.selectedDocumentKey = slotKeyFor(doc.payload); state.selectedRevisionDigest = doc.revision_digest; state.selectedProposalId = proposal.proposal_id; state.compareRevisionDigest = null; }
      setWorkspace('review'); renderOverview(); el('review-title')?.focus?.();
    });
    list.append(button);
  });
}

async function proposeCurrentRevision(doc) {
  if (!canPropose()) { showStatus('이 계정에는 검토 제안을 제출할 권한이 없습니다.', 'error'); return; }
  const policy = matchingPolicy(doc);
  if (!policy) { showStatus('이 개정본의 문서 범위와 일치하는 정책이 없어 제안을 제출할 수 없습니다.', 'error'); return; }
  await executeMutation('/agreement-proposals', { revision_digest: doc.revision_digest, policy_id: policy.policy_id, policy_version: policy.policy_version, command_id: nowCommand() }, '새 합의 검토 제안', { command_type: 'propose', target_id: doc.revision_digest });
}

function renderReview(doc) {
  const target = el('review-content'); target.replaceChildren();
  const reviewChip = el('review-state-chip');
  if (!doc) { text(reviewChip, '문서 선택 필요'); reviewChip.className = 'state-chip state-chip-neutral'; const empty = document.createElement('p'); empty.className = 'empty-state'; empty.textContent = '문서를 선택하면 이 문서에 연결된 제안과 대표자 응답이 표시됩니다.'; target.append(empty); return; }
  const proposal = getSelectedProposal(doc); const status = proposal ? proposalStatus(proposal) : statusForDocument(doc).label; text(reviewChip, proposal ? proposalStatusLabel(status) : status); reviewChip.className = `state-chip ${status === 'active' ? 'state-chip-active' : status === 'suspended' || status === 'withdrawn' ? 'state-chip-blocked' : 'state-chip-review'}`;
  if (!proposal) { const empty = document.createElement('p'); empty.className = 'empty-state'; empty.textContent = '이 개정본에 대한 검토 제안이 아직 없습니다. 새 개정본을 공유한 뒤 합의를 제안하세요.'; target.append(empty); return; }
  const card = document.createElement('article'); card.className = 'proposal-card';
  const head = document.createElement('div'); head.className = 'proposal-head'; const title = document.createElement('div'); const id = document.createElement('p'); id.className = 'proposal-id'; id.textContent = '검토 제안'; const meta = document.createElement('p'); meta.className = 'proposal-meta'; meta.textContent = `검토 정책 · 응답 순서 ${proposal.review_counter ?? '—'}`; title.append(id, meta); const proposalChip = document.createElement('span'); proposalChip.className = `status-chip ${status === 'active' ? 'state-chip-active' : status === 'suspended' || status === 'withdrawn' ? 'state-chip-blocked' : 'state-chip-review'}`; proposalChip.textContent = proposalStatusLabel(status); head.append(title, proposalChip);
  const reps = document.createElement('ul'); reps.className = 'representative-list'; (proposal.required_representatives || []).forEach((rep) => { const row = document.createElement('li'); row.className = 'representative-row'; const role = document.createElement('span'); role.textContent = roleLabel(rep.domain_role); const actor = document.createElement('span'); actor.textContent = `${rep.actor_org_id} · ${rep.actor_id}`; const decision = (proposal.decisions || []).find((item) => item.actor_id === rep.actor_id && item.actor_org_id === rep.actor_org_id && item.actor_domain_role === rep.domain_role); row.append(role); if (decision) { const chip = document.createElement('span'); chip.className = `status-chip ${decision.decision === 'approve' ? 'state-chip-active' : decision.decision === 'object' ? 'state-chip-blocked' : 'state-chip-neutral'}`; chip.textContent = decision.decision; row.append(chip); } else row.append(actor); reps.append(row); });
  const actions = document.createElement('div'); actions.className = 'decision-actions';
  if (status === 'open') {
    const rationaleLabel = document.createElement('label'); rationaleLabel.className = 'decision-rationale'; rationaleLabel.textContent = '이번 결정의 근거'; const rationaleInput = document.createElement('input'); rationaleInput.id = `rationale-${proposal.proposal_id}`; rationaleInput.type = 'text'; rationaleInput.maxLength = 1000; rationaleInput.placeholder = '대표자의 판단 근거를 남기세요'; rationaleLabel.append(rationaleInput); card.append(head, reps, rationaleLabel);
    ['approve', 'object', 'abstain', 'retract'].forEach((decision) => { const button = document.createElement('button'); button.type = 'button'; button.className = 'decision-button'; button.dataset.decision = decision; button.textContent = decisionLabel(decision); button.addEventListener('click', () => submitDecision(proposal, decision)); actions.append(button); });
  }
  const controls = document.createElement('div'); controls.className = 'proposal-controls'; const helper = document.createElement('small'); helper.textContent = '대표자의 명시적 응답만 합의 상태에 반영됩니다.'; controls.append(helper);
  if (status === 'open') { const activate = document.createElement('button'); activate.type = 'button'; activate.className = 'primary-button'; activate.textContent = '합의 활성화'; activate.addEventListener('click', () => activateProposal(proposal)); controls.append(activate); }
  if (status === 'active' && proposal.agreement_id) { const reasonLabel = document.createElement('label'); reasonLabel.className = 'decision-rationale'; reasonLabel.textContent = '상태 변경 사유'; const reasonInput = document.createElement('input'); reasonInput.id = `agreement-reason-${proposal.agreement_id}`; reasonInput.type = 'text'; reasonInput.maxLength = 1000; reasonInput.placeholder = '정지 또는 철회 사유를 남기세요'; reasonLabel.append(reasonInput); card.append(reasonLabel); const agreementActions = document.createElement('span'); ['suspend', 'withdraw'].forEach((action) => { const button = document.createElement('button'); button.type = 'button'; button.className = 'decision-button'; button.textContent = action === 'suspend' ? '일시 정지' : '사용 철회'; button.addEventListener('click', () => changeAgreement(proposal, action)); agreementActions.append(button); }); controls.append(agreementActions); }
  if (status === 'suspended' || status === 'withdrawn') { const fresh = document.createElement('button'); fresh.type = 'button'; fresh.className = 'primary-button'; fresh.textContent = '새 합의 검토 제안'; fresh.addEventListener('click', () => proposeCurrentRevision(doc)); controls.append(fresh); }
  if (actions.childElementCount) card.append(actions); card.append(controls); target.append(card);
}

function roleLabel(role) { return metadataLabel('roles', role); }
function decisionLabel(decision) { return { approve: '승인', object: '이의 제기', abstain: '기권', retract: '내 결정 철회' }[decision] || decision; }

function sameRevisionSlot(left, right) {
  return ['channel_id', 'document_id', 'context_id', 'scope_id', 'usage_scope'].every((field) => left?.[field] === right?.[field]);
}

function revisionCandidates(current) {
  const all = (state.overview?.documents || []).filter((candidate) => candidate.revision_digest !== current?.revision_digest && sameRevisionSlot(candidate.payload, current?.payload) && compareDocumentOrder(candidate, current) < 0);
  const parents = new Set(current?.payload?.parents || []);
  return all.sort((left, right) => {
    const parentOrder = Number(parents.has(right.revision_digest)) - Number(parents.has(left.revision_digest));
    return parentOrder || -compareDocumentOrder(left, right);
  });
}

function appendDigestEvidence(container, current, previous) {
  const details = document.createElement('details'); details.className = 'technical-evidence';
  const summary = document.createElement('summary'); summary.textContent = '비교 대상 digest 보기';
  const body = document.createElement('div'); body.className = 'metadata-row';
  [['현재 개정본', current?.revision_digest], ['비교 대상', previous?.revision_digest || '이전 개정본 없음']].forEach(([label, value]) => { const item = document.createElement('span'); const strong = document.createElement('strong'); strong.textContent = `${label} `; item.append(strong, document.createTextNode(value)); body.append(item); });
  details.append(summary, body); container.append(details);
}

function renderRevisionComparison(current) {
  const container = el('revision-compare-content');
  if (!container) return;
  container.replaceChildren();
  if (!current) { const empty = document.createElement('p'); empty.className = 'empty-state'; empty.textContent = '문서를 선택하면 이전 개정본을 비교할 수 있습니다.'; container.append(empty); return; }
  const candidates = revisionCandidates(current);
  const preferred = state.compareRevisionDigest && candidates.some((candidate) => candidate.revision_digest === state.compareRevisionDigest)
    ? state.compareRevisionDigest : candidates[0]?.revision_digest || null;
  state.compareRevisionDigest = preferred;
  const controls = document.createElement('div'); controls.className = 'revision-compare-controls';
  const label = document.createElement('label'); label.textContent = '비교할 이전 개정본';
  const select = document.createElement('select'); select.setAttribute('aria-label', '비교할 이전 개정본');
  candidates.forEach((candidate) => { const option = document.createElement('option'); option.value = candidate.revision_digest; option.textContent = `${candidate.payload?.title || '제목 없음'} · ${formatDate(candidate.payload?.metadata?.created_at)} · ${shortDigest(candidate.revision_digest)}`; option.selected = candidate.revision_digest === preferred; select.append(option); });
  label.append(select); controls.append(label); container.append(controls);
  select.addEventListener('change', () => { state.compareRevisionDigest = select.value || null; renderRevisionComparison(current); });
  const previous = candidates.find((candidate) => candidate.revision_digest === preferred) || null;
  let comparison;
  try { comparison = compareRevisions(current, previous); }
  catch (error) { const message = document.createElement('p'); message.className = 'review-error'; message.textContent = error instanceof RevisionComparisonError ? error.message : '개정본을 비교할 수 없습니다.'; container.append(message); return; }
  appendDigestEvidence(container, current, previous);
  const title = document.createElement('div'); title.className = 'revision-compare-title';
  const beforeTitle = document.createElement('span'); beforeTitle.textContent = comparison.title.before ?? '이전 개정본 없음';
  const afterTitle = document.createElement('strong'); afterTitle.textContent = comparison.title.after;
  title.append(beforeTitle, document.createTextNode(' → '), afterTitle); container.append(title);
  const dependency = document.createElement('p'); dependency.className = 'form-hint'; dependency.textContent = `의존성 변경 ${comparison.dependencies.added.length}개 추가 · ${comparison.dependencies.removed.length}개 제거 · ${comparison.dependencies.changed.length}개 관계 변경`;
  container.append(dependency);
  if (comparison.dependencies.added.length || comparison.dependencies.removed.length) {
    const dependencyDetails = document.createElement('details'); dependencyDetails.className = 'technical-evidence'; const dependencySummary = document.createElement('summary'); dependencySummary.textContent = '의존성 digest 변경 보기'; const dependencyBody = document.createElement('div'); dependencyBody.className = 'metadata-row';
    [['추가', comparison.dependencies.added], ['제거', comparison.dependencies.removed]].forEach(([label, values]) => { if (!values.length) return; const item = document.createElement('span'); const strong = document.createElement('strong'); strong.textContent = `${label} `; item.append(strong, document.createTextNode(values.join(', '))); dependencyBody.append(item); });
    comparison.dependencies.changed.forEach((change) => { const item = document.createElement('span'); const strong = document.createElement('strong'); strong.textContent = `관계 변경 ${change.revision_digest} `; item.append(strong, document.createTextNode(`이전 ${JSON.stringify(change.before)} · 현재 ${JSON.stringify(change.after)}`)); dependencyBody.append(item); });
    dependencyDetails.append(dependencySummary, dependencyBody); container.append(dependencyDetails);
  }
  const bodyHeading = document.createElement('h4'); bodyHeading.className = 'subheading'; bodyHeading.textContent = comparison.has_previous ? '본문 변경' : comparison.body.message; container.append(bodyHeading);
  if (comparison.body.line_endings_changed) { const lineEndingNote = document.createElement('p'); lineEndingNote.className = 'form-hint'; lineEndingNote.textContent = '줄바꿈 형식이 바뀌었습니다. 원문 바이트는 서로 다릅니다.'; container.append(lineEndingNote); }
  if (comparison.body.fallback) {
    const columns = document.createElement('div'); columns.className = 'revision-diff-columns';
    [['이전 원문', comparison.body.before_text], ['현재 원문', comparison.body.after_text]].forEach(([heading, value]) => { const section = document.createElement('section'); const name = document.createElement('h5'); name.textContent = heading; const pre = document.createElement('pre'); pre.className = 'markdown-source'; pre.textContent = value; section.append(name, pre); columns.append(section); });
    const note = document.createElement('p'); note.className = 'form-hint'; note.textContent = comparison.body.message; container.append(note, columns);
  } else if (comparison.has_previous) {
    const lines = document.createElement('div'); lines.className = 'revision-diff-lines';
    comparison.body.lines.forEach((line) => { const row = document.createElement('div'); row.className = `revision-diff-line revision-diff-${line.type}`; const marker = document.createElement('span'); marker.className = 'revision-diff-marker'; marker.textContent = line.type === 'added' ? '+' : line.type === 'removed' ? '−' : ' '; const value = document.createElement('span'); value.textContent = line.text; row.append(marker, value); lines.append(row); });
    container.append(lines);
  }
}

function renderResolverDocuments(documents) {
  const select = el('resolve-documents'); const previous = select.value; select.replaceChildren();
  documents.forEach((doc) => { const option = document.createElement('option'); option.value = slotKeyFor(doc.payload); option.dataset.documentId = doc.payload?.document_id || ''; option.textContent = `${doc.payload?.title || '제목 없음'} · ${contextLabel(doc.payload?.context_id)}`; option.selected = slotKeyFor(doc.payload) === state.selectedDocumentKey; select.append(option); });
  const selected = documents.find((doc) => slotKeyFor(doc.payload) === state.selectedDocumentKey) || documents[0];
  if (!select.dataset.initialized || previous !== select.value) syncResolverFields(selected);
  select.dataset.initialized = 'true';
}

function syncResolverFields(doc) {
  if (!doc?.payload) return;
  setValue(el('resolve-context'), doc.payload.context_id);
  setValue(el('resolve-scope'), doc.payload.scope_id);
  setValue(el('resolve-usage'), doc.payload.usage_scope);
}

function activeAgreementForSlot(document) {
  if (!document?.payload) return null;
  const slot = document.payload;
  return (state.overview?.documents || []).find((candidate) => {
    const payload = candidate.payload || {};
    return candidate.agreement?.status === 'active'
      && payload.document_id === slot.document_id
      && payload.context_id === slot.context_id
      && payload.scope_id === slot.scope_id
      && payload.usage_scope === slot.usage_scope
      && payload.channel_id === slot.channel_id;
  })?.agreement?.agreement_id || null;
}

function jsonBody(value) { return JSON.stringify(value); }
function pendingDuplicate(commandMeta) {
  return commandMeta && state.commands.commands.find((command) => command.status === 'pending' && command.command_type === commandMeta.command_type && command.target_id === commandMeta.target_id);
}
async function executeMutation(path, payload, label, commandMeta) {
  const session = state.session;
  const inFlightKey = commandMeta && session?.actor ? `${session.actor.org_id}|${session.actor.actor_id}|${commandMeta.command_type}|${commandMeta.target_id}` : null;
  if (inFlightKey && state.commandInFlight.has(inFlightKey)) {
    showStatus(`같은 대상의 ${commandTypeLabel[commandMeta.command_type] || '요청'}을 이미 보내는 중입니다. 결과를 확인하세요.`, 'pending');
    return null;
  }
  const duplicate = pendingDuplicate(commandMeta);
  if (duplicate) {
    showStatus(`같은 대상의 ${commandTypeLabel[commandMeta.command_type] || '요청'}이 이미 확인 중입니다. 내 요청에서 상태를 확인하세요.`, 'pending');
    void loadCommands();
    return null;
  }
  if (inFlightKey) state.commandInFlight.set(inFlightKey, payload.command_id);
  try {
    const result = await request(`${apiBase}${path}`, { method: 'POST', body: jsonBody(payload), sessionGuard: session });
    if (session !== state.session) return null;
    if (result.status === 'pending') { showStatus(`${label} 요청이 접수됐습니다. 아직 VALID 커밋으로 확인되지 않았습니다.`, 'pending'); void loadCommands(); return result; }
    if (result.status !== 'committed' || !result.checkpoint) { showStatus(`${label} 상태가 ${result.status}입니다. 결과를 확정하지 않았습니다.`, 'pending'); void loadCommands(); return result; }
    showStatus(`${label}이(가) 커밋됐습니다.`, 'success'); await loadOverview(); if (session !== state.session) return null; void loadCommands(); return result;
  } catch (error) {
    if (session !== state.session) return null;
    if (error.pending || error.status === 202 || error.api?.status === 'pending') {
      showStatus(`${label} 요청이 접수됐습니다. 아직 VALID 커밋으로 확인되지 않았습니다.`, 'pending');
      void loadCommands(); return error.api || null;
    }
    if (!error.status || error.status >= 500) {
      showStatus(`${label} 결과를 확인하지 못했습니다. 요청 이력에서 커밋 상태를 확인합니다.`, 'pending');
      await loadCommands();
      if (session === state.session && state.commands.commands.some(command => command.command_id === payload.command_id && command.status === 'committed')) {
        await loadOverview();
        if (session === state.session) showStatus(`${label}의 커밋을 요청 이력에서 확인했습니다.`, 'success');
      }
      return null;
    }
    showStatus(`${label} 실패: ${error.message}`, 'error'); void loadCommands(); return null;
  } finally { if (inFlightKey && state.commandInFlight.get(inFlightKey) === payload.command_id) state.commandInFlight.delete(inFlightKey); }
}

async function submitDecision(proposal, decision) {
  const rationale = el(`rationale-${proposal.proposal_id}`)?.value.trim() || '';
  if (!rationale) { showStatus('결정의 근거를 입력하세요.', 'error'); return; }
  const payload = { decision, rationale, command_id: nowCommand() };
  if (decision === 'retract') { const own = (proposal.decisions || []).find((item) => item.actor_id === state.session?.actor?.actor_id && item.actor_org_id === state.session?.actor?.org_id && item.decision !== 'retract'); if (!own) { showStatus('철회할 본인 결정이 없습니다.', 'error'); return; } payload.retracts_decision_id = own.decision_id; }
  await executeMutation(`/agreement-proposals/${encodeURIComponent(proposal.proposal_id)}/decisions`, payload, `결정 ${decisionLabel(decision)}`, { command_type: 'decide', target_id: proposal.proposal_id });
}

async function activateProposal(proposal) {
  const selected = findSelectedDocument();
  await executeMutation(`/agreement-proposals/${encodeURIComponent(proposal.proposal_id)}/activate`, { expected_active_agreement_id: activeAgreementForSlot(selected), command_id: nowCommand() }, '합의 활성화', { command_type: 'activate', target_id: proposal.proposal_id });
}

async function changeAgreement(proposal, action) {
  const reason = el(`agreement-reason-${proposal.agreement_id}`)?.value.trim() || '';
  if (!reason) { showStatus(`${action === 'suspend' ? '정지' : '철회'} 사유를 입력하세요.`, 'error'); return; }
  await executeMutation(`/agreements/${encodeURIComponent(proposal.agreement_id)}/${action}`, { reason, command_id: nowCommand() }, action === 'suspend' ? '합의 정지' : '합의 철회', { command_type: action, target_id: proposal.agreement_id });
}

async function onDraftSubmit(event) {
  event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); text(el('draft-status'), '비공개 저장소에 저장 중…');
  const version = ++state.composerVersion; const session = state.session;
  setDraftBusy(true);
  const payload = Object.fromEntries(data.entries());
  const policy = selectedDraftPolicy();
  if (!policy && !state.draftSourceId) { text(el('draft-status'), '먼저 작성할 문서 범위를 선택하세요.'); setDraftBusy(false); return; }
  if (policy && !state.draftSourceId) {
    payload.document_id = policy.document_id;
    payload.context_id = policy.context_id;
    payload.scope_id = policy.scope_id;
    payload.usage_scope = policy.usage_scope;
  }
  delete payload.policy_id;
  const base = state.draftBaseDigest ? (state.overview?.documents || []).find((doc) => doc.revision_digest === state.draftBaseDigest) : null;
  if (base?.payload) { payload.base_revision_digest = base.revision_digest; payload.document_id = base.payload.document_id; }
  try {
    let path = `${apiBase}/drafts`; let input = payload;
    if (state.draftSourceId) {
      path += `/${encodeURIComponent(state.draftSourceId)}/edits`;
      input = { title: payload.title, body_markdown: payload.body_markdown, source_kind: payload.source_kind };
      const fingerprint = JSON.stringify({ source: state.draftSourceId, input });
      if (state.draftEditRequest?.fingerprint !== fingerprint) state.draftEditRequest = { fingerprint, editId: nowCommand() };
      input.edit_id = state.draftEditRequest.editId;
    }
    const draft = await request(path, { method: 'POST', body: jsonBody(input), sessionGuard: session });
    if (version !== state.composerVersion || session !== state.session) return;
    enterSavedDraftMode(draft); text(el('draft-status'), '비공개 초안이 저장됐습니다. 이제 공유 미리보기를 생성하세요.'); showStatus('비공개 초안이 저장됐습니다. 아직 공용 원장에 게시되지 않았습니다.', 'success'); renderPreviewStep(draft); void loadPrivateDrafts();
  } catch (error) {
    if (version === state.composerVersion && session === state.session) { text(el('draft-status'), error.message); showStatus(`draft 저장 실패: ${error.message}`, 'error'); }
  } finally { if (version === state.composerVersion) setDraftBusy(false); }
}

function setDraftBusy(busy) {
  el('save-draft').disabled = busy || Boolean(state.draft);
  el('import-markdown').disabled = busy;
}

function invalidateDraftPreview() {
  state.composerVersion++;
  state.draft = null;
  state.markdownImportRequest = null;
  state.draftEditRequest = null;
  const preview = el('preview-section'); preview.replaceChildren(); preview.hidden = true;
  setDraftBusy(false);
}

async function importMarkdown() {
  const file = el('markdown-file').files?.[0];
  if (!file) { text(el('draft-status'), '가져올 Markdown 파일을 선택하세요.'); el('markdown-file').focus(); return; }
  const policy = selectedDraftPolicy();
  if (!policy) { text(el('draft-status'), '먼저 가져올 문서 범위를 선택하세요.'); return; }
  applyDraftPolicy(policy);
  for (const id of ['draft-title', 'draft-context', 'draft-scope', 'draft-usage']) if (!el(id).reportValidity()) return;
  if (!/\.(md|markdown)$/i.test(file.name) || file.size === 0 || file.size > 262144) {
    text(el('draft-status'), '비어 있지 않은 .md 또는 .markdown 파일을 선택하세요. 최대 크기는 256 KiB입니다.'); return;
  }
  const version = ++state.composerVersion; const session = state.session;
  const payload = { filename: file.name, title: el('draft-title').value, document_id: policy.document_id, context_id: policy.context_id, scope_id: policy.scope_id, usage_scope: policy.usage_scope };
  if (state.draftBaseDigest) payload.base_revision_digest = state.draftBaseDigest;
  setDraftBusy(true); text(el('draft-status'), '선택한 파일을 비공개 초안으로 가져오는 중…');
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (version !== state.composerVersion || session !== state.session) return;
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    payload.content_base64 = btoa(binary);
    const fingerprint = JSON.stringify(payload);
    if (state.markdownImportRequest?.fingerprint !== fingerprint) state.markdownImportRequest = { fingerprint, importId: nowCommand() };
    const draft = await request(`${apiBase}/draft-imports/markdown`, { method: 'POST', body: jsonBody({ ...payload, import_id: state.markdownImportRequest.importId }), sessionGuard: session });
    if (version !== state.composerVersion || session !== state.session) return;
    enterSavedDraftMode(draft);
    setValue(el('draft-body'), draft.revision.payload.body_markdown);
    setValue(el('draft-source-kind'), 'approved_import');
    text(el('draft-status'), `${draft.import.byte_length.toLocaleString()} bytes를 비공개 초안으로 저장했습니다. 원문을 확인한 뒤 공유 미리보기를 생성하세요.`);
    showStatus('파일을 비공개 초안으로 가져왔습니다. 공유 게시와 합의 승인은 별도 단계입니다.', 'success');
    renderPreviewStep(draft); el('draft-body').focus();
    void loadPrivateDrafts();
  } catch (error) {
    if (version === state.composerVersion && session === state.session) { text(el('draft-status'), error.message); showStatus(`Markdown 가져오기 실패: ${error.message}`, 'error'); }
  } finally { if (version === state.composerVersion) setDraftBusy(false); }
}

function renderPreviewStep(draft) {
  const section = el('preview-section'); section.replaceChildren(); section.hidden = false;
  const callout = document.createElement('div'); callout.className = 'preview-callout'; const heading = document.createElement('h3'); heading.textContent = '공유 게시 전 확인'; const copy = document.createElement('p'); copy.textContent = '이 단계에서 본문 전체가 아래 수신 조직에 공개될 수 있습니다. 미리보기의 설정과 원문을 확인한 뒤에만 게시하세요.'; const details = document.createElement('p'); details.textContent = `draft ${draft.draft_id || '—'} · ${draft.revision?.payload?.body_markdown ? new TextEncoder().encode(draft.revision.payload.body_markdown).length.toLocaleString() : '—'} bytes`;
  const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary-button'; button.textContent = '공유 게시 미리보기 생성'; button.addEventListener('click', () => createPublicationPreview(draft)); callout.append(heading, copy, details, button); section.append(callout);
}

async function createPublicationPreview(draft) {
  const version = state.composerVersion; const session = state.session;
  try {
    const preview = await request(`${apiBase}/publication-previews`, { method: 'POST', body: jsonBody({ draft_id: draft.draft_id }), sessionGuard: session });
    if (version !== state.composerVersion || session !== state.session) return;
    renderPublicationPreview(preview); showStatus('공유 게시 미리보기가 생성됐습니다. 수신 조직과 만료 시각을 확인하세요.', 'success');
  } catch (error) { if (version === state.composerVersion && session === state.session) showStatus(`미리보기 생성 실패: ${error.message}`, 'error'); }
}

function renderPublicationPreview(preview) {
  const section = el('preview-section'); section.replaceChildren(); const callout = document.createElement('div'); callout.className = 'preview-callout'; const heading = document.createElement('h3'); heading.textContent = '게시 미리보기'; const copy = document.createElement('p'); copy.textContent = `digest ${shortDigest(preview.revision_digest)} · ${preview.body_bytes ?? '—'} bytes · ${preview.expires_at ? `만료 ${formatDate(preview.expires_at)}` : '만료 시각 확인 필요'}`;
  const snapshot = preview.revision?.payload || {}; const snapshotBox = document.createElement('div'); snapshotBox.className = 'preview-snapshot'; const snapshotHeading = document.createElement('div'); snapshotHeading.className = 'source-view-heading'; const snapshotLabel = document.createElement('span'); snapshotLabel.textContent = 'IMMUTABLE PREVIEW SNAPSHOT'; const snapshotTitle = document.createElement('span'); snapshotTitle.textContent = snapshot.title || '제목 없음'; snapshotHeading.append(snapshotLabel, snapshotTitle); const snapshotBody = document.createElement('pre'); snapshotBody.className = 'markdown-source'; snapshotBody.textContent = snapshot.body_markdown || '미리보기 본문을 받지 못했습니다.'; snapshotBox.append(snapshotHeading, snapshotBody);
  const recipients = document.createElement('div'); recipients.className = 'recipient-list'; (preview.recipients || []).forEach((recipient) => { const tag = document.createElement('span'); tag.className = 'recipient-tag'; tag.textContent = recipient; recipients.append(tag); }); const confirm = document.createElement('label'); confirm.style.display = 'flex'; confirm.style.gridTemplateColumns = 'auto 1fr'; confirm.style.alignItems = 'center'; confirm.style.gap = '.55rem'; const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.id = 'confirm-shared'; checkbox.style.width = 'auto'; const confirmText = document.createElement('span'); confirmText.textContent = '위 원문과 수신 조직을 확인했고 공유 게시를 요청합니다.'; confirm.append(checkbox, confirmText); const button = document.createElement('button'); button.type = 'button'; button.className = 'primary-button'; button.textContent = '공용 원장에 게시'; button.disabled = true; checkbox.addEventListener('change', () => { button.disabled = !checkbox.checked; }); button.addEventListener('click', () => publishRevision(preview, checkbox)); callout.append(heading, copy, snapshotBox, recipients, confirm, button); section.append(callout);
}

async function publishRevision(preview, checkbox) {
  if (!checkbox.checked) return;
  const session = state.session; const version = state.composerVersion;
  const result = await executeMutation('/revisions', { preview_id: preview.preview_id, confirm_shared: true, command_id: nowCommand() }, '공유 개정본 게시', { command_type: 'publish_revision', target_id: preview.revision_digest });
  if (session !== state.session || version !== state.composerVersion) return;
  if (result?.status === 'committed') {
    text(el('draft-status'), '게시가 커밋됐습니다. 아래에서 검토 제안을 시작할 수 있습니다.');
    renderProposalStep(result?.result?.revision_digest || preview.revision_digest);
  }
}

function renderProposalStep(revisionDigest) {
  const section = el('preview-section');
  const revisionPayload = state.draft?.revision?.payload || {};
  const policies = (state.overview?.policies || []).filter((policy) => policy.document_id === revisionPayload.document_id && policy.context_id === revisionPayload.context_id && policy.scope_id === revisionPayload.scope_id && policy.usage_scope === revisionPayload.usage_scope && policy.channel_id === revisionPayload.channel_id);
  const callout = document.createElement('div'); callout.className = 'preview-callout';
  const heading = document.createElement('h3'); heading.textContent = '합의 검토 시작';
  const copy = document.createElement('p'); copy.textContent = '공유된 개정본에 맞는 정책을 확인해 대표자 검토를 시작합니다. 게시만으로 활성 합의가 만들어지지 않습니다.';
  const select = document.createElement('select'); select.setAttribute('aria-label', '합의 정책 선택');
  policies.forEach((policy) => { const option = document.createElement('option'); option.value = `${policy.policy_id}|${policy.policy_version}`; option.textContent = `${metadataLabel('contexts', policy.context_id)} · ${policy.label || '검토 정책'} · v${policy.policy_version}`; select.append(option); });
  const button = document.createElement('button'); button.type = 'button'; button.className = 'primary-button'; button.textContent = '검토 제안 제출'; button.disabled = !policies.length || !canPropose();
  button.addEventListener('click', async () => {
    const [policyId, policyVersion] = select.value.split('|');
    await executeMutation('/agreement-proposals', { revision_digest: revisionDigest, policy_id: policyId, policy_version: Number(policyVersion), command_id: nowCommand() }, '합의 검토 제안', { command_type: 'propose', target_id: revisionDigest });
  });
  if (!policies.length) { const noPolicy = document.createElement('p'); noPolicy.textContent = '이 개정본의 문서 범위와 일치하는 정책이 없어 제안을 제출할 수 없습니다.'; noPolicy.className = 'form-hint'; callout.append(heading, copy, noPolicy); } else { const hint = document.createElement('p'); hint.className = 'form-hint'; hint.textContent = canPropose() ? '정책을 확인한 뒤 검토 제안을 제출하세요.' : '이 계정에는 검토 제안 제출 권한이 없습니다.'; callout.append(heading, copy, select, hint, button); }
  section.replaceChildren(callout); section.hidden = false;
}

async function onResolverSubmit(event) {
  event.preventDefault(); const documents = [...el('resolve-documents').selectedOptions].map((option) => option.dataset.documentId).filter(Boolean); if (!documents.length) { showStatus('조회할 문서를 하나 선택하세요.', 'error'); return; }
  const session = state.session;
  const result = el('resolver-result'); result.hidden = true; text(el('resolver-status'), '현재 원장 상태와 활성 합의를 확인 중…');
  try { const response = await request(`${apiBase}/resolve`, { method: 'POST', body: jsonBody({ document_ids: documents, context_id: el('resolve-context').value.trim(), scope_id: el('resolve-scope').value.trim(), usage_scope: el('resolve-usage').value.trim() }), sessionGuard: session }); if (session !== state.session) return; renderResolverResult(response); text(el('resolver-status'), response.status === 'provided' ? '현재 확인 시점에 제공 가능한 결과입니다.' : '사용이 보류된 결과입니다.'); } catch (error) { if (session === state.session) { text(el('resolver-status'), error.message); showStatus(`컨텍스트 확인 실패: ${error.message}`, 'error'); } }
}

function renderResolverResult(response) {
  const result = el('resolver-result'); result.replaceChildren(); result.hidden = false; const heading = document.createElement('h3'); heading.textContent = response.status === 'provided' ? '권위 있는 컨텍스트' : '컨텍스트 제공 보류'; const copy = document.createElement('p'); copy.textContent = response.status === 'provided' ? '활성 합의와 현재 원장 상태를 확인한 문서만 아래에 포함됐습니다.' : response.reason || '현재 조건에서 규범적 사용을 확정할 수 없습니다.'; result.append(heading, copy);
  (response.documents || []).forEach((doc) => { const digest = document.createElement('p'); digest.className = 'result-digest'; digest.textContent = `${doc.title || '제목 없음'} · ${shortDigest(doc.revision_digest)} · agreement ${doc.agreement_id || '—'}`; const source = document.createElement('pre'); source.className = 'result-source'; source.textContent = doc.body_markdown || ''; result.append(digest, source); });
  if (response.manifest) {
    const checkpoint = response.manifest.checkpoint || {}; const manifest = document.createElement('p'); manifest.className = 'result-digest'; manifest.textContent = `manifest ${response.manifest.manifest_id || '—'} · epoch ${checkpoint.eligibility_epoch ?? response.manifest.eligibility_epoch ?? '—'} · 원장 block ${checkpoint.block_number ?? '—'} / tx ${checkpoint.transaction_index ?? '—'}`; result.append(manifest);
    const evidence = document.createElement('details'); evidence.className = 'technical-evidence'; const summary = document.createElement('summary'); summary.textContent = '전체 manifest와 checkpoint 보기'; const manifestJson = document.createElement('pre'); manifestJson.className = 'manifest-json'; manifestJson.textContent = JSON.stringify(response.manifest, null, 2); evidence.append(summary, manifestJson);
    const manifestActions = document.createElement('div'); manifestActions.className = 'manifest-actions'; const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'secondary-button'; copy.textContent = 'manifest JSON 복사'; copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(manifestJson.textContent); showStatus('manifest JSON을 클립보드에 복사했습니다.', 'success'); } catch { showStatus('브라우저가 클립보드 접근을 허용하지 않았습니다.', 'error'); } }); const download = document.createElement('button'); download.type = 'button'; download.className = 'secondary-button'; download.textContent = 'manifest JSON 다운로드'; download.addEventListener('click', () => { const blob = new Blob([manifestJson.textContent], { type: 'application/json' }); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${response.manifest.manifest_id || 'kcl-manifest'}.json`; anchor.click(); URL.revokeObjectURL(url); }); manifestActions.append(copy, download); evidence.append(manifestActions); result.append(evidence);
  }
}

async function switchPersona(event) {
  let selected;
  try { selected = JSON.parse(event.target.value); } catch { return; }
  if (!selected?.org_id || !selected?.actor_id || (selected.org_id === state.session?.actor?.org_id && selected.actor_id === state.session?.actor?.actor_id)) return;
  event.target.disabled = true;
  resetComposer(); clearPrivateDrafts(); clearCommands(); state.selectedDocumentKey = null; state.selectedRevisionDigest = null; state.selectedProposalId = null;
  clearSourceState();
  try { const session = await request('/api/session', { method: 'POST', body: jsonBody({ org_id: selected.org_id, actor_id: selected.actor_id }) }); state.session = session; showStatus('검토자 세션을 바꿨습니다. 최신 권한과 문서를 다시 읽습니다.', 'success'); text(el('footer-actor'), `${session.actor.org_id} · ${session.actor.actor_id}`); await loadOverview({ preserveSelection: false }); } catch (error) { showStatus(`검토자 변경 실패: ${error.message}`, 'error'); } finally { event.target.disabled = false; await loadPrivateDrafts(); await loadCommands(); await loadSources(); }
}

function resetComposer() {
  invalidateDraftPreview();
  state.draft = null; state.draftBaseDigest = null;
  state.draftSourceId = null;
  setDraftSlotReadOnly(false); document.querySelector('.markdown-import').hidden = false;
  text(el('composer-title'), '새 개정본 작성'); text(el('save-draft'), '비공개 초안 저장');
  text(el('draft-origin'), ''); el('draft-origin').hidden = true;
  const form = el('draft-form'); form?.reset();
  syncDraftPolicies();
  const preview = el('preview-section'); if (preview) { preview.replaceChildren(); preview.hidden = true; }
  text(el('draft-status'), '저장 전에는 공용 원장에 기록되지 않습니다.');
  el('composer-panel').hidden = true;
}

function openComposer(mode, doc = null) {
  resetComposer();
  state.draft = null; state.draftBaseDigest = mode === 'revise' ? doc?.revision_digest || null : null;
  const form = el('draft-form'); form?.reset();
  if (mode === 'revise' && doc?.payload) {
    setValue(el('draft-title'), doc.payload.title);
    setValue(el('draft-body'), doc.payload.body_markdown);
    setValue(el('draft-context'), doc.payload.context_id);
    setValue(el('draft-scope'), doc.payload.scope_id);
    setValue(el('draft-usage'), doc.payload.usage_scope);
  }
  const policy = mode === 'revise' && doc?.payload
    ? (state.overview?.policies || []).find((candidate) => candidate.document_id === doc.payload.document_id && candidate.context_id === doc.payload.context_id && candidate.scope_id === doc.payload.scope_id && candidate.usage_scope === doc.payload.usage_scope)
    : draftPolicies()[0];
  syncDraftPolicies(policy ? `${policy.policy_id}|${policy.policy_version}` : null);
  if (mode === 'new') applyDraftPolicy(policy);
  const preview = el('preview-section'); if (preview) { preview.replaceChildren(); preview.hidden = true; }
  text(el('draft-status'), mode === 'revise' ? '현재 개정본을 바탕으로 비공개 초안을 작성합니다.' : policy ? '선택한 정책의 문서 범위에 맞춰 비공개 초안을 작성합니다.' : '작성 가능한 정책이 없어 초안을 만들 수 없습니다.');
  el('composer-panel').hidden = false; el('draft-title').focus();
}

function bindEvents() {
  el('refresh-overview').addEventListener('click', async () => { clearStatus(); try { await loadOverview(); showStatus('원장 체크포인트에서 최신 상태를 읽었습니다.', 'success'); } catch (error) { showStatus(error.message, 'error'); } });
  el('refresh-drafts').addEventListener('click', () => loadPrivateDrafts());
  el('more-drafts').addEventListener('click', () => loadPrivateDrafts(true));
  el('refresh-commands')?.addEventListener('click', () => loadCommands());
  el('more-commands')?.addEventListener('click', () => loadCommands(true));
  el('source-manifest-file')?.addEventListener('change', () => { void readSourceManifest(); });
  el('source-folder')?.addEventListener('change', () => { state.sourceOperationVersion++; state.sourceFolderSelected = true; renderSelectedSourceFiles(); });
  el('source-import')?.addEventListener('click', () => { void importSourceFiles(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (state.commandPollTimer) window.clearTimeout(state.commandPollTimer); state.commandPollTimer = null; }
    else scheduleCommandPoll();
  });
  el('persona-select').addEventListener('change', switchPersona);
  el('logout-button')?.addEventListener('click', async () => {
    try {
      const logoutPath = typeof state.session?.logout_url === 'string' && state.session.logout_url.startsWith('/auth/logout') ? state.session.logout_url : '/auth/logout';
      await request(logoutPath, { method: 'POST' });
      const authMode = state.session?.auth_mode || 'oidc';
      state.session = null;
      state.overview = null;
      clearCommands();
      clearSourceState();
      renderAuthState({ auth_mode: authMode, actor: null, login_url: '/auth/login' });
      showStatus('로그아웃했습니다.', 'success');
    } catch (error) { showStatus(`로그아웃 실패: ${error.message}`, 'error'); }
  });
  el('dismiss-demo-note').addEventListener('click', () => { el('demo-note').hidden = true; });
  document.querySelectorAll('[data-workspace]').forEach((button) => button.addEventListener('click', () => { setWorkspace(button.dataset.workspace); const target = document.getElementById(button.dataset.workspace === 'review' ? 'review-inbox-title' : `${button.dataset.workspace}-title`); if (target) { target.tabIndex = -1; target.focus({preventScroll:true}); target.scrollIntoView({behavior:'smooth',block:'start'}); } }));
  el('open-composer').addEventListener('click', () => openComposer('new'));
  el('close-composer').addEventListener('click', resetComposer);
  el('draft-form').addEventListener('submit', onDraftSubmit);
  el('import-markdown').addEventListener('click', importMarkdown);
  el('draft-form').addEventListener('input', () => { invalidateDraftPreview(); text(el('draft-status'), '변경한 내용을 비공개 초안으로 저장한 뒤 공유 미리보기를 다시 생성하세요.'); });
  el('draft-policy')?.addEventListener('change', () => { const policy = selectedDraftPolicy(); applyDraftPolicy(policy); invalidateDraftPreview(); text(el('draft-status'), policy ? '선택한 정책의 문서 범위에 맞춰 작성합니다.' : '작성할 문서 범위를 선택하세요.'); });
  el('resolver-form').addEventListener('submit', onResolverSubmit);
  el('resolve-documents').addEventListener('change', (event) => {
    const selected = currentDocuments().find((doc) => slotKeyFor(doc.payload) === event.target.value);
  if (selected) { state.selectedDocumentKey = slotKeyFor(selected.payload); state.selectedRevisionDigest = null; state.selectedProposalId = null; state.compareRevisionDigest = null; syncResolverFields(selected); renderOverview(); }
  });
}

async function init() {
  bindEvents();
  try {
    await loadSession();
    if (state.session?.auth_mode && !state.session.actor) return;
    await loadOverview({ preserveSelection: false });
    setWorkspace(outstandingReviews().length ? 'review' : 'documents');
    await loadPrivateDrafts();
    await loadCommands();
    await loadSources();
  } catch (error) { showStatus(error.message, 'error'); const detail = el('document-detail-content'); detail.replaceChildren(); const message = document.createElement('p'); message.className = 'empty-state'; message.textContent = 'API에서 워크스페이스를 읽지 못했습니다. 서버 상태를 확인하고 새로고침하세요.'; detail.append(message); }
}

init();
