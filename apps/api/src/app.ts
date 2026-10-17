import type { IncomingHttpHeaders } from 'node:http';
import Fastify, { type FastifyError } from 'fastify';
import { Pool } from 'pg';
import type {
  AgentSummary,
  InboxMessage,
  InboxPage,
  ReadReceipt,
  RegisteredAgent,
  SentMessage,
} from '@switchboard/shared';
import { migrate } from './migrate.js';
import { generateToken, hashToken, secretsEqual } from './token.js';

const BODY_LIMIT = 32 * 1024;
const MAX_BODY_BYTES = 8192;
const MAX_READ_IDS = 100;
const DEFAULT_INBOX_LIMIT = 50;
const MAX_INBOX_LIMIT = 200;
const ONLINE_INTERVAL = '60 seconds';
const MIGRATION_RETRY_MIN_MS = 200;
const MIGRATION_RETRY_MAX_MS = 5000;
const DATABASE_TIMEOUT_MS = 2000;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const CURSOR_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\|([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.Authorization',
  'req.headers["x-registration-secret"]',
  'headers.authorization',
  'headers["x-registration-secret"]',
];

const CONNECTION_ERRORS = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '57P01',
  '57P02',
  '57P03',
]);
const UNAVAILABLE_MESSAGES = [
  'timeout exceeded when trying to connect',
  'timeout expired',
  'connection terminated',
  'query read timeout',
  'server closed the connection unexpectedly',
  'the database system is shutting down',
  'the database system is starting up',
];

declare module 'fastify' {
  interface FastifyRequest {
    agent: { id: string; name: string } | null;
  }

  interface FastifyInstance {
    migrationsReady: Promise<void>;
  }
}

export type BuildAppOptions = {
  logger?: boolean;
  max?: number;
  migrate?: boolean;
  logStream?: { write: (message: string) => void };
  registrationSecret?: string;
};

type AuthenticatedAgent = {
  id: string;
  name: string;
};

type RegisterBody = {
  name: string;
};

type MessageBody = {
  to: string;
  body: string;
};

type ReadBody = {
  ids: string[];
};

type InboxQuery = {
  unread?: string;
  limit?: string;
  after?: string;
};

type InboxCursor = {
  createdAt: string;
  id: string;
};

function requestPath(url: string): string {
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}

function isPublicRoute(method: string, url: string): boolean {
  const path = requestPath(url);
  if (path === '/health') {
    return true;
  }
  return method === 'POST' && path === '/agents';
}

function headersForLog(headers: IncomingHttpHeaders): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    const name = key.toLowerCase();
    copy[key] =
      name === 'authorization' || name === 'x-registration-secret'
        ? '[Redacted]'
        : value;
  }
  return copy;
}

function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  const match = /^Bearer ([A-Za-z0-9_-]{1,128})$/i.exec(header);
  return match?.[1];
}

function pgField(
  error: unknown,
  field: 'code' | 'constraint',
): string | undefined {
  if (typeof error !== 'object' || error === null || !(field in error)) {
    return undefined;
  }
  const value = (error as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

function statusCodeOf(error: unknown): number {
  if (typeof error === 'object' && error !== null && 'statusCode' in error) {
    const statusCode = error.statusCode;
    if (typeof statusCode === 'number') {
      return statusCode;
    }
  }
  return 500;
}

function isValidationError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'validation' in error &&
    error.validation !== undefined
  );
}

function requiredRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) {
    throw new Error('expected a row');
  }
  return row;
}

function isoTime(value: Date | string | null): string | null {
  if (value === null) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return new Date(value).toISOString();
}

function caller(request: {
  agent: AuthenticatedAgent | null;
}): AuthenticatedAgent {
  if (request.agent === null) {
    throw new Error('missing authenticated agent');
  }
  return request.agent;
}

