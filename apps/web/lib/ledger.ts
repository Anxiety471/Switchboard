import type {
  DashboardAgent,
  HistoryPage,
  InboxPage,
  RegisteredAgent,
  RevokedAgent,
} from '@switchboard/shared';
import type { DeskConfig } from './config';
import type { Flash } from './desk';

const TIMEOUT_MS = 8_000;

export type DeskFailure =
  | 'unconfigured'
  | 'unreachable'
  | 'database_unavailable'
  | 'unauthorized'
  | 'invalid'
  | 'conflict'
  | 'not_found'
  | 'failed'
  | 'unknown'
  | 'handover'
  | 'limited';

export type DeskResult<T> =
  { ok: true; value: T } | { ok: false; failure: DeskFailure };

export type LedgerSnapshot = {
  agents: DashboardAgent[];
  history: HistoryPage;
  inbox: InboxPage | null;
  inboxMissing: boolean;
  historyReset: boolean;
  inboxReset: boolean;
};

export type LedgerSelection = {
  inboxId: string | undefined;
  historyAfter: string | undefined;
  inboxAfter: string | undefined;
};

type RequestInit = {
  method: 'GET' | 'POST' | 'DELETE';
  query?: Record<string, string>;
  body?: unknown;
  allowEmpty?: boolean;
};

const SESSION_ID = /^[A-Za-z0-9_-]{32,128}$/;

function joinUrl(base: string, path: string): URL {
  const url = new URL(base);
  const prefix = url.pathname.replace(/\/$/, '');
  url.pathname = `${prefix}${path}`;
  url.search = '';
  url.hash = '';
  return url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failureStatus(status: number): DeskFailure {
  if (status === 503) {
    return 'database_unavailable';
  }
  if (status === 401) {
    return 'unauthorized';
  }
  if (status === 409) {
    return 'conflict';
  }
  if (status === 404) {
    return 'not_found';
  }
  if (status === 400 || status === 413) {
    return 'invalid';
  }
  return 'failed';
}

async function request(
  config: DeskConfig,
  path: string,
  init: RequestInit,
): Promise<DeskResult<unknown>> {
  const url = joinUrl(config.url, path);
  if (init.query !== undefined) {
    for (const [key, value] of Object.entries(init.query)) {
      url.searchParams.set(key, value);
    }
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers: {
        accept: 'application/json',
        'x-dashboard-secret': config.secret,
        ...(init.body !== undefined
          ? { 'content-type': 'application/json' }
          : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false, failure: 'unreachable' };
  }
  const text = await response.text();
  if (!response.ok) {
    return { ok: false, failure: failureStatus(response.status) };
  }
  if (text === '') {
    if (init.allowEmpty === true && response.ok) {
      return { ok: true, value: null };
    }
    return { ok: false, failure: 'failed' };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, failure: 'failed' };
  }
}

function parseAgent(value: unknown): DashboardAgent | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.online !== 'boolean' ||
    !(value.lastSeenAt === null || typeof value.lastSeenAt === 'string') ||
    typeof value.createdAt !== 'string' ||
    typeof value.tokenRevoked !== 'boolean' ||
    'token' in value
  ) {
    return undefined;
  }
  return {
    id: value.id,
    name: value.name,
    online: value.online,
    lastSeenAt: value.lastSeenAt,
    createdAt: value.createdAt,
    tokenRevoked: value.tokenRevoked,
  };
}

function parseAgents(value: unknown): DashboardAgent[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.agents)) {
    return undefined;
  }
  const agents: DashboardAgent[] = [];
  for (const agent of value.agents) {
    const parsed = parseAgent(agent);
    if (parsed === undefined) {
      return undefined;
    }
    agents.push(parsed);
  }
  return agents;
}

function parseHistoryMessage(
  value: unknown,
): HistoryPage['messages'][number] | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.from !== 'string' ||
    typeof value.to !== 'string' ||
    typeof value.body !== 'string' ||
    typeof value.createdAt !== 'string'
  ) {
    return undefined;
  }
  return {
    id: value.id,
    from: value.from,
    to: value.to,
    body: value.body,
    createdAt: value.createdAt,
  };
}

