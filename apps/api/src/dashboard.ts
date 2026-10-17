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
import { generateToken, hashToken } from './token.js';
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

async function storeToken(
  pool: Pool,
  agentId: string,
  revoked: boolean,
): Promise<{ id: string; name: string; token: string } | undefined> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = generateToken();
    try {
      const result = await pool.query<{ id: string; name: string }>(
        `UPDATE agents
         SET token_hash = $2,
             token_revoked = $3
         WHERE id = $1::uuid
         RETURNING id, name`,
        [agentId, hashToken(token), revoked],
      );
      const row = result.rows[0];
      if (row === undefined) {
        return undefined;
      }
      return { id: row.id, name: row.name, token };
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

export function registerDashboardRoutes(
  app: FastifyInstance,
  pool: Pool,
  onlineInterval: string,
): void {
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
        `SELECT id,
                name,
                created_at,
                last_seen_at,
                token_revoked,
                (
                  last_seen_at IS NOT NULL
                  AND last_seen_at >= clock_timestamp() - $1::interval
                ) AS online
         FROM agents
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
          hasMore && last !== undefined ? `${last.createdAt}|${last.id}` : null,
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
      const stored = await storeToken(pool, request.params.id, false);
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
      const stored = await storeToken(pool, request.params.id, true);
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
}
