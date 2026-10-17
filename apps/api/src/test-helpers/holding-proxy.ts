import { connect, createServer, type Server, type Socket } from 'node:net';

type Proxied = {
  client: Socket;
  upstream: Socket;
  ready: boolean;
  hold: boolean;
};

export type HoldingProxy = {
  port: number;
  connectionCount(): number;
  arm(): Promise<void>;
  dropHeld(): void;
  close(): Promise<void>;
};

export function startHoldingProxy(
  upstreamHost: string,
  upstreamPort: number,
): Promise<HoldingProxy> {
  const connections: Proxied[] = [];
  let holdNext = false;
  let armResolve: (() => void) | undefined;
  let armTimer: NodeJS.Timeout | undefined;
  const server: Server = createServer((client) => {
    const upstream = connect(upstreamPort, upstreamHost);
    const connection: Proxied = {
      client,
      upstream,
      ready: false,
      hold: false,
    };
    connections.push(connection);

    client.on('data', (chunk: Buffer) => {
      if (connection.hold || (holdNext && connection.ready)) {
        if (!connection.hold) {
          connection.hold = true;
          holdNext = false;
          const resolve = armResolve;
          armResolve = undefined;
          if (armTimer) {
            clearTimeout(armTimer);
            armTimer = undefined;
          }
          resolve?.();
        }
        return;
      }
      if (!upstream.destroyed) {
        upstream.write(chunk);
      }
    });

    upstream.on('data', (chunk: Buffer) => {
      connection.ready = true;
      if (!client.destroyed) {
        client.write(chunk);
      }
    });

    const destroyBoth = (): void => {
      if (!client.destroyed) {
        client.destroy();
      }
      if (!upstream.destroyed) {
        upstream.destroy();
      }
    };
    client.on('error', destroyBoth);
    upstream.on('error', destroyBoth);
    client.on('close', () => {
      if (!upstream.destroyed) {
        upstream.destroy();
      }
    });
    upstream.on('close', () => {
      if (!client.destroyed) {
        client.destroy();
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('proxy failed to bind'));
        return;
      }
      resolve({
        port: address.port,
        connectionCount() {
          return connections.length;
        },
        arm() {
          return new Promise<void>((resolveArmed, rejectArmed) => {
            armTimer = setTimeout(() => {
              armResolve = undefined;
              holdNext = false;
              rejectArmed(new Error('timed out waiting for the next query'));
            }, 5000);
            armResolve = () => {
              resolveArmed();
            };
            holdNext = true;
          });
        },
        dropHeld() {
          for (const connection of connections) {
            if (!connection.hold) {
              continue;
            }
            if (!connection.client.destroyed) {
              connection.client.destroy();
            }
            if (!connection.upstream.destroyed) {
              connection.upstream.destroy();
            }
          }
        },
        close() {
          if (armTimer) {
            clearTimeout(armTimer);
            armTimer = undefined;
          }
          for (const connection of connections) {
            if (!connection.client.destroyed) {
              connection.client.destroy();
            }
            if (!connection.upstream.destroyed) {
              connection.upstream.destroy();
            }
          }
          return new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) => {
              if (error) {
                rejectClose(error);
              } else {
                resolveClose();
              }
            });
          });
        },
      });
    });
  });
}
