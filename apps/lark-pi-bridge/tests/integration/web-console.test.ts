import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAppPaths } from '../../src/config/app-paths.js';
import { createProfileConfig } from '../../src/config/profile-schema.js';
import { saveRootConfig } from '../../src/config/store.js';
import { startWebConsole, type WebConsoleHandle } from '../../src/web/server.js';

describe('loopback Web console', () => {
  const roots: string[] = [];
  const handles: WebConsoleHandle[] = [];
  afterEach(async () => {
    await Promise.all(handles.splice(0).map((handle) => handle.close()));
    await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('serves a no-secret CSP page and an allowlisted profile API', async () => {
    const { root, handle } = await fixture();
    roots.push(root);
    handles.push(handle);
    const page = await fetch(handle.url);
    expect(page.status).toBe(200);
    expect(page.headers.get('set-cookie')).toMatch(/^lark-pi-bridge-session=.*HttpOnly.*SameSite=Strict/);
    expect(page.headers.get('referrer-policy')).toBe('same-origin');
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await page.text();
    expect(html).not.toContain('private-app-secret');
    expect(html).not.toMatch(/(?:src|href)=["']https?:\/\//);
    const auth = browserAuth(handle, page.headers.get('set-cookie')!, html);
    const response = await fetch(`${handle.url}api/profiles`, { headers: auth });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('cli_web');
    expect(text).toContain('spawn-per-turn');
    expect(text).toContain('piConfigScope');
    expect(text).not.toContain('private-app-secret');
    expect(text).not.toContain('secretFile');
    expect(text).not.toContain('credentialSource');
    expect(text).not.toContain('"message"');
    expect(html).not.toMatch(/style=["']/);
    expect(html).not.toContain('unsafe-inline');
  });

  it('enforces origin, CSRF, JSON type, body limit and one-shot request IDs', async () => {
    const { root, handle } = await fixture();
    roots.push(root);
    handles.push(handle);
    const page = await fetch(handle.url);
    const html = await page.text();
    const auth = browserAuth(handle, page.headers.get('set-cookie')!, html);
    expect(
      (await fetch(`${handle.url}api/profiles`, { headers: { ...auth, referer: 'https://evil.example/' } })).status,
    ).toBe(403);
    expect((await fetch(`${handle.url}api/profiles`, { headers: { ...auth, 'x-csrf-token': 'wrong' } })).status).toBe(
      403,
    );

    const id = randomUUID();
    const headers = {
      ...auth,
      origin: handle.url.slice(0, -1),
      'content-type': 'application/json',
      'x-request-id': id,
    };
    const first = await fetch(`${handle.url}api/permissions?profile=test`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ defaultAccess: 'read-only', maxAccess: 'full' }),
    });
    expect(first.status).toBe(200);
    expect(
      (
        await fetch(`${handle.url}api/permissions?profile=test`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ defaultAccess: 'read-only', maxAccess: 'full' }),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await fetch(`${handle.url}api/permissions?profile=test`, {
          method: 'POST',
          headers: { ...headers, 'x-request-id': randomUUID(), 'content-type': 'text/plain' },
          body: '{}',
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await fetch(`${handle.url}api/permissions?profile=test`, {
          method: 'POST',
          headers: { ...headers, 'x-request-id': randomUUID() },
          body: JSON.stringify({ padding: 'x'.repeat(70_000) }),
        })
      ).status,
    ).toBe(413);
  });

  it('updates non-secret workspaces but rejects Web credential values', async () => {
    const { root, handle } = await fixture();
    roots.push(root);
    handles.push(handle);
    const project = join(root, 'project');
    await mkdir(project);
    const page = await fetch(handle.url);
    const auth = browserAuth(handle, page.headers.get('set-cookie')!, await page.text());
    const post = (path: string, body: object) =>
      fetch(`${handle.url}${path}?profile=test`, {
        method: 'POST',
        headers: {
          ...auth,
          origin: handle.url.slice(0, -1),
          'content-type': 'application/json',
          'x-request-id': randomUUID(),
        },
        body: JSON.stringify(body),
      });
    expect((await post('api/workspaces/set', { alias: 'bridge', path: project })).status).toBe(200);
    expect((await post('api/workspaces/default', { alias: 'bridge' })).status).toBe(200);
    expect((await post('api/workspaces/remove', { alias: 'bridge' })).status).toBe(400);
    expect((await post('api/transport', { transport: 'rpc' })).status).toBe(200);
    const mentionOptional = await post('api/mention-optional', { chatId: 'oc_web', enabled: true });
    expect(mentionOptional.status).toBe(200);
    expect(await mentionOptional.text()).toContain('"refreshRequired":true');
    expect((await post('api/mention-optional', { chatId: 'oc_missing', enabled: true })).status).toBe(400);
    expect((await post('api/pi-config-scope', { scope: 'user' })).status).toBe(200);
    const userModelRejected = await post('api/model', {
      providerId: 'local',
      modelId: 'blocked',
      baseUrl: 'http://127.0.0.1:10010/v1',
      api: 'openai-responses',
    });
    expect(userModelRejected.status).toBe(400);
    expect((await post('api/pi-config-scope', { scope: 'profile' })).status).toBe(200);
    const noRuntime = await post('api/runtime/refresh', {});
    expect(noRuntime.status).toBe(409);
    expect(await noRuntime.text()).toContain('runtime refresh unavailable or busy');
    const profile = await fetch(`${handle.url}api/profile?profile=test`, { headers: auth });
    const profileText = await profile.text();
    expect(profileText).toContain('bridge');
    expect(profileText).toContain('"defaultAlias":"bridge"');
    expect(profileText).toContain('"unavailable":[]');
    expect(profileText).toContain('"transport":"rpc"');
    expect(profileText).toContain('"mentionOptionalChats":["oc_web"]');
    const savedModel = await post('api/model', {
      providerId: 'local',
      modelId: 'model',
      baseUrl: 'http://127.0.0.1:10010/v1',
      api: 'openai-responses',
      input: 'text,image',
    });
    expect(savedModel.status).toBe(200);
    expect(await savedModel.text()).toContain('"input":["text","image"]');
    const rejectedInput = await post('api/model', {
      providerId: 'local',
      modelId: 'model',
      baseUrl: 'http://127.0.0.1:10010/v1',
      api: 'openai-responses',
      input: 'image',
    });
    expect(rejectedInput.status).toBe(400);
    const rejected = await post('api/model', {
      providerId: 'local',
      modelId: 'model',
      baseUrl: 'http://127.0.0.1:10010/v1',
      api: 'openai-responses',
      apiKey: 'must-not-be-accepted',
    });
    expect(rejected.status).toBe(400);
    const rejectedText = await rejected.text();
    expect(rejectedText).not.toContain('must-not-be-accepted');
    expect(rejectedText).toContain('unsupported request field');
    const permissionRejected = await post('api/permissions', {
      defaultAccess: 'read-only',
      maxAccess: 'read-only',
      secret: 'must-not-be-accepted',
    });
    expect(permissionRejected.status).toBe(400);
    expect(await permissionRejected.text()).not.toContain('must-not-be-accepted');
  });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'lark-pi-web-'));
  const paths = resolveAppPaths({ rootDir: root, profile: 'test', appLockRoot: join(root, 'app-locks') });
  await saveRootConfig(paths.configFile, {
    schemaVersion: 3,
    activeProfile: 'test',
    profiles: {
      test: createProfileConfig({
        app: { id: 'cli_web', secret: 'private-app-secret', tenant: 'feishu' },
        workspace: root,
        access: { allowedChats: ['oc_web'] },
        preferences: { piConfigScope: 'profile' },
      }),
    },
  });
  const handle = await startWebConsole({ rootDir: root, appLockRoot: join(root, 'app-locks') });
  return { root, handle };
}

function browserAuth(handle: WebConsoleHandle, setCookie: string, html: string): Record<string, string> {
  const csrf = /<meta name="csrf-token" content="([^"]+)">/.exec(html)?.[1];
  if (!csrf) {
    throw new Error('missing csrf token');
  }
  return {
    cookie: setCookie.split(';', 1)[0]!,
    'x-csrf-token': csrf,
    'sec-fetch-site': 'same-origin',
    referer: handle.url,
  };
}
