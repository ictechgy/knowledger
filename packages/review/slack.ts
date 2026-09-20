import { performance } from 'node:perf_hooks';
import { boundedJson } from '../http/bounded-json.ts';

export interface SlackAddress { team_id: string; user_id: string; dm_id: string }
export interface SlackAcceptance { provider: 'slack'; team_id: string; channel: string; ts: string }
export type SlackResult = { status: 'provider_accepted'; receipt: SlackAcceptance }
  | { status: 'retry_wait' | 'blocked' | 'unknown'; code: string; retry_after_ms?: number };
export interface SlackAdapterOptions {
  address: SlackAddress; appUrl: string;
  getBotToken(signal: AbortSignal): string | Promise<string>;
  timeoutMs?: number; fetch?: typeof fetch;
}
export function slackAddress(value: SlackAddress): SlackAddress {
  if (!value || Object.keys(value).sort().join(',') !== 'dm_id,team_id,user_id'
    || typeof value.team_id !== 'string' || typeof value.user_id !== 'string' || typeof value.dm_id !== 'string'
    || !/^T[A-Z0-9]{2,31}$/.test(value.team_id) || !/^[UW][A-Z0-9]{2,31}$/.test(value.user_id)
    || !/^D[A-Z0-9]{2,31}$/.test(value.dm_id)) throw new TypeError('Invalid Slack address');
  return Object.freeze({ ...value });
}
export function slackAppUrl(value: string): string {
  let url: URL; try { url = new URL(value); } catch { throw new TypeError('Invalid Slack app URL'); }
  if (typeof value !== 'string' || value.length > 1024 || url.protocol !== 'https:' || url.username || url.password
    || url.search || url.hash || /[<>|&\s]/.test(value) || url.href !== value) throw new TypeError('Invalid Slack app URL');
  return url.href;
}
export function slackAcceptance(value: any, address?: SlackAddress): SlackAcceptance {
  if (!value || Object.keys(value).sort().join(',') !== 'channel,provider,team_id,ts' || value.provider !== 'slack'
    || typeof value.team_id !== 'string' || typeof value.channel !== 'string' || typeof value.ts !== 'string'
    || !/^T[A-Z0-9]{2,31}$/.test(value.team_id) || !/^D[A-Z0-9]{2,31}$/.test(value.channel) || !/^[0-9]{1,16}\.[0-9]{6}$/.test(value.ts)
    || (address && (value.team_id !== address.team_id || value.channel !== address.dm_id))) throw new TypeError('Invalid Slack acceptance');
  return { ...value };
}

