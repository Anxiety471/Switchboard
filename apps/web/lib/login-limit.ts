const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES = 8;
const MAX_KEYS = 1024;
const STORE = Symbol.for('switchboard.desk.login-limits');

type Bucket = {
  failures: number[];
};

function buckets(): Map<string, Bucket> {
  const host = globalThis as typeof globalThis & {
    [STORE]?: Map<string, Bucket>;
  };
  host[STORE] ??= new Map();
  return host[STORE];
}

function prune(store: Map<string, Bucket>, now: number): void {
  for (const [key, bucket] of store) {
    bucket.failures = bucket.failures.filter((at) => now - at < WINDOW_MS);
    if (bucket.failures.length === 0) {
      store.delete(key);
    }
  }
}

export function loginLimited(key: string, now = Date.now()): boolean {
  const store = buckets();
  prune(store, now);
  const bucket = store.get(key);
  return bucket !== undefined && bucket.failures.length >= MAX_FAILURES;
}

export function noteLoginFailure(key: string, now = Date.now()): void {
  const store = buckets();
  prune(store, now);
  const existing = store.get(key);
  if (existing !== undefined && existing.failures.length >= MAX_FAILURES) {
    return;
  }
  let bucket = existing;
  if (bucket === undefined) {
    if (store.size >= MAX_KEYS) {
      const oldest = store.keys().next().value;
      if (oldest !== undefined) {
        store.delete(oldest);
      }
    }
    bucket = { failures: [] };
    store.set(key, bucket);
  }
  bucket.failures.push(now);
}

export function clearLoginFailures(key: string): void {
  buckets().delete(key);
}

export function resetLoginLimits(): void {
  buckets().clear();
}

export function trustProxyEnabled(value: string | undefined): boolean {
  return value !== undefined && value !== '';
}

function forwardedClient(header: string | null): string | undefined {
  if (header === null) {
    return undefined;
  }
  const first = header.split(',')[0]?.trim() ?? '';
  if (first === '' || !/^[0-9A-Za-z:.]+$/.test(first) || first.length > 64) {
    return undefined;
  }
  return first;
}

export function deskClientKey(input: {
  forwardedFor: string | null;
  socketAddress: string | null;
  trustProxy: boolean;
}): string {
  if (input.trustProxy) {
    const forwarded = forwardedClient(input.forwardedFor);
    if (forwarded !== undefined) {
      return `fwd:${forwarded}`;
    }
  }
  if (input.socketAddress !== null && input.socketAddress !== '') {
    return `sock:${input.socketAddress}`;
  }
  return 'sock:unknown';
}

export function socketAddress(request: Request): string | null {
  const candidate = request as Request & {
    socket?: { remoteAddress?: unknown };
    ip?: unknown;
  };
  if (
    typeof candidate.socket?.remoteAddress === 'string' &&
    candidate.socket.remoteAddress !== ''
  ) {
    return candidate.socket.remoteAddress;
  }
  if (typeof candidate.ip === 'string' && candidate.ip !== '') {
    return candidate.ip;
  }
  return null;
}
