import { createHash } from 'node:crypto';
import { createConnection, createServer } from 'node:net';
import os from 'node:os';

import { errorCode } from './machine.js';

const HOST = '127.0.0.1';
const DYNAMIC_PORT_MIN = 49_152;
const DYNAMIC_PORT_COUNT = 16_384;
const PORT_HASH_HEX_LENGTH = 8;
const OWNER_PROBE_TIMEOUT_MS = 500;

/**
 * 为当前系统用户获取基于回环监听端口的单实例租约
 *
 * @returns 用于关闭监听并释放租约的 release 方法
 * @throws Error - 用户身份读取失败时 Promise 拒绝；端口已响应同一用户的租约标识时以 instance-already-running 拒绝
 * 无法确认占用者或监听失败时以 instance-lock-unavailable 拒绝
 * @remarks 监听不阻止进程退出；进程终止时内核释放端口
 */
export async function acquireInstance(): Promise<{ release(): Promise<void> }> {
  // 用系统用户信息固定身份，避免 HOME、USERPROFILE 或 Claude 配置根变化产生第二个实例身份
  const user = os.userInfo();
  const identity = createHash('sha256')
    .update(JSON.stringify([process.platform, user.uid, user.username, user.homedir]))
    .digest('hex');
  const port = DYNAMIC_PORT_MIN + (Number.parseInt(identity.slice(0, PORT_HASH_HEX_LENGTH), 16) % DYNAMIC_PORT_COUNT);
  const signature = `ccw-instance:${identity}\n`;
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
    /** 关闭监听并释放租约；关闭失败或重复释放时 Promise 拒绝 */
    release: () =>
      new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

function isOwner(port: number, signature: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host: HOST, port });
    let response = '';
    const finish = (matches: boolean) => {
      socket.destroy();
      resolve(matches);
    };
    socket.setEncoding('utf8');
    socket.setTimeout(OWNER_PROBE_TIMEOUT_MS, () => finish(false));
    socket.on('error', () => finish(false));
    socket.on('end', () => finish(response === signature));
    socket.on('data', (chunk: string) => {
      response += chunk;
      if (response.length >= signature.length) finish(response === signature);
    });
  });
}
