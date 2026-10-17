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

export function loginLimited(key: string, now = Date.now()): boolean {
  const { buckets: store, overflow } = memory();
  prune(store, overflow, now);
  const bucket = store.get(key);
  if (bucket !== undefined) {
    return locked(bucket);
  }
  if (!fullOfLocks(store)) {
    return false;
  }
  return overflow.length >= MAX_FAILURES;
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

export function proxyHops(value: string | undefined): number {
  if (value === undefined || value.trim() === '') {
    return 1;
  }
  if (!/^[1-9]\d*$/.test(value.trim())) {
    return 1;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return 1;
  }
  return parsed;
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
  return `fwd:${forwarded}`;
}
