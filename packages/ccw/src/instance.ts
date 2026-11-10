import { createHash } from 'node:crypto';
import { createConnection, createServer } from 'node:net';
import os from 'node:os';

import { errorCode } from './machine.js';

const HOST = '127.0.0.1';

function isOwner(port: number, signature: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host: HOST, port });
    let response = '';
    const finish = (matches: boolean) => {
      socket.destroy();
      resolve(matches);
    };
    socket.setEncoding('utf8');
    socket.setTimeout(500, () => finish(false));
    socket.on('error', () => finish(false));
    socket.on('end', () => finish(response === signature));
    socket.on('data', (chunk: string) => {
      response += chunk;
      if (response.length >= signature.length) finish(response === signature);
    });
  });
}

/** Startup owns this lease; the kernel also releases it on forced process exit. */
export async function acquireInstance(): Promise<{ release(): Promise<void> }> {
  // userInfo comes from the OS, unlike homedir(), HOME or USERPROFILE. Changing
  // Claude/configuration roots must never create a second instance identity.
  const user = os.userInfo();
  const identity = createHash('sha256')
    .update(JSON.stringify([process.platform, user.uid, user.username, user.homedir]))
    .digest('hex');
  const port = 49152 + (Number.parseInt(identity.slice(0, 8), 16) % 16384);
  const signature = `ccw-instance-v1:${identity}\n`;
  const server = createServer(socket => {
    socket.on('error', () => socket.destroy());
    socket.end(signature, () => socket.destroy());
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: HOST, port, exclusive: true }, resolve);
    });
  } catch (error) {
    const owned = errorCode(error) === 'EADDRINUSE' && (await isOwner(port, signature));
    throw new Error(owned ? 'instance-already-running' : 'instance-lock-unavailable', { cause: error });
  }
  server.unref();
  return {
    release: () =>
      new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
