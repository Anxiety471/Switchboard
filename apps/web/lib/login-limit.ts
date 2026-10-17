const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES = 8;
export const LOGIN_LIMIT_KEYS = 1024;
const STORE = Symbol.for('switchboard.desk.login-limits');

type Bucket = {
  failures: number[];
};

type Memory = {
  buckets: Map<string, Bucket>;
  overflow: number[];
};

function memory(): Memory {
  const host = globalThis as typeof globalThis & {
    [STORE]?: Map<string, Bucket> | Memory;
  };
  const current = host[STORE];
  if (current !== undefined && !(current instanceof Map)) {
    return current;
  }
  const created: Memory = {
    buckets: current ?? new Map(),
    overflow: [],
  };
  host[STORE] = created;
  return created;
}

function prune(
  store: Map<string, Bucket>,
  overflow: number[],
  now: number,
): void {
  for (const [key, bucket] of store) {
    bucket.failures = bucket.failures.filter((at) => now - at < WINDOW_MS);
    if (bucket.failures.length === 0) {
      store.delete(key);
    }
  }
  const live = overflow.filter((at) => now - at < WINDOW_MS);
  overflow.length = 0;
  for (const at of live) {
    overflow.push(at);
  }
}

function locked(bucket: Bucket): boolean {
  return bucket.failures.length >= MAX_FAILURES;
}

function evictOldestUnlocked(store: Map<string, Bucket>): boolean {
  for (const [key, bucket] of store) {
    if (!locked(bucket)) {
      store.delete(key);
      return true;
    }
  }
  return false;
}

function fullOfLocks(store: Map<string, Bucket>): boolean {
  if (store.size < LOGIN_LIMIT_KEYS) {
    return false;
  }
  for (const bucket of store.values()) {
    if (!locked(bucket)) {
      return false;
    }
  }
  return true;
}

export type DeskLoginPlacement = 'open' | 'locked' | 'overflow';

export function loginPlacement(
  key: string,
  now = Date.now(),
): DeskLoginPlacement {
  const { buckets: store, overflow } = memory();
  prune(store, overflow, now);
  const bucket = store.get(key);
  if (bucket !== undefined) {
    return locked(bucket) ? 'locked' : 'open';
  }
  if (fullOfLocks(store)) {
    return 'overflow';
  }
  return 'open';
}

export function loginLimited(key: string, now = Date.now()): boolean {
  const placement = loginPlacement(key, now);
  if (placement === 'locked') {
    return true;
  }
  if (placement !== 'overflow') {
    return false;
  }
  return memory().overflow.length >= MAX_FAILURES;
}

export function noteLoginFailure(key: string, now = Date.now()): void {
  const { buckets: store, overflow } = memory();
  prune(store, overflow, now);
  const existing = store.get(key);
  if (existing !== undefined) {
    if (locked(existing)) {
      return;
    }
    existing.failures.push(now);
    return;
  }
  if (store.size >= LOGIN_LIMIT_KEYS && !evictOldestUnlocked(store)) {
    if (overflow.length < MAX_FAILURES) {
      overflow.push(now);
    }
    return;
  }
  store.set(key, { failures: [now] });
}

export function clearLoginFailures(key: string): void {
  memory().buckets.delete(key);
}

export function resetLoginLimits(): void {
  const { buckets: store, overflow } = memory();
  store.clear();
  overflow.length = 0;
}

export function trustProxyEnabled(value: string | undefined): boolean {
  return value !== undefined && value !== '';
}

export class ProxyHopsError extends Error {
  constructor() {
    super('TRUST_PROXY_HOPS must be a positive integer');
    this.name = 'ProxyHopsError';
  }
}

export function proxyHops(value: string | undefined): number {
  if (value === undefined || value.trim() === '') {
    return 1;
  }
  const trimmed = value.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new ProxyHopsError();
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    throw new ProxyHopsError();
  }
  return parsed;
}

function ipv6Prefix(address: string): string | undefined {
  const halves = address.toLowerCase().split('::');
  if (halves.length > 2) {
    return undefined;
  }
  const parseSide = (side: string): string[] | undefined => {
    if (side === '') {
      return [];
    }
    const groups = side.split(':');
    if (groups.some((group) => group === '')) {
      return undefined;
    }
    return groups;
  };
  const head = parseSide(halves[0] ?? '');
  if (head === undefined) {
    return undefined;
  }
  let groups: string[];
  if (halves.length === 1) {
    groups = head;
  } else {
    const tail = parseSide(halves[1] ?? '');
    if (tail === undefined) {
      return undefined;
    }
    const missing = 8 - head.length - tail.length;
    if (missing < 1) {
      return undefined;
    }
    groups = [...head, ...Array.from({ length: missing }, () => '0'), ...tail];
  }
  if (groups.length !== 8) {
    return undefined;
  }
  const parsed: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) {
      return undefined;
    }
    parsed.push(Number.parseInt(group, 16));
  }
  return parsed
    .slice(0, 4)
    .map((value) => value.toString(16))
    .join(':');
}

function bucketAddress(address: string): string | undefined {
  if (!address.includes(':')) {
    return address;
  }
  return ipv6Prefix(address);
}

function forwardedClient(
  header: string | null,
  hops: number,
): string | undefined {
  if (header === null || !Number.isInteger(hops) || hops < 1) {
    return undefined;
  }
  const entries: string[] = [];
  for (const part of header.split(',')) {
    const trimmed = part.trim();
    if (trimmed !== '') {
      entries.push(trimmed);
    }
  }
  const chosen = entries[entries.length - hops];
  if (
    chosen === undefined ||
    !/^[0-9A-Za-z:.]+$/.test(chosen) ||
    chosen.length > 64
  ) {
    return undefined;
  }
  return chosen;
}

export function deskClientKey(input: {
  forwardedFor: string | null;
  trustProxy: boolean;
  hops?: number;
}): string | undefined {
  if (!input.trustProxy) {
    return undefined;
  }
  const forwarded = forwardedClient(input.forwardedFor, input.hops ?? 1);
  if (forwarded === undefined) {
    return undefined;
  }
  const address = bucketAddress(forwarded);
  if (address === undefined) {
    return undefined;
  }
  return `fwd:${address}`;
}
