export type DeskConfig = {
  url: string;
  secret: string;
};

export type EnvSource = Record<string, string | undefined>;

function envString(env: EnvSource, name: string): string | undefined {
  const value = env[name];
  return typeof value === 'string' ? value : undefined;
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1') {
    return true;
  }
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return false;
  }
  const numbers = parts.map((part) => Number(part));
  if (numbers.some((part) => part > 255)) {
    return false;
  }
  return numbers[0] === 127;
}

const MIN_DASHBOARD_SECRET_LENGTH = 32;

export function readDeskConfig(env: EnvSource): DeskConfig | undefined {
  const urlValue = envString(env, 'SWITCHBOARD_URL');
  const secret = envString(env, 'DASHBOARD_SECRET');
  if (
    urlValue === undefined ||
    urlValue === '' ||
    secret === undefined ||
    secret === '' ||
    secret.length < MIN_DASHBOARD_SECRET_LENGTH ||
    secret.length > 512 ||
    /[\r\n\0]/.test(secret)
  ) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    return undefined;
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    (url.protocol === 'http:' && !isLoopback(url.hostname))
  ) {
    return undefined;
  }
  const path = url.pathname.replace(/\/$/, '');
  return { url: `${url.origin}${path}`, secret };
}
