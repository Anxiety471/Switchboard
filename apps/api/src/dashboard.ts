import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type {
  DashboardAgent,
  HistoryMessage,
  HistoryPage,
  RegisteredAgent,
  RevokedAgent,
} from '@switchboard/shared';
import { readInbox } from './inbox-read.js';
import { inboxLimit, parseCursor, UUID_PATTERN } from './paging.js';
import { generateToken, hashToken, secretsEqual } from './token.js';
import { isoTime } from './time.js';

const NAME_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 64,
  pattern: '^[A-Za-z0-9][A-Za-z0-9_-]*$',
} as const;

const ID_SCHEMA = {
  type: 'string',
  minLength: 36,
  maxLength: 36,
  pattern: UUID_PATTERN,
} as const;

const PAGE_QUERY = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'string', pattern: '^[1-9][0-9]{0,2}$' },
    after: { type: 'string', minLength: 1, maxLength: 80 },
  },
} as const;

const INBOX_QUERY = {
  type: 'object',
  additionalProperties: false,
  properties: {
    unread: { type: 'string', enum: ['true', 'false'] },
    limit: { type: 'string', pattern: '^[1-9][0-9]{0,2}$' },
    after: { type: 'string', minLength: 1, maxLength: 80 },
  },
} as const;

const AGENT_PROPERTIES = {
  id: { type: 'string' },
  name: { type: 'string' },
  online: { type: 'boolean' },
  lastSeenAt: { type: ['string', 'null'] },
  createdAt: { type: 'string' },
  tokenRevoked: { type: 'boolean' },
} as const;

type RegisterBody = {
  name: string;
};

type PageQuery = {
  limit?: string;
  after?: string;
};

type InboxQuery = PageQuery & {
  unread?: string;
};

type AgentParams = {
  id: string;
};

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

function requiredRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) {
    throw new Error('expected a row');
  }
  return row;
}

const PENDING_TTL = '120 seconds';

async function storePendingToken(
  pool: Pool,
  agentId: string,
): Promise<{ id: string; name: string; token: string } | undefined> {
  const existing = await pool.query<{ id: string }>(
    'SELECT id FROM agents WHERE id = $1::uuid',
    [agentId],
  );
  if (existing.rows[0] === undefined) {
    return undefined;
  }
  await pool.query(
    `UPDATE agents
     SET pending_token_hash = NULL,
         pending_expires_at = NULL
     WHERE pending_expires_at <= clock_timestamp()`,
  );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = generateToken();
    const hash = hashToken(token);
    try {
      const result = await pool.query<{ id: string; name: string }>(
        `UPDATE agents
         SET pending_token_hash = $2,
             pending_expires_at = clock_timestamp() + $3::interval
         WHERE id = $1::uuid
           AND NOT EXISTS (
             SELECT 1
             FROM agents AS other
             WHERE other.token_hash = $2
                OR other.pending_token_hash = $2
           )
         RETURNING id, name`,
        [agentId, hash, PENDING_TTL],
      );
      const row = result.rows[0];
      if (row === undefined) {
        continue;
      }
      return { id: row.id, name: row.name, token };
    } catch (error) {
      if (pgField(error, 'code') === '23505' && attempt < 2) {
        continue;
      }
      throw error;
    }
  }
  throw new Error('token hash collision');
}

async function revokeStoredToken(
  pool: Pool,
  agentId: string,
): Promise<{ id: string; name: string } | undefined> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const hash = hashToken(generateToken());
    try {
      const result = await pool.query<{ id: string; name: string }>(
        `UPDATE agents
         SET token_hash = $2,
             token_revoked = true,
             pending_token_hash = NULL,
             pending_expires_at = NULL
         WHERE id = $1::uuid
         RETURNING id, name`,
        [agentId, hash],
      );
      const row = result.rows[0];
      if (row === undefined) {
        return undefined;
      }
      return row;
    } catch (error) {
      if (
        pgField(error, 'code') === '23505' &&
        pgField(error, 'constraint') === 'agents_token_hash_unique' &&
        attempt < 2
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new Error('token hash collision');
}

const SESSION_TTL = '12 hours';
const NOTICE_TTL = '120 seconds';
const SESSION_PATTERN = '^[A-Za-z0-9_-]{32,128}$';

const NOTICE_FAILURES = new Set([
  'unconfigured',
  'unreachable',
  'database_unavailable',
  'unauthorized',
  'invalid',
  'conflict',
  'not_found',
  'failed',
  'unknown',
]);

function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

function dashboardHeader(header: string | string[] | undefined): string {
  return typeof header === 'string' ? header : '';
}

function parseNotice(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.type === 'issued' || 'token' in record) {
    return undefined;
  }
  if (record.type === 'revoked') {
    if (typeof record.name !== 'string' || record.name.length > 64) {
      return undefined;
    }
    return { type: 'revoked', name: record.name };
  }
  if (
    record.type === 'failure' &&
    typeof record.failure === 'string' &&
    NOTICE_FAILURES.has(record.failure)
  ) {
    return { type: 'failure', failure: record.failure };
  }
  return undefined;
}