function parseHistory(value: unknown): HistoryPage | undefined {
  if (
    !isRecord(value) ||
    !Array.isArray(value.messages) ||
    !(value.next === null || typeof value.next === 'string')
  ) {
    return undefined;
  }
  const messages: HistoryPage['messages'] = [];
  for (const message of value.messages) {
    const parsed = parseHistoryMessage(message);
    if (parsed === undefined) {
      return undefined;
    }
    messages.push(parsed);
  }
  return { messages, next: value.next };
}

function parseInboxMessage(
  value: unknown,
): InboxPage['messages'][number] | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.from !== 'string' ||
    typeof value.to !== 'string' ||
    typeof value.body !== 'string' ||
    typeof value.createdAt !== 'string' ||
    !(value.readAt === null || typeof value.readAt === 'string')
  ) {
    return undefined;
  }
  return {
    id: value.id,
    from: value.from,
    to: value.to,
    body: value.body,
    createdAt: value.createdAt,
    readAt: value.readAt,
  };
}

function parseInbox(value: unknown): InboxPage | undefined {
  if (
    !isRecord(value) ||
    !Array.isArray(value.messages) ||
    !(value.next === null || typeof value.next === 'string')
  ) {
    return undefined;
  }
  const messages: InboxPage['messages'] = [];
  for (const message of value.messages) {
    const parsed = parseInboxMessage(message);
    if (parsed === undefined) {
      return undefined;
    }
    messages.push(parsed);
  }
  return { messages, next: value.next };
}

function parseRegistered(value: unknown): RegisteredAgent | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.token !== 'string'
  ) {
    return undefined;
  }
  return { id: value.id, name: value.name, token: value.token };
}

function parseRevoked(value: unknown): RevokedAgent | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    value.tokenRevoked !== true ||
    'token' in value
  ) {
    return undefined;
  }
  return { id: value.id, name: value.name, tokenRevoked: true };
}

async function loadHistory(
  config: DeskConfig,
  after: string | undefined,
): Promise<DeskResult<{ page: HistoryPage; reset: boolean }>> {
  const query: Record<string, string> = {};
  if (after !== undefined) {
    query.after = after;
  }
  const first = await request(config, '/dashboard/messages', {
    method: 'GET',
    query,
  });
  if (!first.ok && first.failure === 'invalid' && after !== undefined) {
    const second = await request(config, '/dashboard/messages', {
      method: 'GET',
    });
    if (!second.ok) {
      return second;
    }
    const page = parseHistory(second.value);
    if (page === undefined) {
      return { ok: false, failure: 'failed' };
    }
    return { ok: true, value: { page, reset: true } };
  }
  if (!first.ok) {
    return first;
  }
  const page = parseHistory(first.value);
  if (page === undefined) {
    return { ok: false, failure: 'failed' };
  }
  return { ok: true, value: { page, reset: false } };
}

async function loadInbox(
  config: DeskConfig,
  agentId: string,
  after: string | undefined,
): Promise<DeskResult<{ page: InboxPage; reset: boolean }>> {
  const query: Record<string, string> = {};
  if (after !== undefined) {
    query.after = after;
  }
  const path = `/dashboard/agents/${agentId}/inbox`;
  const first = await request(config, path, { method: 'GET', query });
  if (!first.ok && first.failure === 'invalid' && after !== undefined) {
    const second = await request(config, path, { method: 'GET' });
    if (!second.ok) {
      return second;
    }
    const page = parseInbox(second.value);
    if (page === undefined) {
      return { ok: false, failure: 'failed' };
    }
    return { ok: true, value: { page, reset: true } };
  }
  if (!first.ok) {
    return first;
  }
  const page = parseInbox(first.value);
  if (page === undefined) {
    return { ok: false, failure: 'failed' };
  }
  return { ok: true, value: { page, reset: false } };
}

