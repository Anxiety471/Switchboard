import { ProxyHopsError, proxyHops } from './login-limit';

export function enforceProxyHops(env: NodeJS.ProcessEnv): void {
  try {
    proxyHops(env.TRUST_PROXY_HOPS);
  } catch (error) {
    if (error instanceof ProxyHopsError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}
