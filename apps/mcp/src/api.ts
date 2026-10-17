import type {
  AgentSummary,
  InboxMessage,
  InboxPage,
  MarkedRead,
  ReadReceipt,
  SentMessage,
} from '@switchboard/shared';

// POST /inbox/read accepts at most 100 ids, so a page is one batch, retried once.
const MAX_READ = 100;
const MARK_READ_ATTEMPTS = 2;
const MARK_READ_WARNING =
  'Mark-read could not be confirmed. These messages may show again.';
const TIMEOUT_MS = 10_000;
const SAFE_ERRORS = new Set([
  'unauthorized',
  'invalid request',
  'database_unavailable',
  'recipient not found',
  'not found',
  'name already registered',
  'internal error',
]);

export class SwitchboardError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, detail?: string) {
    super(detail ?? code);
    this.name = 'SwitchboardError';
    this.status = status;
    this.code = code;
  }
}

export function mapApiError(status: number, body: unknown): SwitchboardError {
  const reported = errorMessage(body);
  if (reported !== undefined && SAFE_ERRORS.has(reported)) {
    return new SwitchboardError(status, reported);
  }
  if (status === 401) {
    return new SwitchboardError(status, 'unauthorized');
  }
  if (status === 400 || status === 413) {
    return new SwitchboardError(status, 'invalid request');
  }
  if (status === 404) {
    return new SwitchboardError(status, 'not found');
  }
  if (status === 503) {
    return new SwitchboardError(status, 'database_unavailable');
  }
  return new SwitchboardError(status, 'request_failed');
}

export type SwitchboardClientOptions = {
  url: string;
  token: string;
  fetch?: typeof fetch;
};

type InboxQuery = {
  unread: boolean;
  limit?: number;
  after?: string;
};

type SearchQuery = {
  status: 'unread' | 'read' | 'all';
  box: 'received' | 'sent';
  from?: string;
  since?: string;
  until?: string;
  text?: string;
  limit?: number;
  cursor?: string;
};

export type CheckedInbox = {
  messages: InboxMessage[];
  next: string | null;
  read: string[];
  warning?: string;
};

export class SwitchboardClient {
  private readonly url: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SwitchboardClientOptions) {
    this.url = options.url;
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
  }

  listAgents(): Promise<{ agents: AgentSummary[] }> {
    return this.request('/agents', { method: 'GET' }).then((body) =>
      parseAgents(body),
    );
  }

  sendMessage(input: { to: string; body: string }): Promise<SentMessage> {
    return this.request('/messages', {
      method: 'POST',
      body: { to: input.to, body: input.body },
    }).then((body) => parseSent(body));
  }

  async checkInbox(input: InboxQuery): Promise<CheckedInbox> {
    const query: Record<string, string> = {
      unread: String(input.unread),
    };
    if (input.limit !== undefined) {
      query.limit = String(input.limit);
    }
    if (input.after !== undefined) {
      query.after = input.after;
    }
    const fetched = await this.request('/inbox', { method: 'GET', query });
    const page = parseInbox(fetched);
    const ids = page.messages.map((message) => message.id);
    if (ids.length === 0) {
      return { messages: [], next: page.next, read: [] };
    }
    if (ids.length > MAX_READ) {
      throw new SwitchboardError(400, 'invalid request');
    }
    const receipt = await this.markRead(ids);
    if (receipt === undefined) {
      return {
        messages: page.messages,
        next: page.next,
        read: [],
        warning: MARK_READ_WARNING,
      };
    }
    return withReadTimes(page, receipt);
  }

  searchMessages(input: SearchQuery): Promise<InboxPage> {
    const query: Record<string, string> = {
      status: input.status,
      box: input.box,
    };
    if (input.from !== undefined) {
      query.from = input.from;
    }
    if (input.since !== undefined) {
      query.since = input.since;
    }
    if (input.until !== undefined) {
      query.until = input.until;
    }
    if (input.text !== undefined) {
      query.text = input.text;
    }
    if (input.limit !== undefined) {
      query.limit = String(input.limit);
    }
    if (input.cursor !== undefined) {
      query.cursor = input.cursor;
    }
    return this.request('/messages/search', { method: 'GET', query }).then(
      (body) => parseInbox(body),
    );
  }

  private async markRead(ids: string[]): Promise<ReadReceipt | undefined> {
    let unconfirmed = false;
    for (let attempt = 0; attempt < MARK_READ_ATTEMPTS; attempt += 1) {
      try {
        return parseRead(
          await this.request('/inbox/read', {
            method: 'POST',
            body: { ids },
          }),
        );
      } catch (error) {
        if (!isUnconfirmedMarkRead(error)) {
          if (unconfirmed) {
            return undefined;
          }
          throw error;
        }
        unconfirmed = true;
      }
    }
    return undefined;
  }

  private async request(
    path: string,
    options: {
      method: 'GET' | 'POST';
      query?: Record<string, string>;
      body?: unknown;
    },
  ): Promise<unknown> {
    const url = joinUrl(this.url, path);
    if (options.query !== undefined) {
      for (const [key, value] of Object.entries(options.query)) {
        url.searchParams.set(key, value);
      }
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: options.method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(options.body !== undefined
            ? { 'content-type': 'application/json' }
            : {}),
        },
        ...(options.body !== undefined
          ? { body: JSON.stringify(options.body) }
          : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw this.unreachable();
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw this.unreachable();
    }
    let parsed: unknown;
    if (text !== '') {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = undefined;
      }
    }
    if (!response.ok) {
      throw mapApiError(response.status, parsed);
    }
    return parsed;
  }

  private unreachable(): SwitchboardError {
    return new SwitchboardError(
      0,
      'api_unreachable',
      `The Switchboard API at ${this.url} is not reachable. Do not retry in a loop.`,
    );
  }
}

