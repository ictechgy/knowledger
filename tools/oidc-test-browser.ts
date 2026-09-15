/** In-memory browser for local OIDC acceptance tests. Never logs cookie/token URLs. */
export class OidcTestBrowser {
  private readonly cookies = new Map<string, Map<string, { name: string; value: string; path: string; secure: boolean }>>();
  private callback: URL | undefined;
  private readonly origins: string[];
  constructor(origins: string[]) { this.origins = [...origins]; }

  async request(target: string | URL, init: RequestInit = {}): Promise<Response> {
    const url = new URL(target);
    if (!this.origins.includes(url.origin)) throw new Error('Test browser refused an unexpected origin');
    // Browser cookies are scoped to a host and path, not a TCP port.
    const jar = this.cookies.get(url.hostname) ?? new Map();
    const headers = new Headers(init.headers);
    headers.set('Cookie', [...jar.values()].filter(cookie => (!cookie.secure || url.protocol === 'https:')
      && (url.pathname === cookie.path || url.pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`)))
      .sort((a, b) => b.path.length - a.path.length).map(cookie => `${cookie.name}=${cookie.value}`).join('; '));
    const response = await fetch(url, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(';')[0]; const separator = pair.indexOf('=');
      const name = pair.slice(0, separator); const content = pair.slice(separator + 1);
      const path = /(?:^|;\s*)Path=([^;]*)/i.exec(value)?.[1] || url.pathname.slice(0, url.pathname.lastIndexOf('/')) || '/';
      const key = `${name}\u0000${path}`;
      if (/Max-Age=0(?:;|$)/i.test(value)) jar.delete(key);
      else jar.set(key, { name, value: content, path, secure: /(?:^|;\s*)Secure(?:;|$)/i.test(value) });
    }
    this.cookies.set(url.hostname, jar);
    return response;
  }

  async login(appOrigin: string, subject: string, mutate?: { authorization?: (url: URL) => void; callback?: (url: URL) => void }): Promise<Response> {
    let url = new URL('/auth/login', appOrigin);
    let response = await this.request(url);
    let changedAuthorization = false;
    for (let step = 0; step < 20; step++) {
      const location = response.headers.get('location');
      if (location) {
        url = new URL(location, url);
        if (url.origin === appOrigin && url.pathname === '/auth/callback') {
          this.callback = new URL(url);
          mutate?.callback?.(url);
        } else if (url.origin !== appOrigin && !changedAuthorization) {
          mutate?.authorization?.(url); changedAuthorization = true;
        }
        response = await this.request(url);
        if (url.origin === appOrigin && url.pathname === '/') return response;
        continue;
      }
      if (response.status !== 200 || url.origin === appOrigin) return response;
      const html = await response.text();
      const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
      if (!csrf) {
        const xsrf = html.match(/name="xsrf" value="([^"]+)"/)?.[1];
        const action = html.match(/<form[^>]+action="([^"]+)"/)?.[1];
        if (xsrf && action && html.includes('name="logout"')) {
          const target = new URL(action.replaceAll('&amp;', '&'), url);
          if (target.origin !== url.origin) throw new Error('Logout form changed issuer origin');
          response = await this.request(target, { method: 'POST', headers: { Origin: url.origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ xsrf, logout: 'yes' }) });
          continue;
        }
        const fields = [...html.matchAll(/name="([a-zA-Z_-]+)"/g)].map(match => match[1]);
        throw new Error(`Unsupported development interaction form (${url.pathname.split('/')[1]}: ${fields.join(',')})`);
      }
      const prompt = html.includes('name="account_id"') ? 'login' : 'consent';
      response = await this.request(url, { method: 'POST', headers: { Origin: url.origin, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf, prompt, ...(prompt === 'login' ? { account_id: subject } : {}) }) });
    }
    throw new Error('Development login exceeded the redirect limit');
  }

  replayCallback(): Promise<Response> {
    if (!this.callback) throw new Error('No callback has been observed');
    return this.request(this.callback);
  }
}
