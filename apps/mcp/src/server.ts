import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SwitchboardClient, SwitchboardError } from './api.js';
import type { SwitchboardClientOptions } from './api.js';

// Client-side checks give friendlier errors and mirror the API limits.
const RECIPIENT = /^(?:\*|[A-Za-z0-9][A-Za-z0-9_-]{0,63})$/;
const MAX_BODY_BYTES = 8192;
const CURSOR =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const FILTER_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

function validCursor(value: string): boolean {
  const match = CURSOR.exec(value);
  const createdAt = match?.[1];
  if (createdAt === undefined) {
    return false;
  }
  const year = Number(createdAt.slice(0, 4));
  if (!Number.isInteger(year) || year < 1 || year > 9999) {
    return false;
  }
  const parsed = new Date(createdAt);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === createdAt;
}

function validSearchCursor(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  if (Buffer.from(decoded, 'utf8').toString('base64url') !== value) {
    return false;
  }
  return validCursor(decoded);
}

function validFilterTime(value: string): boolean {
  const match = FILTER_TIME.exec(value);
  const yearText = match?.[1];
  const offset = match?.[8];
  if (yearText === undefined || offset === undefined || match === null) {
    return false;
  }
  const year = Number(yearText);
  if (!Number.isInteger(year) || year < 1 || year > 9999) {
    return false;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }
  let shift = 0;
  if (offset !== 'Z') {
    const parsedOffset = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
    const sign = parsedOffset?.[1];
    const hours = parsedOffset?.[2];
    const minutes = parsedOffset?.[3];
    if (sign === undefined || hours === undefined || minutes === undefined) {
      return false;
    }
    const hour = Number(hours);
    const minute = Number(minutes);
    if (hour > 23 || minute > 59) {
      return false;
    }
    shift = (sign === '-' ? -1 : 1) * (hour * 60 + minute);
  }
  const wall = new Date(parsed.getTime() + shift * 60_000);
  const fields = [1, 2, 3, 4, 5, 6].map((group) => Number(match[group]));
  return (
    wall.getUTCFullYear() === fields[0] &&
    wall.getUTCMonth() + 1 === fields[1] &&
    wall.getUTCDate() === fields[2] &&
    wall.getUTCHours() === fields[3] &&
    wall.getUTCMinutes() === fields[4] &&
    wall.getUTCSeconds() === fields[5] &&
    wall.getUTCFullYear() >= 1 &&
    wall.getUTCFullYear() <= 9999
  );
}

function messageBody() {
  return z
    .string()
    .min(1)
    .max(MAX_BODY_BYTES)
    .refine(
      (value) =>
        !value.includes('\0') &&
        Buffer.byteLength(value, 'utf8') <= MAX_BODY_BYTES,
      { message: 'body must be 1 to 8192 bytes and must not contain NUL' },
    );
}

function jsonResult(data: object) {
  const text = JSON.stringify(data);
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: JSON.parse(text) as Record<string, unknown>,
  };
}

function toolFailure(error: unknown) {
  if (error instanceof SwitchboardError && error.code === 'api_unreachable') {
    return {
      isError: true as const,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            error: error.code,
            message: error.message,
          }),
        },
      ],
    };
  }
  const status = error instanceof SwitchboardError ? error.status : 0;
  const code =
    error instanceof SwitchboardError ? error.code : 'request_failed';
  return {
    isError: true as const,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ error: code, status }),
      },
    ],
  };
}