function isUnconfirmedMarkRead(error: unknown): boolean {
  // status 200 is a receipt that could not be read; the update may have committed.
  return (
    error instanceof SwitchboardError &&
    (error.code === 'api_unreachable' ||
      error.status === 200 ||
      error.status === 502 ||
      error.status === 504)
  );
}

function withReadTimes(page: InboxPage, receipt: ReadReceipt): CheckedInbox {
  const readIds = new Set(receipt.read.map((id) => id.toLowerCase()));
  const readAtById = new Map(
    receipt.marked.map((item) => [item.id.toLowerCase(), item.readAt]),
  );
  return {
    messages: page.messages.map((message) => {
      if (message.readAt !== null || !readIds.has(message.id.toLowerCase())) {
        return message;
      }
      const readAt = readAtById.get(message.id.toLowerCase());
      if (readAt === undefined) {
        return message;
      }
      return { ...message, readAt };
    }),
    next: page.next,
    read: receipt.read,
  };
}

function joinUrl(base: string, path: string): URL {
  const url = new URL(base);
  const prefix = url.pathname.replace(/\/$/, '');
  url.pathname = `${prefix}${path}`;
  url.search = '';
  url.hash = '';
  return url;
}

function errorMessage(body: unknown): string | undefined {
  if (!isRecord(body) || typeof body.error !== 'string') {
    return undefined;
  }
  return body.error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function parseAgents(value: unknown): { agents: AgentSummary[] } {
  if (!isRecord(value) || !Array.isArray(value.agents)) {
    throw new SwitchboardError(200, 'request_failed');
  }
  return { agents: value.agents.map(parseAgent) };
}

function parseAgent(value: unknown): AgentSummary {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.online !== 'boolean' ||
    !(value.lastSeenAt === null || typeof value.lastSeenAt === 'string')
  ) {
    throw new SwitchboardError(200, 'request_failed');
  }
  return {
    id: value.id,
    name: value.name,
    online: value.online,
    lastSeenAt: value.lastSeenAt,
  };
}

function parseSent(value: unknown): SentMessage {
  if (!isRecord(value) || typeof value.id !== 'string') {
    throw new SwitchboardError(200, 'request_failed');
  }
  return { id: value.id };
}

function parseInbox(value: unknown): InboxPage {
  if (
    !isRecord(value) ||
    !Array.isArray(value.messages) ||
    !(value.next === null || typeof value.next === 'string')
  ) {
    throw new SwitchboardError(200, 'request_failed');
  }
  return {
    messages: value.messages.map(parseMessage),
    next: value.next,
  };
}

function parseMessage(value: unknown): InboxMessage {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.from !== 'string' ||
    typeof value.to !== 'string' ||
    typeof value.body !== 'string' ||
    typeof value.createdAt !== 'string' ||
    !(value.readAt === null || typeof value.readAt === 'string')
  ) {
    throw new SwitchboardError(200, 'request_failed');
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

function parseMarked(value: unknown): MarkedRead {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !(value.readAt === null || typeof value.readAt === 'string')
  ) {
    throw new SwitchboardError(200, 'request_failed');
  }
  return { id: value.id, readAt: value.readAt };
}

function parseRead(value: unknown): ReadReceipt {
  if (!isRecord(value) || !isStringArray(value.read)) {
    throw new SwitchboardError(200, 'request_failed');
  }
  if (value.marked === undefined) {
    return {
      read: value.read,
      marked: value.read.map((id) => ({ id, readAt: null })),
    };
  }
  if (!Array.isArray(value.marked)) {
    throw new SwitchboardError(200, 'request_failed');
  }
  const marked = value.marked.map(parseMarked);
  const times = new Set(marked.map((item) => item.id.toLowerCase()));
  if (value.read.some((id) => !times.has(id.toLowerCase()))) {
    throw new SwitchboardError(200, 'request_failed');
  }
  return { read: value.read, marked };
}
