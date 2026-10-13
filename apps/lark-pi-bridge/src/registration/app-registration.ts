import { chmod, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { registerApp, type RegisterAppOptions, type RegisterAppResult } from '@larksuite/channel';
import { spawnProcess } from '../platform/spawn.js';
import type { TenantBrand } from '../config/profile-schema.js';

export const BRIDGE_APP_ADDONS: NonNullable<RegisterAppOptions['addons']> = {
  preset: false,
  scopes: {
    tenant: [
      'im:message.p2p_msg:readonly',
      'im:message.group_at_msg:readonly',
      // Per-chat mention-optional policy needs ordinary group messages to be
      // delivered before the bridge applies its local chat allowlist.
      'im:message.group_msg',
      // Receiving an image event does not authorize the message-resource
      // download endpoint. Feishu requires one of its broader message-read
      // scopes; use the least-privileged read-only option.
      'im:message:readonly',
      'im:message:send_as_bot',
      'im:resource',
      'im:chat:read',
      'cardkit:card:write',
      'docs:document.comment:read',
      'docs:document.comment:create',
      'wiki:node:read',
    ],
  },
  events: {
    items: {
      tenant: ['im.message.receive_v1', 'drive.notice.comment_add_v1'],
    },
  },
};

export interface RegisterBridgeAppOptions {
  tenant: TenantBrand;
  createOnly?: boolean;
  existingAppId?: string;
  qrFormat?: 'png' | 'ascii';
  qrOutputPath: string;
  larkCliBinary?: string;
  register?: (options: RegisterAppOptions) => Promise<RegisterAppResult>;
  writeLine?: (line: string) => void;
}

export interface RegisteredBridgeApp {
  appId: string;
  appSecret: string;
  tenant: TenantBrand;
  ownerOpenId?: string;
}

/**
 * Run the official device-code registration flow. The verification URL is
 * forwarded verbatim to lark-cli for QR rendering and is never persisted by
 * this module. The returned App Secret is handed to the caller in memory only.
 */
export async function registerBridgeApp(options: RegisterBridgeAppOptions): Promise<RegisteredBridgeApp> {
  if (options.createOnly && options.existingAppId) {
    throw new Error('--create-only 与 --existing-app 不能同时使用');
  }
  const performRegistration = options.register ?? registerApp;
  const writeLine = options.writeLine ?? ((line: string) => console.log(line));
  const qrFormat = options.qrFormat ?? 'ascii';
  const qrBinary = options.larkCliBinary ?? 'lark-cli';
  await assertQrRendererAvailable(qrBinary);
  const controller = new AbortController();
  let qrTask: Promise<void> | undefined;
  let qrError: Error | undefined;
  let result: RegisterAppResult;
  try {
    result = await performRegistration({
      domain: options.tenant === 'lark' ? 'accounts.larksuite.com' : 'accounts.feishu.cn',
      larkDomain: 'accounts.larksuite.com',
      source: 'lark-pi-bridge',
      signal: controller.signal,
      createOnly: options.createOnly,
      appId: options.existingAppId,
      appPreset: {
        name: 'Pi Coding Agent - {user}',
        desc: 'Local Pi coding-agent bridge for Feishu/Lark',
      },
      addons: BRIDGE_APP_ADDONS,
      onQRCodeReady: ({ url, expireIn }) => {
        writeLine(`请在 ${expireIn} 秒内打开或扫描以下飞书/Lark 注册链接：`);
        writeLine(url);
        qrTask = renderRegistrationQr({
          url,
          format: qrFormat,
          outputPath: options.qrOutputPath,
          binary: qrBinary,
          writeLine,
        }).catch((error: unknown) => {
          qrError = error instanceof Error ? error : new Error(String(error));
          controller.abort();
        });
      },
      onStatusChange: ({ status }) => {
        if (status === 'domain_switched') {
          writeLine('注册页面已切换飞书/Lark 域，继续等待确认。');
        }
      },
    });
  } catch (error) {
    await qrTask;
    if (qrFormat === 'png') {
      await rm(options.qrOutputPath, { force: true });
    }
    throw qrError ?? error;
  }
  await qrTask;
  if (qrFormat === 'png') {
    await rm(options.qrOutputPath, { force: true });
  }
  if (qrError) {
    throw qrError;
  }
  if (!result.client_id?.trim() || !result.client_secret) {
    throw new Error('飞书/Lark 注册结果缺少 App ID 或 App Secret');
  }
  return {
    appId: result.client_id.trim(),
    appSecret: result.client_secret,
    tenant: result.user_info?.tenant_brand ?? options.tenant,
    ...(result.user_info?.open_id ? { ownerOpenId: result.user_info.open_id } : {}),
  };
}

interface RenderQrOptions {
  url: string;
  format: 'png' | 'ascii';
  outputPath: string;
  binary: string;
  writeLine: (line: string) => void;
}

async function renderRegistrationQr(options: RenderQrOptions): Promise<void> {
  if (options.format === 'ascii') {
    const result = await captureQr(options.binary, ['auth', 'qrcode', options.url, '--ascii'], process.cwd());
    options.writeLine(result);
    return;
  }
  const outputDir = dirname(options.outputPath);
  const outputName = basename(options.outputPath);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  await rm(options.outputPath, { force: true });
  // lark-cli preserves an existing output file's mode. Pre-create it privately
  // so the QR is never briefly materialized as a default 0644 file.
  await writeFile(options.outputPath, '', { mode: 0o600 });
  await chmod(options.outputPath, 0o600);
  await captureQr(options.binary, ['auth', 'qrcode', options.url, '--output', outputName], outputDir);
  const info = await stat(options.outputPath);
  if (!info.isFile()) {
    throw new Error('lark-cli 未生成二维码 PNG');
  }
  await chmod(options.outputPath, 0o600);
  options.writeLine(`二维码 PNG（私有临时文件）：${options.outputPath}`);
}

async function assertQrRendererAvailable(binary: string): Promise<void> {
  await captureQr(binary, ['auth', 'qrcode', '--help'], process.cwd());
}

function captureQr(command: string, args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      callback();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 250);
    }, 10_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk.toString('utf8'));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk.toString('utf8'));
    });
    child.once('error', (error) => {
      finish(() =>
        reject(
          timedOut
            ? new Error('lark-cli 二维码生成超时')
            : new Error(`无法执行 lark-cli auth qrcode：${error.message}`),
        ),
      );
    });
    child.once('exit', (code) => {
      finish(() => {
        if (timedOut) {
          reject(new Error('lark-cli 二维码生成超时'));
          return;
        }
        if (code !== 0) {
          reject(new Error(`lark-cli auth qrcode 失败（exit ${code ?? 'signal'}）：${stderr.trim()}`));
          return;
        }
        resolve(stdout.trim());
      });
    });
  });
}

function appendBounded(current: string, next: string): string {
  const combined = `${current}${next}`;
  return combined.length > 64 * 1024 ? combined.slice(combined.length - 64 * 1024) : combined;
}
