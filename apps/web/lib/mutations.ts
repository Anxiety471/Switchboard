import type { RegisteredAgent, RevokedAgent } from '@switchboard/shared';
import { readDeskConfig, type DeskConfig, type EnvSource } from './config';
import {
  DESK_COOKIE,
  FLASH_COOKIE,
  THEME_COOKIE,
  TOKEN_COOKIE,
  clearCookie,
  flashCookie,
  formCsrfValid,
  openIssuedToken,
  safeReturnPath,
  sealIssuedToken,
  secretsEqual,
  serializeCookie,
  sessionCookie,
  themeCookie,
  tokenCookie,
  type Flash,
  ReturnPathError,
} from './desk';
import {
  clearLoginFailures,
  loginLimited,
  loginPlacement,
  noteLoginFailure,
} from './login-limit';
import {
  closeDeskSession,
  confirmTokenHandover,
  discardPendingToken,
  issueAgentToken,
  openDeskSession,
  readDeskSession,
  registerAgent,
  revokeAgentToken,
  saveDeskNotice,
  type DeskResult,
} from './ledger';

const AGENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DeskAction =
  | { kind: 'redirect'; location: string; cookies: string[] }
  | { kind: 'status'; status: 400 | 403 };

export type LedgerWrites = {
  registerAgent(
    config: DeskConfig,
    name: string,
  ): Promise<DeskResult<RegisteredAgent>>;
  issueAgentToken(
    config: DeskConfig,
    id: string,
  ): Promise<DeskResult<RegisteredAgent>>;
  revokeAgentToken(
    config: DeskConfig,
    id: string,
  ): Promise<DeskResult<RevokedAgent>>;
};

export type DeskDirectory = {
  openSession(
    config: DeskConfig,
  ): Promise<DeskResult<{ id: string; csrfToken: string }>>;
  closeSession(config: DeskConfig, id: string): Promise<DeskResult<true>>;
  readSession(
    config: DeskConfig,
    id: string,
  ): Promise<DeskResult<{ csrfToken: string }>>;
  saveNotice(
    config: DeskConfig,
    id: string,
    flash: Flash,
  ): Promise<DeskResult<{ id: string }>>;
  confirmHandover(config: DeskConfig, id: string): Promise<DeskResult<true>>;
  discardPending(config: DeskConfig, id: string): Promise<DeskResult<true>>;
};

const defaultWrites: LedgerWrites = {
  registerAgent,
  issueAgentToken,
  revokeAgentToken,
};

const defaultDirectory: DeskDirectory = {
  openSession: openDeskSession,
  closeSession: closeDeskSession,
  readSession: readDeskSession,
  saveNotice: saveDeskNotice,
  confirmHandover: confirmTokenHandover,
  discardPending: discardPendingToken,
};

export type DeskFormInput = {
  env: EnvSource;
  secure: boolean;
  origin: string | null;
  host: string | null;
  sessionId: string | undefined;
  tokenCookie: string | undefined;
  clientKey: string | undefined;
  now?: number;
  wrongGuessDelayMs?: number;
  writes?: LedgerWrites;
  directory?: DeskDirectory;
};

function redirect(location: string, cookies: string[] = []): DeskAction {
  return { kind: 'redirect', location, cookies };
}

function status(code: 400 | 403): DeskAction {
  return { kind: 'status', status: code };
}

export const WRONG_GUESS_DELAY_MS = 500;