/** A provider acceptance is not a peer receipt, a read receipt or a human approval. */
export function createSlackAdapter(options: SlackAdapterOptions) {
  const address = slackAddress(options.address); const appUrl = slackAppUrl(options.appUrl);
  const timeout = options.timeoutMs ?? 10000; const getToken = options.getBotToken; const fetchImpl = options.fetch ?? fetch;
  if (typeof getToken !== 'function' || !Number.isSafeInteger(timeout) || timeout < 10 || timeout > 30000) throw new TypeError('Invalid Slack adapter');
  return { address, appUrl, async send(phase: 'due' | 'overdue', beforeSend: (signal: AbortSignal) => Promise<boolean>, signal: AbortSignal): Promise<SlackResult> {
    if (!['due', 'overdue'].includes(phase) || typeof beforeSend !== 'function') throw new TypeError('Invalid Slack notice');
    const controller = new AbortController(); const deadline = performance.now() + timeout; let posted = false;
    const uncertain = (): SlackResult => ({ status: posted ? 'unknown' : 'retry_wait', code: posted ? 'SLACK_RESULT_UNKNOWN' : 'SLACK_UNAVAILABLE', retry_after_ms: 1000 });
    let reject!: (reason: Error) => void; const cancelled = new Promise<never>((_, fail) => { reject = fail; });
    const abort = () => controller.abort(); const onAbort = () => reject(new Error('SLACK_CANCELLED'));
    controller.signal.addEventListener('abort', onAbort, { once: true }); signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeout); if (signal.aborted) abort();
    const check = () => { if (controller.signal.aborted || performance.now() >= deadline) throw new Error('SLACK_CANCELLED'); };
    const work = async (): Promise<SlackResult> => {
      const authorize = async () => { check(); const allowed = await beforeSend(controller.signal); check(); if (allowed !== true) throw new SlackControl({ status: 'blocked', code: 'SLACK_ACCESS_DENIED' }); };
      await authorize(); const token = await getToken(controller.signal); check();
      if (typeof token !== 'string' || !/^xoxb-[A-Za-z0-9-]{1,8000}$/.test(token)) return { status: 'blocked', code: 'SLACK_CREDENTIAL_UNAVAILABLE' };
      const call = async (method: 'auth.test' | 'conversations.open' | 'chat.postMessage', body: unknown) => {
        await authorize(); if (method === 'chat.postMessage') posted = true;
        const response = await fetchImpl(`https://slack.com/api/${method}`, { method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json' }, body: JSON.stringify(body) });
        try { check(); } catch (error) { void response.body?.cancel().catch(() => undefined); throw error; }
        if (response.status === 429) {
          void response.body?.cancel().catch(() => undefined);
          const header = response.headers.get('retry-after'); const seconds = header && /^[0-9]{1,8}$/.test(header) ? Number(header) : NaN;
          // An unusable or excessive Retry-After never causes an early retry.
          throw new SlackControl(Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 86400
            ? { status: 'retry_wait', code: 'SLACK_RATE_LIMITED', retry_after_ms: seconds * 1000 }
            : { status: 'blocked', code: 'SLACK_RATE_LIMIT_UNAVAILABLE' });
        }
        if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new Error('SLACK_HTTP_UNAVAILABLE'); }
        const value: any = await boundedJson(response, 64 * 1024, controller.signal); check();
        if (value?.ok === false) {
          // Slack documents partial success for internal/fatal errors. Unknown errors are also ambiguous after POST.
          const denied = ['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive', 'missing_scope', 'no_permission', 'channel_not_found', 'user_not_found', 'ekm_access_denied', 'is_archived'];
          throw new SlackControl(denied.includes(value.error) ? { status: 'blocked', code: 'SLACK_REJECTED' } : uncertain());
        }
        if (value?.ok !== true) throw new Error('SLACK_INVALID_RESPONSE'); return value;
      };
      const auth = await call('auth.test', {});
      if (auth.team_id !== address.team_id || typeof auth.bot_id !== 'string' || !/^B[A-Z0-9]{2,31}$/.test(auth.bot_id)) return { status: 'blocked', code: 'SLACK_WORKSPACE_MISMATCH' };
      const opened = await call('conversations.open', { users: address.user_id, return_im: true });
      if (opened.channel?.id !== address.dm_id || opened.channel?.is_im !== true || opened.channel?.user !== address.user_id) return { status: 'blocked', code: 'SLACK_DM_MISMATCH' };
      const text = `Knowledger: ${phase === 'overdue' ? '검토 기한이 지났습니다.' : '검토 기한이 되었습니다.'} 로그인 후 기한 알림을 확인하세요.\n<${appUrl}|Knowledger 열기>`;
      const value = await call('chat.postMessage', { channel: address.dm_id, text, mrkdwn: true, parse: 'none',
        unfurl_links: false, unfurl_media: false, unfurl_app_links: false });
      const receipt = slackAcceptance({ provider: 'slack', team_id: address.team_id, channel: value.channel, ts: value.ts }, address);
      return { status: 'provider_accepted', receipt };
    };
    try { return await Promise.race([work(), cancelled]); }
    catch (error: any) {
      // Only results created in this adapter may escape; external callbacks can throw arbitrary values.
      if (error instanceof SlackControl) return error.result;
      return uncertain();
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', onAbort); controller.abort(); }
  } };
}
class SlackControl extends Error {
  readonly result: SlackResult;
  constructor(result: SlackResult) { super('SLACK_CONTROL'); this.result = result; }
}