export function createMcpServer(options: SwitchboardClientOptions): McpServer {
  const client = new SwitchboardClient(options);
  const server = new McpServer(
    { name: 'switchboard', version: '0.0.0' },
    {
      instructions:
        'Switchboard tools use the agent token in this process. list_agents shows registered agents, send_message sends to one agent or broadcasts with *, check_inbox reads this inbox and marks the returned page read, and search_messages searches received and sent messages without marking them read. If mark-read cannot be confirmed, check_inbox still returns that page with a warning.',
    },
  );

  server.registerTool(
    'list_agents',
    {
      title: 'List agents',
      description:
        'List registered Switchboard agents. online is true when the agent was seen in the last 60 seconds.',
    },
    async () => {
      try {
        const listed = await client.listAgents();
        return jsonResult({ agents: listed.agents });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    'send_message',
    {
      title: 'Send message',
      description:
        'Send a message to an agent by name, or "*" to broadcast to every other agent. Names are case-insensitive. You cannot message yourself.',
      inputSchema: {
        to: z
          .string()
          .regex(RECIPIENT, 'invalid recipient')
          .describe('Agent name, or * to broadcast to every other agent'),
        body: messageBody().describe('Message text, from 1 to 8192 bytes'),
      },
    },
    async ({ to, body }) => {
      try {
        const sent = await client.sendMessage({ to, body });
        return jsonResult({ id: sent.id });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    'check_inbox',
    {
      title: 'Check inbox',
      description:
        'Read this inbox, oldest first. Defaults to unread messages and marks the returned page as read. Pass next as after to read another page. If mark-read cannot be confirmed, the page is still returned with a warning and messages may show again. readAt can be null when the API is an older version that does not return read times.',
      inputSchema: {
        unread: z
          .boolean()
          .default(true)
          .describe('When true, return only unread messages'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Page size from 1 to 100'),
        after: z
          .string()
          .refine(validCursor, 'invalid cursor')
          .optional()
          .describe('Cursor from the previous page next field'),
      },
    },
    async ({ unread, limit, after }) => {
      try {
        const page = await client.checkInbox({
          unread,
          ...(limit !== undefined ? { limit } : {}),
          ...(after !== undefined ? { after } : {}),
        });
        return jsonResult({
          messages: page.messages,
          next: page.next,
          read: page.read,
          ...(page.warning !== undefined ? { warning: page.warning } : {}),
        });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    'search_messages',
    {
      title: 'Search messages',
      description:
        'Search messages this agent sent or received, oldest first. Does not mark messages read. status is unread, read, or all (default unread). box is received or sent (default received). For sent messages, unread means a recipient has not read the message yet. Pass next as cursor to read another page.',
      inputSchema: {
        status: z
          .enum(['unread', 'read', 'all'])
          .default('unread')
          .describe('unread, read, or all. Defaults to unread'),
        from: z
          .string()
          .regex(AGENT_NAME, 'invalid agent name')
          .optional()
          .describe('Only messages sent by this agent name. Case-insensitive'),
        since: z
          .string()
          .refine(validFilterTime, 'invalid time')
          .optional()
          .describe('Include messages created at or after this time'),
        until: z
          .string()
          .refine(validFilterTime, 'invalid time')
          .optional()
          .describe('Include messages created at or before this time'),
        text: z
          .string()
          .min(1)
          .max(MAX_BODY_BYTES)
          .refine(
            (value) =>
              !value.includes('\0') &&
              Buffer.byteLength(value, 'utf8') <= MAX_BODY_BYTES,
            {
              message: 'text must be 1 to 8192 bytes and must not contain NUL',
            },
          )
          .optional()
          .describe(
            'Case-insensitive body match. Percent, underscore, and backslash are literal',
          ),
        box: z
          .enum(['received', 'sent'])
          .default('received')
          .describe('received or sent. Defaults to received'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Page size from 1 to 100'),
        cursor: z
          .string()
          .refine(validSearchCursor, 'invalid cursor')
          .optional()
          .describe('Opaque cursor from the previous page next field'),
      },
    },
    async ({ status, from, since, until, text, box, limit, cursor }) => {
      try {
        const page = await client.searchMessages({
          status,
          box,
          ...(from !== undefined ? { from } : {}),
          ...(since !== undefined ? { since } : {}),
          ...(until !== undefined ? { until } : {}),
          ...(text !== undefined ? { text } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
        });
        return jsonResult({
          messages: page.messages,
          next: page.next,
        });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  return server;
}
