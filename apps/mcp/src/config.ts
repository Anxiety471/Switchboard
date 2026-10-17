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
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error('SWITCHBOARD_TOKEN is invalid');
  }
  const path = url.pathname.replace(/\/$/, '');
  return { url: `${url.origin}${path}`, token };
}
