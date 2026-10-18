export type AgentId = string;

export type RegisteredAgent = {
  id: AgentId;
  name: string;
  token: string;
};

export type AgentSummary = {
  id: AgentId;
  name: string;
  online: boolean;
  lastSeenAt: string | null;
};

export type DashboardAgent = {
  id: AgentId;
  name: string;
  online: boolean;
  lastSeenAt: string | null;
  createdAt: string;
  tokenRevoked: boolean;
};

export type RevokedAgent = {
  id: AgentId;
  name: string;
  tokenRevoked: true;
};

export type SentMessage = {
  id: string;
};

export type InboxMessage = {
  id: string;
  from: string;
  to: string;
  body: string;
  createdAt: string;
  readAt: string | null;
};

export type InboxPage = {
  messages: InboxMessage[];
  next: string | null;
};

export type MarkedRead = {
  id: string;
  readAt: string | null;
};

export type ReadReceipt = {
  read: string[];
  marked: MarkedRead[];
};

export const MAX_SEARCH_TEXT_BYTES = 1024;

export type MessageCursor = {
  createdAt: string;
  id: string;
};

const CURSOR_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\|([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
const FILTER_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

function isCursorTime(value: string): boolean {
  const year = Number(value.slice(0, 4));
  if (!Number.isInteger(year) || year < 1 || year > 9999) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

export function parseInboxCursor(value: string): MessageCursor | undefined {
  const match = CURSOR_PATTERN.exec(value);
  const createdAt = match?.[1];
  const id = match?.[2];
  if (createdAt === undefined || id === undefined || !isCursorTime(createdAt)) {
    return undefined;
  }
  return { createdAt, id };
}

export function encodeSearchCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, 'utf8').toString('base64url');
}

export function parseSearchCursor(value: string): MessageCursor | undefined {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    return undefined;
  }
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  if (Buffer.from(decoded, 'utf8').toString('base64url') !== value) {
    return undefined;
  }
  return parseInboxCursor(decoded);
}

function offsetMinutes(offset: string): number | undefined {
  if (offset === 'Z') {
    return 0;
  }
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  const sign = match?.[1];
  const hours = match?.[2];
  const minutes = match?.[3];
  if (sign === undefined || hours === undefined || minutes === undefined) {
    return undefined;
  }
  const hour = Number(hours);
  const minute = Number(minutes);
  if (hour > 23 || minute > 59) {
    return undefined;
  }
  return (sign === '-' ? -1 : 1) * (hour * 60 + minute);
}

export function parseFilterTime(value: string): string | undefined {
  const match = FILTER_TIME_PATTERN.exec(value);
  const yearText = match?.[1];
  const offset = match?.[8];
  if (yearText === undefined || offset === undefined || match === null) {
    return undefined;
  }
  const year = Number(yearText);
  if (!Number.isInteger(year) || year < 1 || year > 9999) {
    return undefined;
  }
  const parsed = new Date(value);
  const shift = offsetMinutes(offset);
  if (Number.isNaN(parsed.getTime()) || shift === undefined) {
    return undefined;
  }
  const wall = new Date(parsed.getTime() + shift * 60_000);
  const fields = [1, 2, 3, 4, 5, 6].map((group) => Number(match[group]));
  if (
    wall.getUTCFullYear() !== fields[0] ||
    wall.getUTCMonth() + 1 !== fields[1] ||
    wall.getUTCDate() !== fields[2] ||
    wall.getUTCHours() !== fields[3] ||
    wall.getUTCMinutes() !== fields[4] ||
    wall.getUTCSeconds() !== fields[5] ||
    wall.getUTCFullYear() < 1 ||
    wall.getUTCFullYear() > 9999
  ) {
    return undefined;
  }
  return parsed.toISOString();
}

export type HistoryMessage = {
  id: string;
  from: string;
  to: string;
  body: string;
  createdAt: string;
};

export type HistoryPage = {
  messages: HistoryMessage[];
  next: string | null;
};
