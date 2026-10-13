import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RegisterAppOptions } from '@larksuite/channel';
import { afterEach, describe, expect, it } from 'vitest';
import { BRIDGE_APP_ADDONS, registerBridgeApp } from '../../src/registration/app-registration.js';

describe('app registration', () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('uses the official registration contract, preserves the URL and deletes the temporary QR', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-register-test-'));
    cleanup.push(root);
    const record = join(root, 'qrcode-record.json');
    const qr = join(root, 'registration.png');
    const fakeLarkCli = join(root, 'fake-lark-cli.mjs');
    await writeFile(
      fakeLarkCli,
      `#!/usr/bin/env node
import { statSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--help')) {
  process.exitCode = 0;
} else {
writeFileSync(${JSON.stringify(record)}, JSON.stringify(args));
const output = args[args.indexOf('--output') + 1];
const beforeMode = statSync(output).mode & 0o777;
writeFileSync(output, JSON.stringify({ beforeMode }));
}
`,
      { mode: 0o755 },
    );
    await chmod(fakeLarkCli, 0o755);
    const lines: string[] = [];
    let received: RegisterAppOptions | undefined;
    const result = await registerBridgeApp({
      tenant: 'feishu',
      existingAppId: 'cli_existing',
      qrFormat: 'png',
      qrOutputPath: qr,
      larkCliBinary: fakeLarkCli,
      writeLine: (line) => lines.push(line),
      register: async (options) => {
        received = options;
        options.onQRCodeReady({ url: 'https://opaque.example/path?a=1%2B2&b=x', expireIn: 600 });
        await waitForJson(qr);
        expect((await stat(qr)).mode & 0o777).toBe(0o600);
        expect(JSON.parse(await readFile(qr, 'utf8'))).toEqual({ beforeMode: 0o600 });
        return {
          client_id: 'cli_result',
          client_secret: '${REGISTERED_SECRET_NOT_REAL}',
          user_info: { open_id: 'ou_owner', tenant_brand: 'lark' },
        };
      },
    });
    expect(result).toEqual({
      appId: 'cli_result',
      appSecret: '${REGISTERED_SECRET_NOT_REAL}',
      tenant: 'lark',
      ownerOpenId: 'ou_owner',
    });
    expect(received?.appId).toBe('cli_existing');
    expect(received?.addons).toEqual(BRIDGE_APP_ADDONS);
    expect(received?.addons?.preset).toBe(false);
    expect(received?.addons?.scopes?.tenant).toEqual([
      'im:message.p2p_msg:readonly',
      'im:message.group_at_msg:readonly',
      'im:message.group_msg',
      'im:message:readonly',
      'im:message:send_as_bot',
      'im:resource',
      'im:chat:read',
      'cardkit:card:write',
      'docs:document.comment:read',
      'docs:document.comment:create',
      'wiki:node:read',
    ]);
    expect(lines).toContain('https://opaque.example/path?a=1%2B2&b=x');
    expect(lines.join('\n')).not.toContain('${REGISTERED_SECRET_NOT_REAL}');
    expect(JSON.parse(await readFile(record, 'utf8'))).toEqual([
      'auth',
      'qrcode',
      'https://opaque.example/path?a=1%2B2&b=x',
      '--output',
      'registration.png',
    ]);
    await expect(stat(qr)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('auto-selects the scanning user for personal allowlisting metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-register-ascii-'));
    cleanup.push(root);
    const fakeLarkCli = join(root, 'fake-lark-cli.mjs');
    await writeFile(
      fakeLarkCli,
      `#!/usr/bin/env node
if (process.argv.includes('--help')) {
  process.exitCode = 0;
} else if (!process.argv.includes('--ascii')) {
  process.exitCode = 2;
} else {
  process.stdout.write('ASCII-QR\\n');
}
`,
      { mode: 0o755 },
    );
    await chmod(fakeLarkCli, 0o755);
    const lines: string[] = [];
    const result = await registerBridgeApp({
      tenant: 'feishu',
      createOnly: true,
      qrOutputPath: join(root, 'unused.png'),
      larkCliBinary: fakeLarkCli,
      writeLine: (line) => lines.push(line),
      register: async (options) => {
        expect(options.createOnly).toBe(true);
        options.onQRCodeReady({ url: 'https://opaque.example/new', expireIn: 60 });
        return {
          client_id: 'cli_new',
          client_secret: '${REGISTERED_SECRET_NOT_REAL}',
          user_info: { open_id: 'ou_owner', tenant_brand: 'feishu' },
        };
      },
    });
    expect(result.ownerOpenId).toBe('ou_owner');
    expect(lines).toContain('ASCII-QR');
  });

  it('fails before app registration when the public QR renderer is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-register-no-renderer-'));
    cleanup.push(root);
    let called = false;
    await expect(
      registerBridgeApp({
        tenant: 'feishu',
        qrOutputPath: join(root, 'unused.png'),
        larkCliBinary: join(root, 'missing-lark-cli'),
        register: async () => {
          called = true;
          throw new Error('must not run');
        },
      }),
    ).rejects.toThrow(/无法执行 lark-cli auth qrcode/);
    expect(called).toBe(false);
  });

  it('rejects conflicting create/update registration modes before network use', async () => {
    await expect(
      registerBridgeApp({
        tenant: 'feishu',
        createOnly: true,
        existingAppId: 'cli_existing',
        qrOutputPath: '/tmp/unused.png',
        register: async () => {
          throw new Error('must not run');
        },
      }),
    ).rejects.toThrow(/不能同时使用/);
  });
});

async function waitForJson(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      JSON.parse(await readFile(path, 'utf8'));
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error(`timed out waiting for populated ${path}`);
}
