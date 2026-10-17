export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return;
  }
  const { enforceProxyHops } = await import('./lib/enforce-proxy-hops');
  enforceProxyHops(process.env);
}
