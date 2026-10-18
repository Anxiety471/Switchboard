const DEFAULT_INBOX_LIMIT = 50;
const MAX_INBOX_LIMIT = 200;

export const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

const CURSOR_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\|([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

export type InboxCursor = {
  createdAt: string;
  id: string;
};

export function inboxLimit(value: string | undefined): number | undefined {
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

export function parseCursor(
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
