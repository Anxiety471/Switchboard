import type {
  AgentSummary,
  InboxMessage,
  InboxPage,
  ReadReceipt,
  SentMessage,
} from '@switchboard/shared';

// POST /inbox/read accepts at most 100 ids, so a page is one call or none.
const MAX_READ = 100;
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
    return this.request('/agents', { method: 'GET' }).then((result) =>
      parseAgents(result.body),
    );
  }

  sendMessage(input: { to: string; body: string }): Promise<SentMessage> {
    return this.request('/messages', {
      method: 'POST',
      body: { to: input.to, body: input.body },
    }).then((result) => parseSent(result.body));
  }

  async checkInbox(input: InboxQuery): Promise<InboxPage & { read: string[] }> {
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
    const page = parseInbox(fetched.body);
    const ids = page.messages.map((message) => message.id);
    if (ids.length === 0) {
      return { messages: [], next: page.next, read: [] };
    }
    if (ids.length > MAX_READ) {
      throw new SwitchboardError(400, 'invalid request');
    }
    const marked = await this.request('/inbox/read', {
      method: 'POST',
      body: { ids },
    });
    const receipt = parseRead(marked.body);
    const readIds = new Set(receipt.read.map((id) => id.toLowerCase()));
    return {
      messages: page.messages.map((message) => {
        if (message.readAt !== null || !readIds.has(message.id.toLowerCase())) {
          return message;
        }
        return { ...message, readAt: marked.readAt };
      }),
      next: page.next,
      read: receipt.read,
    };
  }

  private async request(
    path: string,
    options: {
      method: 'GET' | 'POST';
      query?: Record<string, string>;
      body?: unknown;
    },
  ): Promise<{ body: unknown; readAt: string }> {
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
      throw new SwitchboardError(
        0,
        'api_unreachable',
        `The Switchboard API at ${this.url} is not reachable. Do not retry in a loop.`,
      );
    }
    const text = await response.text();
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
    return { body: parsed, readAt: readAtFrom(response.headers.get('date')) };
  }
}

function readAtFrom(header: string | null): string {
  if (header !== null) {
    const parsed = new Date(header);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return new Date().toISOString();
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

function parseRead(value: unknown): ReadReceipt {
  if (!isRecord(value) || !isStringArray(value.read)) {
    throw new SwitchboardError(200, 'request_failed');
  }
  return { read: value.read };
}