export async function loadLedger(
  config: DeskConfig,
  selection: LedgerSelection,
): Promise<DeskResult<LedgerSnapshot>> {
  const listed = await request(config, '/dashboard/agents', { method: 'GET' });
  if (!listed.ok) {
    return listed;
  }
  const agents = parseAgents(listed.value);
  if (agents === undefined) {
    return { ok: false, failure: 'failed' };
  }
  const history = await loadHistory(config, selection.historyAfter);
  if (!history.ok) {
    return history;
  }
  let inbox: InboxPage | null = null;
  let inboxMissing = false;
  let inboxReset = false;
  if (selection.inboxId !== undefined) {
    const loaded = await loadInbox(
      config,
      selection.inboxId,
      selection.inboxAfter,
    );
    if (!loaded.ok) {
      if (loaded.failure === 'not_found') {
        inboxMissing = true;
      } else {
        return loaded;
      }
    } else {
      inbox = loaded.value.page;
      inboxReset = loaded.value.reset;
    }
  }
  return {
    ok: true,
    value: {
      agents,
      history: history.value.page,
      inbox,
      inboxMissing,
      historyReset: history.value.reset,
      inboxReset,
    },
  };
}

export async function registerAgent(
  config: DeskConfig,
  name: string,
): Promise<DeskResult<RegisteredAgent>> {
  const result = await request(config, '/dashboard/agents', {
    method: 'POST',
    body: { name },
  });
  if (!result.ok) {
    return result;
  }
  const agent = parseRegistered(result.value);
  if (agent === undefined) {
    return { ok: false, failure: 'unknown' };
  }
  return { ok: true, value: agent };
}

export async function issueAgentToken(
  config: DeskConfig,
  id: string,
): Promise<DeskResult<RegisteredAgent>> {
  const result = await request(config, `/dashboard/agents/${id}/token`, {
    method: 'POST',
  });
  if (!result.ok) {
    return result;
  }
  const agent = parseRegistered(result.value);
  if (agent === undefined) {
    return { ok: false, failure: 'unknown' };
  }
  return { ok: true, value: agent };
}

export async function revokeAgentToken(
  config: DeskConfig,
  id: string,
): Promise<DeskResult<RevokedAgent>> {
  const result = await request(config, `/dashboard/agents/${id}/token/revoke`, {
    method: 'POST',
  });
  if (!result.ok) {
    return result;
  }
  const agent = parseRevoked(result.value);
  if (agent === undefined) {
    return { ok: false, failure: 'unknown' };
  }
  return { ok: true, value: agent };
}

function isFailure(value: unknown): value is DeskFailure {
  return (
    value === 'unconfigured' ||
    value === 'unreachable' ||
    value === 'database_unavailable' ||
    value === 'unauthorized' ||
    value === 'invalid' ||
    value === 'conflict' ||
    value === 'not_found' ||
    value === 'failed' ||
    value === 'unknown' ||
    value === 'handover' ||
    value === 'limited'
  );
}

function sessionPath(id: string): string | undefined {
  if (!SESSION_ID.test(id)) {
    return undefined;
  }
  return `/dashboard/sessions/${id}`;
}

function parseOpened(
  value: unknown,
): { id: string; csrfToken: string } | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.csrfToken !== 'string' ||
    !SESSION_ID.test(value.id) ||
    !SESSION_ID.test(value.csrfToken)
  ) {
    return undefined;
  }
  return { id: value.id, csrfToken: value.csrfToken };
}

function parseCsrf(value: unknown): { csrfToken: string } | undefined {
  if (
    !isRecord(value) ||
    typeof value.csrfToken !== 'string' ||
    !SESSION_ID.test(value.csrfToken)
  ) {
    return undefined;
  }
  return { csrfToken: value.csrfToken };
}

function parseNoticeId(value: unknown): { id: string } | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !SESSION_ID.test(value.id)
  ) {
    return undefined;
  }
  return { id: value.id };
}