function wait(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isAction(value: { id: string } | DeskAction): value is DeskAction {
  return 'kind' in value;
}

function sameOrigin(origin: string | null, host: string | null): boolean {
  if (origin === null || host === null || host === '') {
    return false;
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return url.host === host;
}

function csrfField(form: FormData): string {
  const value = form.get('csrf');
  return typeof value === 'string' ? value : '';
}

function agentId(form: FormData): string | undefined {
  const id = form.get('id');
  if (typeof id !== 'string' || !AGENT_ID.test(id)) {
    return undefined;
  }
  return id;
}

function themeCookieHeader(form: FormData, secure: boolean): string[] {
  const theme = form.get('theme');
  if (theme !== 'light' && theme !== 'dark') {
    return [];
  }
  return [serializeCookie(THEME_COOKIE, theme, themeCookie(secure))];
}

function clearedSession(secure: boolean): string[] {
  return [
    clearCookie(DESK_COOKIE, secure),
    clearCookie(FLASH_COOKIE, secure),
    clearCookie(TOKEN_COOKIE, secure, 'strict'),
  ];
}

export async function handleDeskForm(
  form: FormData,
  input: DeskFormInput,
): Promise<DeskAction> {
  if (!sameOrigin(input.origin, input.host)) {
    return status(403);
  }
  let returnTo: string;
  try {
    returnTo = safeReturnPath(form.get('returnTo'));
  } catch (error) {
    if (error instanceof ReturnPathError) {
      return status(400);
    }
    throw error;
  }

  const writes = input.writes ?? defaultWrites;
  const directory = input.directory ?? defaultDirectory;
  const now = input.now ?? Date.now();
  const config = readDeskConfig(input.env);
  const intent = form.get('intent');
  const secure = input.secure;

  if (intent === 'theme') {
    const cookies = themeCookieHeader(form, secure);
    if (config === undefined) {
      return redirect(returnTo, cookies);
    }
    if (input.sessionId !== undefined && input.sessionId !== '') {
      const session = await directory.readSession(config, input.sessionId);
      if (session.ok) {
        if (!secretsEqual(session.value.csrfToken, csrfField(form))) {
          return status(403);
        }
        return redirect(returnTo, cookies);
      }
      if (
        session.failure !== 'not_found' &&
        session.failure !== 'invalid' &&
        session.failure !== 'unauthorized'
      ) {
        return status(403);
      }
    }
    if (!formCsrfValid(config.secret, csrfField(form), now)) {
      return status(403);
    }
    return redirect(returnTo, cookies);
  }

  if (config === undefined) {
    if (intent === 'logout') {
      return redirect('/', clearedSession(secure));
    }
    return redirect('/?error=unconfigured');
  }

  if (intent === 'login') {
    if (!formCsrfValid(config.secret, csrfField(form), now)) {
      return status(403);
    }
    const clientKey = input.clientKey;
    const delayMs = input.wrongGuessDelayMs ?? WRONG_GUESS_DELAY_MS;
    const placement =
      clientKey === undefined ? 'open' : loginPlacement(clientKey, now);
    if (placement === 'locked') {
      await wait(delayMs);
      return redirect('/?error=limited');
    }
    const password = form.get('password');
    const presented = typeof password === 'string' ? password : '';
    const started = performance.now();
    const accepted = secretsEqual(config.secret, presented);
    const overflowTripped =
      placement === 'overflow' &&
      clientKey !== undefined &&
      loginLimited(clientKey, now);
    if (!accepted) {
      if (clientKey !== undefined) {
        noteLoginFailure(clientKey, now);
      }
      await wait(delayMs);
      if (overflowTripped) {
        return redirect('/?error=limited');
      }
      return redirect('/?error=unauthorized');
    }
    const opened = await directory.openSession(config);
    if (!opened.ok) {
      return redirect(`/?error=${opened.failure}`);
    }
    if (placement === 'overflow') {
      await wait(delayMs - (performance.now() - started));
    } else if (clientKey !== undefined) {
      clearLoginFailures(clientKey);
    }
    return redirect('/', [
      serializeCookie(DESK_COOKIE, opened.value.id, sessionCookie(secure)),
      clearCookie(FLASH_COOKIE, secure),
      clearCookie(TOKEN_COOKIE, secure, 'strict'),
    ]);
  }

  if (intent === 'logout') {
    const auth = await authorizeSession(directory, config, form, input);
    if (isAction(auth)) {
      return auth;
    }
    await directory.closeSession(config, auth.id);
    return redirect('/', clearedSession(secure));
  }

  const auth = await authorizeSession(directory, config, form, input);
  if (isAction(auth)) {
    return auth;
  }

  if (intent === 'ack-token') {
    return acknowledgeToken(directory, config, input, secure, returnTo);
  }

  if (intent === 'register') {
    const name = form.get('name');
    if (typeof name !== 'string' || name === '') {
      return remember(directory, config, auth.id, secure, returnTo, {
        type: 'failure',
        failure: 'invalid',
      });
    }
    const result = await writes.registerAgent(config, name);
    if (!result.ok) {
      if (result.failure === 'unknown') {
        return redirect('/?error=unknown');
      }
      return remember(directory, config, auth.id, secure, returnTo, {
        type: 'failure',
        failure: result.failure,
      });
    }
    return handToken(directory, config, secure, returnTo, result.value, false);
  }

  if (intent === 'issue' || intent === 'revoke') {
    const id = agentId(form);
    if (id === undefined) {
      return remember(directory, config, auth.id, secure, returnTo, {
        type: 'failure',
        failure: 'invalid',
      });
    }
    if (intent === 'issue') {
      const result = await writes.issueAgentToken(config, id);
      if (!result.ok) {
        if (result.failure === 'unknown') {
          await directory.discardPending(config, id);
          return redirect('/?error=handover');
        }
        return remember(directory, config, auth.id, secure, returnTo, {
          type: 'failure',
          failure: result.failure,
        });
      }
      return handToken(directory, config, secure, returnTo, result.value, true);
    }
    const result = await writes.revokeAgentToken(config, id);
    if (!result.ok) {
      if (result.failure === 'unknown') {
        return redirect('/?error=unknown');
      }
      return remember(directory, config, auth.id, secure, returnTo, {
        type: 'failure',
        failure: result.failure,
      });
    }
    return remember(directory, config, auth.id, secure, returnTo, {
      type: 'revoked',
      name: result.value.name,
    });
  }

  return redirect(returnTo);
}

async function authorizeSession(
  directory: DeskDirectory,
  config: DeskConfig,
  form: FormData,
  input: DeskFormInput,
): Promise<{ id: string } | DeskAction> {
  const sessionId = input.sessionId;
  if (sessionId === undefined || sessionId === '') {
    return redirect('/?error=unauthorized');
  }
  const session = await directory.readSession(config, sessionId);
  if (!session.ok) {
    if (
      session.failure === 'not_found' ||
      session.failure === 'invalid' ||
      session.failure === 'unauthorized'
    ) {
      return redirect('/?error=unauthorized', [
        clearCookie(DESK_COOKIE, input.secure),
      ]);
    }
    return redirect(`/?error=${session.failure}`);
  }
  if (!secretsEqual(session.value.csrfToken, csrfField(form))) {
    return status(403);
  }
  return { id: sessionId };
}

async function handToken(
  directory: DeskDirectory,
  config: DeskConfig,
  secure: boolean,
  returnTo: string,
  slip: { id: string; name: string; token: string },
  handover: boolean,
): Promise<DeskAction> {
  let sealed: string;
  try {
    sealed = sealIssuedToken(config.secret, {
      id: slip.id,
      name: slip.name,
      token: slip.token,
      handover,
      exp: Date.now() + 120_000,
    });
  } catch {
    sealed = '';
  }
  if (sealed === '') {
    if (handover) {
      await directory.discardPending(config, slip.id);
    }
    return redirect('/?error=handover');
  }
  return redirect(returnTo, [
    serializeCookie(TOKEN_COOKIE, sealed, tokenCookie(secure)),
  ]);
}

async function acknowledgeToken(
  directory: DeskDirectory,
  config: DeskConfig,
  input: DeskFormInput,
  secure: boolean,
  returnTo: string,
): Promise<DeskAction> {
  const raw = input.tokenCookie;
  if (raw === undefined || raw === '') {
    return redirect(returnTo);
  }
  const slip = openIssuedToken(config.secret, raw);
  if (slip === undefined) {
    return redirect('/?error=handover', [
      clearCookie(TOKEN_COOKIE, secure, 'strict'),
    ]);
  }
  if (slip.handover) {
    const confirmed = await directory.confirmHandover(config, slip.id);
    if (!confirmed.ok && confirmed.failure !== 'not_found') {
      return redirect('/?error=handover');
    }
  }
  return redirect(returnTo, [clearCookie(TOKEN_COOKIE, secure, 'strict')]);
}

async function remember(
  directory: DeskDirectory,
  config: DeskConfig,
  sessionId: string,
  secure: boolean,
  returnTo: string,
  flash: Flash,
): Promise<DeskAction> {
  const saved = await directory.saveNotice(config, sessionId, flash);
  if (!saved.ok) {
    if (flash.type === 'issued') {
      return redirect('/?error=unknown');
    }
    return redirect(returnTo);
  }
  return redirect(returnTo, [
    serializeCookie(FLASH_COOKIE, saved.value.id, flashCookie(secure)),
  ]);
}
