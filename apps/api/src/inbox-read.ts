import type { Pool } from 'pg';
import type { InboxMessage, InboxPage } from '@switchboard/shared';
import type { InboxCursor } from './paging.js';
import { isoTime } from './time.js';

export async function readInbox(
  pool: Pool,
  agentId: string,
  options: {
    unreadOnly: boolean;
    cursor: InboxCursor | null;
    limit: number;
  },
): Promise<InboxPage> {
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
      agentId,
      options.unreadOnly,
      options.cursor?.createdAt ?? null,
      options.cursor?.id ?? null,
      options.limit + 1,
    ],
  );
  const hasMore = result.rows.length > options.limit;
  const pageRows = hasMore ? result.rows.slice(0, options.limit) : result.rows;
  const messages: InboxMessage[] = pageRows.map((row) => ({
    id: row.id,
    from: row.from_name,
    to: row.to_name,
    body: row.body,
    createdAt: isoTime(row.created_at) ?? '',
    readAt: isoTime(row.read_at),
  }));
  const last = messages[messages.length - 1];
  return {
    messages,
    next: hasMore && last !== undefined ? `${last.createdAt}|${last.id}` : null,
  };
}