function parseFlash(value: unknown): Flash | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.type === 'issued' || 'token' in value) {
    return { type: 'failure', failure: 'handover' };
  }
  if (value.type === 'revoked' && typeof value.name === 'string') {
    return { type: 'revoked', name: value.name };
  }
  if (value.type === 'failure' && isFailure(value.failure)) {
    return { type: 'failure', failure: value.failure };
  }
  return undefined;
}

export async function openDeskSession(
  config: DeskConfig,
): Promise<DeskResult<{ id: string; csrfToken: string }>> {
  const result = await request(config, '/dashboard/sessions', {
    method: 'POST',
  });
  if (!result.ok) {
    return result;
  }
  const opened = parseOpened(result.value);
  if (opened === undefined) {
    return { ok: false, failure: 'unknown' };
  }
  return { ok: true, value: opened };
}

export async function closeDeskSession(
  config: DeskConfig,
  id: string,
): Promise<DeskResult<true>> {
  const path = sessionPath(id);
  if (path === undefined) {
    return { ok: false, failure: 'invalid' };
  }
  const result = await request(config, path, {
    method: 'DELETE',
    allowEmpty: true,
  });
  if (!result.ok) {
    return result;
  }
  return { ok: true, value: true };
}

export async function readDeskSession(
  config: DeskConfig,
  id: string,
): Promise<DeskResult<{ csrfToken: string }>> {
  const path = sessionPath(id);
  if (path === undefined) {
    return { ok: false, failure: 'invalid' };
  }
  const result = await request(config, path, { method: 'GET' });
  if (!result.ok) {
    return result;
  }
  const session = parseCsrf(result.value);
  if (session === undefined) {
    return { ok: false, failure: 'failed' };
  }
  return { ok: true, value: session };
}

export async function saveDeskNotice(
  config: DeskConfig,
  id: string,
  flash: Flash,
): Promise<DeskResult<{ id: string }>> {
  const path = sessionPath(id);
  if (path === undefined) {
    return { ok: false, failure: 'invalid' };
  }
  const result = await request(config, `${path}/notices`, {
    method: 'POST',
    body: flash,
  });
  if (!result.ok) {
    return result;
  }
  const notice = parseNoticeId(result.value);
  if (notice === undefined) {
    return { ok: false, failure: 'unknown' };
  }
  return { ok: true, value: notice };
}

export async function takeDeskNotice(
  config: DeskConfig,
  id: string,
  noticeId: string,
): Promise<DeskResult<Flash>> {
  const path = sessionPath(id);
  if (path === undefined || sessionPath(noticeId) === undefined) {
    return { ok: false, failure: 'invalid' };
  }
  const result = await request(config, `${path}/notices/${noticeId}/take`, {
    method: 'POST',
  });
  if (!result.ok) {
    return result;
  }
  const flash = parseFlash(result.value);
  if (flash === undefined) {
    return { ok: false, failure: 'unknown' };
  }
  return { ok: true, value: flash };
}

const AGENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function confirmTokenHandover(
  config: DeskConfig,
  id: string,
): Promise<DeskResult<true>> {
  if (!AGENT_ID.test(id)) {
    return { ok: false, failure: 'invalid' };
  }
  const result = await request(
    config,
    `/dashboard/agents/${id}/token/confirm`,
    {
      method: 'POST',
    },
  );
  if (!result.ok) {
    return result;
  }
  if (
    !isRecord(result.value) ||
    typeof result.value.id !== 'string' ||
    typeof result.value.name !== 'string' ||
    'token' in result.value
  ) {
    return { ok: false, failure: 'unknown' };
  }
  return { ok: true, value: true };
}

export async function discardPendingToken(
  config: DeskConfig,
  id: string,
): Promise<DeskResult<true>> {
  if (!AGENT_ID.test(id)) {
    return { ok: false, failure: 'invalid' };
  }
  const result = await request(
    config,
    `/dashboard/agents/${id}/token/discard`,
    {
      method: 'POST',
      allowEmpty: true,
    },
  );
  if (!result.ok) {
    return result;
  }
  return { ok: true, value: true };
}
