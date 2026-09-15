import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Actor } from '../storage/local-ledger.ts';

export interface AuthenticatedSession {
  id: string;
  csrf: string;
  actor: Actor;
  expires: number;
}

/** Browser input never selects the authenticated actor. */
export interface ApplicationAuthentication {
  readonly mode: 'oidc-development' | 'oidc';
  readonly origin: string;
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  session(req: IncomingMessage): Promise<AuthenticatedSession | undefined>;
  run<T>(session: AuthenticatedSession, operation: () => Promise<T>): Promise<T>;
  assertCurrentActor(actor: Actor): Promise<void>;
  close(): void | Promise<void>;
}

export class AuthenticationError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  constructor(code: string, status = 401, retryable = false) {
    super(status === 503 ? '로그인 서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.' : '로그인 상태 또는 현재 권한을 확인할 수 없습니다. 다시 로그인해 주세요.');
    this.code = code; this.status = status; this.retryable = retryable;
  }
}
