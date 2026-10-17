const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export type SwitchboardConfig = {
  url: string;
  token: string;
};

export function readConfig(env: NodeJS.ProcessEnv): SwitchboardConfig {
  const urlValue = env.SWITCHBOARD_URL;
  const token = env.SWITCHBOARD_TOKEN;
  if (urlValue === undefined || urlValue === '') {
    throw new Error('SWITCHBOARD_URL is required');
  }
  if (token === undefined || token === '') {
    throw new Error('SWITCHBOARD_TOKEN is required');
  }
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new Error('SWITCHBOARD_URL is invalid');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('SWITCHBOARD_URL is invalid');
  }
  if (url.protocol === 'http:' && !isLoopback(url.hostname)) {
    throw new Error('SWITCHBOARD_URL must use https');
  }
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error('SWITCHBOARD_TOKEN is invalid');
  }
  const path = url.pathname.replace(/\/$/, '');
  return { url: `${url.origin}${path}`, token };
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