function inboxLimit(value: string | undefined): number | undefined {
  if (value === undefined) {
    return DEFAULT_INBOX_LIMIT;
  }
  if (!/^[1-9]\d{0,2}$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  if (parsed > MAX_INBOX_LIMIT) {
    return undefined;
  }
  return parsed;
}

function isCursorTime(value: string): boolean {
  const year = Number(value.slice(0, 4));
  if (!Number.isInteger(year) || year < 1 || year > 9999) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function parseCursor(
  value: string | undefined,
): InboxCursor | null | undefined {
  if (value === undefined) {
    return null;
  }
  const match = CURSOR_PATTERN.exec(value);
  const createdAt = match?.[1];
  const id = match?.[2];
  if (createdAt === undefined || id === undefined || !isCursorTime(createdAt)) {
    return undefined;
  }
  return { createdAt, id };
}

function isDatabaseUnavailable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  if ('code' in error) {
    const code = error.code;
    if (typeof code === 'string' && CONNECTION_ERRORS.has(code)) {
      return true;
    }
  }
  if ('message' in error && typeof error.message === 'string') {
    const message = error.message.toLowerCase();
    if (UNAVAILABLE_MESSAGES.some((part) => message.includes(part))) {
      return true;
    }
  }
  if ('errors' in error && Array.isArray(error.errors)) {
    return error.errors.some((item) => isDatabaseUnavailable(item));
  }
  if ('cause' in error && error.cause !== undefined && error.cause !== error) {
    return isDatabaseUnavailable(error.cause);
  }
  return false;
}

function databaseUnavailableBody(): { error: 'database_unavailable' } {
  return { error: 'database_unavailable' };
}

function registrationHeader(headers: IncomingHttpHeaders): string {
  const header = headers['x-registration-secret'];
  return typeof header === 'string' ? header : '';
}

export function buildApp(databaseUrl: string, options?: BuildAppOptions) {
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: DATABASE_TIMEOUT_MS,
    query_timeout: DATABASE_TIMEOUT_MS,
    statement_timeout: DATABASE_TIMEOUT_MS,
    max: options?.max ?? 10,
  });
  const logging = options?.logger === true || options?.logStream !== undefined;
  const registrationSecret = options?.registrationSecret;
  let migrated = options?.migrate === false;
  let migrationStopped = false;
  let wake: (() => void) | undefined;
  let resolveReady: () => void = () => {};
  const migrationsReady = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const app = Fastify({
    bodyLimit: BODY_LIMIT,
    ajv: {
      customOptions: {
        coerceTypes: false,
        removeAdditional: false,
      },
    },
    logger: logging
      ? {
          level: 'info',
          redact: REDACT_PATHS,
          serializers: {
            req(request) {
              const remotePort = request.socket?.remotePort;
              return {
                method: request.method,
                url: request.url,
                host: request.host,
                remoteAddress: request.ip,
                ...(typeof remotePort === 'number' ? { remotePort } : {}),
                headers: headersForLog(request.headers),
              };
            },
            err(error: FastifyError) {
              return {
                type: error.name,
                message: error.message.replace(
                  /Bearer\s+\S+/gi,
                  'Bearer [Redacted]',
                ),
                stack: error.stack ?? '',
              };
            },
          },
          ...(options?.logStream ? { stream: options.logStream } : {}),
        }
      : false,
  });

  app.decorate('migrationsReady', migrationsReady);
  app.decorateRequest('agent', null);

  pool.on('error', (error) => {
    app.log.error({ err: error }, 'idle database client error');
  });

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        wake = undefined;
        resolve();
      }, ms);
      timer.unref();
      wake = () => {
        clearTimeout(timer);
        wake = undefined;
        resolve();
      };
    });
  }

  async function runMigrations(): Promise<void> {
    if (options?.migrate === false) {
      resolveReady();
      return;
    }
    let delay = MIGRATION_RETRY_MIN_MS;
    while (!migrationStopped) {
      try {
        await migrate(pool);
        if (migrationStopped) {
          return;
        }
        migrated = true;
        resolveReady();
        return;
      } catch (error) {
        app.log.error({ err: error }, 'migration failed; retrying');
      }
      if (migrationStopped) {
        return;
      }
      await sleep(delay);
      delay = Math.min(delay * 2, MIGRATION_RETRY_MAX_MS);
    }
  }

  app.setSchemaErrorFormatter(() => new Error('invalid request'));

  app.setErrorHandler((error, _request, reply) => {
    if (isDatabaseUnavailable(error)) {
      app.log.error({ err: error }, 'database unavailable');
      return reply.code(503).send(databaseUnavailableBody());
    }
    const statusCode = statusCodeOf(error);
    if (isValidationError(error) || statusCode === 400 || statusCode === 413) {
      const code = statusCode === 413 ? 413 : 400;
      return reply.code(code).send({ error: 'invalid request' });
    }
    if (statusCode === 401) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if (statusCode === 404) {
      return reply.code(404).send({ error: 'not found' });
    }
    if (statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({ error: 'invalid request' });
    }
    if (error instanceof Error) {
      app.log.error({ err: error }, 'request failed');
    } else {
      app.log.error('request failed');
    }
    return reply.code(500).send({ error: 'internal error' });
  });

  app.setNotFoundHandler((_request, reply) => {
    return reply.code(404).send({ error: 'not found' });
  });

  app.addHook('onRequest', async (request, reply) => {
    if (isPublicRoute(request.method, request.url)) {
      return;
    }
    const token = bearerToken(request.headers.authorization);
    if (token === undefined) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    let result;
    try {
      result = await pool.query<{ id: string; name: string }>(
        `WITH touched AS (
         UPDATE agents
         SET last_seen_at = clock_timestamp()
         WHERE token_hash = $1
           AND (
             last_seen_at IS NULL
             OR last_seen_at < clock_timestamp() - interval '10 seconds'
           )
       )
       SELECT id, name
       FROM agents
       WHERE token_hash = $1`,
        [hashToken(token)],
      );
    } catch (error) {
      if (isDatabaseUnavailable(error)) {
        app.log.error({ err: error }, 'database auth check failed');
        return reply.code(503).send(databaseUnavailableBody());
      }
      throw error;
    }
    const row = result.rows[0];
    if (row === undefined) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    request.agent = { id: row.id, name: row.name };
  });

  app.get('/health', async (_request, reply) => {
    if (!migrated) {
      return reply.code(503).send({ ok: false });
    }
    try {
      await pool.query('SELECT 1 AS ok');
      return { ok: true };
    } catch (error) {
      app.log.error({ err: error }, 'database health check failed');
      return reply.code(503).send({ ok: false });
    }
  });

  app.post<{ Body: RegisterBody }>(
    '/agents',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: {
            name: {
              type: 'string',
              minLength: 1,
              maxLength: 64,
              pattern: '^[A-Za-z0-9][A-Za-z0-9_-]*$',
            },
          },
        },
        response: {
          201: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'name', 'token'],
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              token: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (
        registrationSecret !== undefined &&
        registrationSecret !== '' &&
        !secretsEqual(registrationSecret, registrationHeader(request.headers))
      ) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      const token = generateToken();
      try {
        const result = await pool.query<{ id: string; name: string }>(
          `INSERT INTO agents (name, token_hash)
           VALUES ($1, $2)
           RETURNING id, name`,
          [request.body.name, hashToken(token)],
        );
        const row = requiredRow(result.rows);
        const body: RegisteredAgent = {
          id: row.id,
          name: row.name,
          token,
        };
        return reply.code(201).send(body);
      } catch (error) {
        if (
          pgField(error, 'code') === '23505' &&
          pgField(error, 'constraint') === 'agents_name_lower_idx'
        ) {
          return reply.code(409).send({ error: 'name already registered' });
        }
        if (isDatabaseUnavailable(error)) {
          app.log.error({ err: error }, 'database unavailable');
          return reply.code(503).send(databaseUnavailableBody());
        }
        throw error;
      }
    },
  );

  app.get(
    '/agents',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['agents'],
            properties: {
              agents: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['id', 'name', 'online', 'lastSeenAt'],
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    online: { type: 'boolean' },
                    lastSeenAt: { type: ['string', 'null'] },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request) => {
      caller(request);
      const result = await pool.query<{
        id: string;
        name: string;
        online: boolean;
        last_seen_at: Date | string | null;
      }>(
        `SELECT id,
                name,
                last_seen_at,
                (
                  last_seen_at IS NOT NULL
                  AND last_seen_at >= clock_timestamp() - $1::interval
                ) AS online
         FROM agents
         ORDER BY name ASC`,
        [ONLINE_INTERVAL],
      );
      const agents: AgentSummary[] = result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        online: row.online,
        lastSeenAt: isoTime(row.last_seen_at),
      }));
      return { agents };
    },
  );

  app.post<{ Body: MessageBody }>(
    '/messages',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['to', 'body'],
          properties: {
            to: { type: 'string', minLength: 1, maxLength: 64 },
            body: { type: 'string', minLength: 1, maxLength: MAX_BODY_BYTES },
          },
        },
        response: {
          201: {
            type: 'object',
            additionalProperties: false,
            required: ['id'],
            properties: {
              id: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const sender = caller(request);
      const { to, body } = request.body;
      if (
        body.includes('\0') ||
        Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES
      ) {
        return reply.code(400).send({ error: 'invalid request' });
      }
      const recipientId = await resolveRecipient(pool, reply, sender, to);
      if (recipientId === undefined) {
        return reply;
      }
      try {
        const result = await pool.query<{ id: string }>(
          `WITH inserted AS (
             INSERT INTO messages (from_agent, to_agent, body)
             VALUES ($1::uuid, $2::uuid, $3)
             RETURNING id, from_agent
           ),
           receipts AS (
             INSERT INTO message_receipts (message_id, agent_id)
             SELECT inserted.id, agents.id
             FROM inserted
             JOIN agents ON (
               ($2::uuid IS NOT NULL AND agents.id = $2::uuid)
               OR ($2::uuid IS NULL AND agents.id <> inserted.from_agent)
             )
             RETURNING message_id
           )
           SELECT id FROM inserted`,
          [sender.id, recipientId, body],
        );
        const row = requiredRow(result.rows);
        const payload: SentMessage = { id: row.id };
        return reply.code(201).send(payload);
      } catch (error) {
        if (pgField(error, 'code') === '23503') {
          return reply.code(404).send({ error: 'recipient not found' });
        }
        if (pgField(error, 'code') === '23514') {
          return reply.code(400).send({ error: 'invalid request' });
        }
        throw error;
      }
    },
  );

  app.get<{ Querystring: InboxQuery }>(
    '/inbox',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            unread: { type: 'string', enum: ['true', 'false'] },
            limit: { type: 'string', pattern: '^[1-9][0-9]{0,2}$' },
            after: { type: 'string', minLength: 1, maxLength: 80 },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['messages', 'next'],
            properties: {
              messages: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['id', 'from', 'to', 'body', 'createdAt', 'readAt'],
                  properties: {
                    id: { type: 'string' },
                    from: { type: 'string' },
                    to: { type: 'string' },
                    body: { type: 'string' },
                    createdAt: { type: 'string' },
                    readAt: { type: ['string', 'null'] },
                  },
                },
              },
              next: { type: ['string', 'null'] },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const agent = caller(request);
      const limit = inboxLimit(request.query.limit);
      const cursor = parseCursor(request.query.after);
      if (limit === undefined || cursor === undefined) {
        return reply.code(400).send({ error: 'invalid request' });
      }
      const unreadOnly = request.query.unread === 'true';
      const result = await pool.query<{
        id: string;
        from_name: string;
        to_name: string;
        body: string;
        created_at: Date | string;
        read_at: Date | string | null;
      }>(
        `SELECT m.id,
                sender.name AS from_name,
                CASE
                  WHEN m.to_agent IS NULL THEN '*'
                  ELSE recipient.name
                END AS to_name,
                m.body,
                date_trunc('milliseconds', m.created_at) AS created_at,
                r.read_at
         FROM message_receipts r
         JOIN messages m ON m.id = r.message_id
         JOIN agents sender ON sender.id = m.from_agent
         JOIN agents recipient ON recipient.id = r.agent_id
         WHERE r.agent_id = $1::uuid
           AND ($2::boolean = false OR r.read_at IS NULL)
           AND (
             $3::timestamptz IS NULL
             OR (
               date_trunc('milliseconds', m.created_at),
               m.id
             ) > ($3::timestamptz, $4::uuid)
           )
         ORDER BY date_trunc('milliseconds', m.created_at) ASC, m.id ASC
         LIMIT $5`,
        [
          agent.id,
          unreadOnly,
          cursor?.createdAt ?? null,
          cursor?.id ?? null,
          limit + 1,
        ],
      );
      const hasMore = result.rows.length > limit;
      const pageRows = hasMore ? result.rows.slice(0, limit) : result.rows;
      const messages: InboxMessage[] = pageRows.map((row) => ({
        id: row.id,
        from: row.from_name,
        to: row.to_name,
        body: row.body,
        createdAt: isoTime(row.created_at) ?? '',
        readAt: isoTime(row.read_at),
      }));
      const last = messages[messages.length - 1];
      const page: InboxPage = {
        messages,
        next:
          hasMore && last !== undefined ? `${last.createdAt}|${last.id}` : null,
      };
      return page;
    },
  );

  app.post<{ Body: ReadBody }>(
    '/inbox/read',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['ids'],
          properties: {
            ids: {
              type: 'array',
              maxItems: MAX_READ_IDS,
              items: {
                type: 'string',
                minLength: 36,
                maxLength: 36,
                pattern: UUID_PATTERN,
              },
            },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['read'],
            properties: {
              read: {
                type: 'array',
                items: { type: 'string' },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const agent = caller(request);
      const result = await pool.query<{ message_id: string }>(
        `UPDATE message_receipts
         SET read_at = COALESCE(read_at, clock_timestamp())
         WHERE agent_id = $1::uuid
           AND message_id IN (
             SELECT value::uuid FROM unnest($2::text[]) AS value
           )
         RETURNING message_id`,
        [agent.id, request.body.ids],
      );
      const read = request.body.ids.flatMap((id) => {
        const canonical = result.rows.find(
          (row) => row.message_id.toLowerCase() === id.toLowerCase(),
        );
        return canonical ? [canonical.message_id] : [];
      });
      const body: ReadReceipt = { read };
      return body;
    },
  );

  const migrationTask = runMigrations();

  app.addHook('onClose', async () => {
    migrationStopped = true;
    wake?.();
    await migrationTask;
    await pool.end();
  });

  return app;
}

async function resolveRecipient(
  pool: Pool,
  reply: {
    code: (status: number) => { send: (body: { error: string }) => unknown };
  },
  sender: AuthenticatedAgent,
  to: string,
): Promise<string | null | undefined> {
  if (to === '*') {
    return null;
  }
  if (!NAME_PATTERN.test(to)) {
    await reply.code(400).send({ error: 'invalid request' });
    return undefined;
  }
  const result = await pool.query<{ id: string }>(
    'SELECT id FROM agents WHERE lower(name) = lower($1)',
    [to],
  );
  const row = result.rows[0];
  if (row === undefined) {
    await reply.code(404).send({ error: 'recipient not found' });
    return undefined;
  }
  if (row.id === sender.id) {
    await reply.code(400).send({ error: 'invalid request' });
    return undefined;
  }
  return row.id;
}

export function parseHost(value: string | undefined): string {
  if (value === undefined || value === '') {
    return '127.0.0.1';
  }
  return value;
}

export function parsePort(value: string | undefined): number {
  const raw = value ?? '3001';
  if (!/^[1-9]\d*$/.test(raw) || Number(raw) > 65535) {
    throw new Error(
      `Invalid PORT ${JSON.stringify(value)}: expected an integer from 1 to 65535`,
    );
  }
  return Number(raw);
}
