import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SwitchboardClient, SwitchboardError } from './api.js';
import type { SwitchboardClientOptions } from './api.js';

// Client-side checks give friendlier errors and mirror the API limits.
const RECIPIENT = /^(?:\*|[A-Za-z0-9][A-Za-z0-9_-]{0,63})$/;
const MAX_BODY_BYTES = 8192;
const CURSOR =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

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
        'Switchboard tools use the agent token in this process. list_agents shows registered agents, send_message sends to one agent or broadcasts with *, and check_inbox reads this inbox and marks the returned page read. If mark-read cannot be confirmed, check_inbox still returns that page with a warning.',
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
        'Read this inbox, oldest first. Defaults to unread messages and marks the returned page as read. Pass next as after to read another page. If mark-read cannot be confirmed, the page is still returned with a warning and messages may show again.',
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

  return server;
}