function storedNotice(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try {
      return parseNotice(JSON.parse(value) as unknown);
    } catch {
      return undefined;
    }
  }
  return parseNotice(value);
}

export function registerDashboardRoutes(
  parent: FastifyInstance,
  pool: Pool,
  onlineInterval: string,
  dashboardSecret: string | undefined,
): void {
  parent.register(async (app) => {
    app.addHook('onRequest', async (request, reply) => {
      const provided = dashboardHeader(request.headers['x-dashboard-secret']);
      if (
        dashboardSecret === undefined ||
        dashboardSecret === '' ||
        !secretsEqual(dashboardSecret, provided)
      ) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
    });

    app.get(
      '/dashboard/agents',
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
                    required: [
                      'id',
                      'name',
                      'online',
                      'lastSeenAt',
                      'createdAt',
                      'tokenRevoked',
                    ],
                    properties: AGENT_PROPERTIES,
                  },
                },
              },
            },
          },
        },
      },
      async () => {
        const result = await pool.query<{
          id: string;
          name: string;
          online: boolean;
          last_seen_at: Date | string | null;
          created_at: Date | string;
          token_revoked: boolean;
        }>(
          `WITH expired AS (
             UPDATE agents
             SET pending_token_hash = NULL,
                 pending_expires_at = NULL
             WHERE pending_expires_at <= clock_timestamp()
             RETURNING id
           )
           SELECT id,
                name,
                created_at,
                last_seen_at,
                (
                  token_revoked
                  AND NOT (
                    pending_token_hash IS NOT NULL
                    AND pending_expires_at > clock_timestamp()
                  )
                ) AS token_revoked,
                (
                  last_seen_at IS NOT NULL
                  AND last_seen_at >= clock_timestamp() - $1::interval
                ) AS online
           FROM agents
           WHERE id IS NOT NULL
              OR id IN (SELECT id FROM expired)
           ORDER BY name ASC`,
          [onlineInterval],
        );
        const agents: DashboardAgent[] = result.rows.map((row) => ({
          id: row.id,
          name: row.name,
          online: row.online,
          lastSeenAt: isoTime(row.last_seen_at),
          createdAt: isoTime(row.created_at) ?? '',
          tokenRevoked: row.token_revoked,
        }));
        return { agents };
      },
    );

    app.get<{ Querystring: PageQuery }>(
      '/dashboard/messages',
      {
        schema: {
          querystring: PAGE_QUERY,
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
                    required: ['id', 'from', 'to', 'body', 'createdAt'],
                    properties: {
                      id: { type: 'string' },
                      from: { type: 'string' },
                      to: { type: 'string' },
                      body: { type: 'string' },
                      createdAt: { type: 'string' },
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
        const limit = inboxLimit(request.query.limit);
        const cursor = parseCursor(request.query.after);
        if (limit === undefined || cursor === undefined) {
          return reply.code(400).send({ error: 'invalid request' });
        }
        const result = await pool.query<{
          id: string;
          from_name: string;
          to_name: string;
          body: string;
          created_at: Date | string;
        }>(
          `SELECT m.id,
                sender.name AS from_name,
                CASE
                  WHEN m.to_agent IS NULL THEN '*'
                  ELSE COALESCE(recipient.name, 'unknown')
                END AS to_name,
                m.body,
                date_trunc('milliseconds', m.created_at) AS created_at
         FROM messages m
         JOIN agents sender ON sender.id = m.from_agent
         LEFT JOIN agents recipient ON recipient.id = m.to_agent
         WHERE (
           $1::timestamptz IS NULL
           OR (
             date_trunc('milliseconds', m.created_at),
             m.id
           ) > ($1::timestamptz, $2::uuid)
         )
         ORDER BY date_trunc('milliseconds', m.created_at) ASC, m.id ASC
         LIMIT $3`,
          [cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
        );
        const hasMore = result.rows.length > limit;
        const pageRows = hasMore ? result.rows.slice(0, limit) : result.rows;
        const messages: HistoryMessage[] = pageRows.map((row) => ({
          id: row.id,
          from: row.from_name,
          to: row.to_name,
          body: row.body,
          createdAt: isoTime(row.created_at) ?? '',
        }));
        const last = messages[messages.length - 1];
        const page: HistoryPage = {
          messages,
          next:
            hasMore && last !== undefined
              ? `${last.createdAt}|${last.id}`
              : null,
        };
        return page;
      },
    );

    app.get<{ Params: AgentParams; Querystring: InboxQuery }>(
      '/dashboard/agents/:id/inbox',
      {
        schema: {
          params: {
            type: 'object',
            additionalProperties: false,
            required: ['id'],
            properties: { id: ID_SCHEMA },
          },
          querystring: INBOX_QUERY,
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
                    required: [
                      'id',
                      'from',
                      'to',
                      'body',
                      'createdAt',
                      'readAt',
                    ],
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
        const limit = inboxLimit(request.query.limit);
        const cursor = parseCursor(request.query.after);
        if (limit === undefined || cursor === undefined) {
          return reply.code(400).send({ error: 'invalid request' });
        }
        const found = await pool.query<{ id: string }>(
          'SELECT id FROM agents WHERE id = $1::uuid',
          [request.params.id],
        );
        if (found.rows[0] === undefined) {
          return reply.code(404).send({ error: 'not found' });
        }
        return readInbox(pool, request.params.id, {
          unreadOnly: request.query.unread === 'true',
          cursor,
          limit,
        });
      },
    );

    app.post<{ Body: RegisterBody }>(
      '/dashboard/agents',
      {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['name'],
            properties: { name: NAME_SCHEMA },
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
        for (let attempt = 0; attempt < 3; attempt += 1) {
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
            if (
              pgField(error, 'code') === '23505' &&
              pgField(error, 'constraint') === 'agents_token_hash_unique' &&
              attempt < 2
            ) {
              continue;
            }
            throw error;
          }
        }
        throw new Error('token hash collision');
      },
    );

    app.post<{ Params: AgentParams }>(
      '/dashboard/agents/:id/token',
      {
        schema: {
          params: {
            type: 'object',
            additionalProperties: false,
            required: ['id'],
            properties: { id: ID_SCHEMA },
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
        const stored = await storePendingToken(pool, request.params.id);
        if (stored === undefined) {
          return reply.code(404).send({ error: 'not found' });
        }
        const body: RegisteredAgent = {
          id: stored.id,
          name: stored.name,
          token: stored.token,
        };
        return reply.code(201).send(body);
      },
    );

    app.post<{ Params: AgentParams }>(
      '/dashboard/agents/:id/token/revoke',
      {
        schema: {
          params: {
            type: 'object',
            additionalProperties: false,
            required: ['id'],
            properties: { id: ID_SCHEMA },
          },
          response: {
            200: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'name', 'tokenRevoked'],
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                tokenRevoked: { type: 'boolean' },
              },
            },
          },
        },
      },
      async (request, reply) => {
        const stored = await revokeStoredToken(pool, request.params.id);
        if (stored === undefined) {
          return reply.code(404).send({ error: 'not found' });
        }
        const body: RevokedAgent = {
          id: stored.id,
          name: stored.name,
          tokenRevoked: true,
        };
        return body;
      },
    );

    app.post<{ Params: AgentParams }>(
      '/dashboard/agents/:id/token/confirm',
      {
        schema: {
          params: {
            type: 'object',
            additionalProperties: false,
            required: ['id'],
            properties: { id: ID_SCHEMA },
          },
          response: {
            200: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'name'],
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
              },
            },
          },
        },
      },
      async (request, reply) => {
        const result = await pool.query<{ id: string; name: string }>(
          `WITH expired AS (
             UPDATE agents
             SET pending_token_hash = NULL,
                 pending_expires_at = NULL
             WHERE id = $1::uuid
               AND pending_expires_at <= clock_timestamp()
             RETURNING id
           ),
           promoted AS (
             UPDATE agents
             SET token_hash = pending_token_hash,
                 pending_token_hash = NULL,
                 pending_expires_at = NULL,
                 token_revoked = false
             WHERE id = $1::uuid
               AND pending_token_hash IS NOT NULL
               AND pending_expires_at > clock_timestamp()
             RETURNING id, name
           )
           SELECT id, name
           FROM promoted
           UNION ALL
           SELECT id, NULL::text
           FROM expired
           WHERE false`,
          [request.params.id],
        );
        const row = result.rows[0];
        if (row === undefined) {
          return reply.code(404).send({ error: 'not found' });
        }
        return { id: row.id, name: row.name };
      },
    );

    app.post<{ Params: AgentParams }>(
      '/dashboard/agents/:id/token/discard',
      {
        schema: {
          params: {
            type: 'object',
            additionalProperties: false,
            required: ['id'],
            properties: { id: ID_SCHEMA },
          },
        },
      },
      async (request, reply) => {
        await pool.query(
          `UPDATE agents
           SET pending_token_hash = NULL,
               pending_expires_at = NULL
           WHERE id = $1::uuid`,
          [request.params.id],
        );
        return reply.code(204).send();
      },
    );

    app.post('/dashboard/sessions', async (_request, reply) => {
      const id = newSecret();
      const csrfToken = newSecret();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'DELETE FROM dashboard_sessions WHERE expires_at <= clock_timestamp()',
        );
        await client.query(
          `INSERT INTO dashboard_sessions (id, csrf_token, expires_at)
             VALUES ($1, $2, clock_timestamp() + $3::interval)`,
          [id, csrfToken, SESSION_TTL],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      return reply.code(201).send({ id, csrfToken });
    });

    app.get<{ Params: { id: string } }>(
      '/dashboard/sessions/:id',
      {
        schema: {
          params: {
            type: 'object',
            additionalProperties: false,
            required: ['id'],
            properties: { id: { type: 'string', pattern: SESSION_PATTERN } },
          },
        },
      },
      async (request, reply) => {
        const result = await pool.query<{ csrf_token: string }>(
          `SELECT csrf_token
           FROM dashboard_sessions
           WHERE id = $1
             AND expires_at > clock_timestamp()`,
          [request.params.id],
        );
        const row = result.rows[0];
        if (row === undefined) {
          return reply.code(404).send({ error: 'not found' });
        }
        return { csrfToken: row.csrf_token };
      },
    );

    app.delete<{ Params: { id: string } }>(
      '/dashboard/sessions/:id',
      {
        schema: {
          params: {
            type: 'object',
            additionalProperties: false,
            required: ['id'],
            properties: { id: { type: 'string', pattern: SESSION_PATTERN } },
          },
        },
      },
      async (request, reply) => {
        await pool.query('DELETE FROM dashboard_sessions WHERE id = $1', [
          request.params.id,
        ]);
        return reply.code(204).send();
      },
    );

    app.post<{ Params: { id: string }; Body: unknown }>(
      '/dashboard/sessions/:id/notices',
      {
        schema: {
          params: {
            type: 'object',
            additionalProperties: false,
            required: ['id'],
            properties: { id: { type: 'string', pattern: SESSION_PATTERN } },
          },
        },
      },
      async (request, reply) => {
        const payload = parseNotice(request.body);
        if (payload === undefined) {
          return reply.code(400).send({ error: 'invalid request' });
        }
        const noticeId = newSecret();
        const result = await pool.query<{ id: string }>(
          `INSERT INTO dashboard_notices (id, session_id, payload, expires_at)
           SELECT $1, sessions.id, $3::jsonb, clock_timestamp() + $4::interval
           FROM dashboard_sessions AS sessions
           WHERE sessions.id = $2
             AND sessions.expires_at > clock_timestamp()
           RETURNING id`,
          [noticeId, request.params.id, JSON.stringify(payload), NOTICE_TTL],
        );
        if (result.rows[0] === undefined) {
          return reply.code(404).send({ error: 'not found' });
        }
        return reply.code(201).send({ id: noticeId });
      },
    );

    app.post<{ Params: { id: string; noticeId: string } }>(
      '/dashboard/sessions/:id/notices/:noticeId/take',
      {
        schema: {
          params: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'noticeId'],
            properties: {
              id: { type: 'string', pattern: SESSION_PATTERN },
              noticeId: { type: 'string', pattern: SESSION_PATTERN },
            },
          },
        },
      },
      async (request, reply) => {
        const result = await pool.query<{ payload: unknown }>(
          `DELETE FROM dashboard_notices
           WHERE id = $1
             AND session_id = $2
             AND expires_at > clock_timestamp()
           RETURNING payload`,
          [request.params.noticeId, request.params.id],
        );
        const row = result.rows[0];
        const payload =
          row === undefined ? undefined : storedNotice(row.payload);
        if (payload === undefined) {
          return reply.code(404).send({ error: 'not found' });
        }
        return payload;
      },
    );
  });
}
