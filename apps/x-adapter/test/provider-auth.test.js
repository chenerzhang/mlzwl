import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createCipheriv, createHash, createPublicKey, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  readTraeCredential,
  sessionFromCredential,
  traeCredentialPath,
  writeTraeCredential,
} from '../dist/providers/trae/auth/credential.js';
import { importTraeOfficialCredential } from '../dist/providers/trae/auth/native-import.js';
import { __testHooks, refreshTraeCredential, runTraeLogin } from '../dist/providers/trae/auth/oauth.js';
import {
  assertTraeBaseUrl,
  inferTraeRegion,
  installedTraeProduct,
  traeProductIdentity,
  traeRealmConfig,
} from '../dist/providers/trae/config/realm.js';

function credential(realm = 'global', overrides = {}) {
  const region = realm === 'global' ? 'sg' : 'cn';
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const base = {
    version: 1,
    realm,
    region,
    account: { uid: `${realm}-user`, nickname: `${realm} user` },
    auth: {
      accessToken: `${realm}-access-token`,
      refreshToken: `${realm}-refresh-token`,
      expiresAt: Date.now() + 60_000,
      clientId: 'test-client',
    },
    product: {
      appVersion: 'test-app',
      pluginVersion: 'test-plugin',
      versionCode: 'test-code',
      quality: 'stable',
    },
    device: {
      machineId: `${realm}-machine`,
      deviceId: `${realm}-device`,
      publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    },
    updatedAt: new Date().toISOString(),
  };
  return {
    ...base,
    ...overrides,
    account: { ...base.account, ...overrides.account },
    auth: { ...base.auth, ...overrides.auth },
    product: { ...base.product, ...overrides.product },
    device: { ...base.device, ...overrides.device },
  };
}

async function withTraeData(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'x-adapter-trae-auth-'));
  const previous = process.env.X_ADAPTER_TRAE_DATA_DIR;
  process.env.X_ADAPTER_TRAE_DATA_DIR = directory;
  __testHooks.resetRefreshFlights();
  try {
    return await run(directory);
  } finally {
    __testHooks.resetRefreshFlights();
    if (previous === undefined) {
      delete process.env.X_ADAPTER_TRAE_DATA_DIR;
    } else {
      process.env.X_ADAPTER_TRAE_DATA_DIR = previous;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

const storageSalt = Buffer.from(
  '4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58',
  'hex',
);

function encryptOfficialStorageValue(value) {
  const random = randomBytes(32);
  const first = createHash('sha512').update(random).digest();
  const material = createHash('sha512')
    .update(Buffer.concat([first, storageSalt]))
    .digest();
  const payload = Buffer.from(JSON.stringify(value));
  const authenticated = Buffer.concat([createHash('sha512').update(payload).digest(), payload]);
  const cipher = createCipheriv('aes-128-cbc', material.subarray(0, 16), material.subarray(16, 32));
  return Buffer.concat([
    Buffer.from([0x74, 0x63, 0x05, 0x10, 0x00, 0x00]),
    random,
    cipher.update(authenticated),
    cipher.final(),
  ]).toString('base64');
}

function writeOfficialStorage(directory, realm, overrides = {}) {
  const source = path.join(directory, `official-${realm}.json`);
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const deviceId = `${realm}-native-device`;
  const auth = {
    token: `${realm}-native-access-token`,
    refreshToken: `${realm}-native-refresh-token`,
    expiredAt: new Date(Date.now() + 120_000).toISOString(),
    refreshExpiredAt: new Date(Date.now() + 86_400_000).toISOString(),
    userId: `${realm}-native-user`,
    ...(realm === 'global' ? { host: 'https://growsg-normal.trae.ai' } : {}),
    userRegion: realm === 'global' ? { region: 'SG', _aiRegion: 'SG' } : { _aiRegion: 'CN' },
    account: { username: `${realm} native`, organization: `${realm}-organization` },
    ...overrides.auth,
  };
  const pair = {
    privateKeyPEM: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPEM: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    ...overrides.pair,
  };
  fs.writeFileSync(
    source,
    JSON.stringify({
      'telemetry.machineId': `${realm}-native-machine`,
      'telemetry.devDeviceId': `${realm}-telemetry-device`,
      'iCubeAuthInfo://icube.cloudide': encryptOfficialStorageValue(auth),
      [`iCubeAuthInfo://icube-dc:${deviceId}`]: encryptOfficialStorageValue(pair),
      ...overrides.root,
    }),
    { mode: 0o600 },
  );
  return { source, auth, pair, deviceId };
}

async function withEnv(values, run) {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('Trae product identity reads only approved public manifest fields and explicit realm config wins', async () => {
  await withTraeData((directory) => {
    const productPath = path.join(directory, 'product.json');
    fs.writeFileSync(
      productPath,
      JSON.stringify({
        appVersion: 'manifest-app',
        tronBuildVersion: 'manifest-plugin',
        traeVersionCode: 'manifest-version-code',
        quality: 'insider',
        iCubeApp: { authConfig: { TRAE: { insider: 'manifest-client', stable: 'stable-client' } } },
        accessToken: 'must-not-be-read',
        storage: { cookie: 'must-not-be-read-either' },
      }),
    );
    return withEnv(
      {
        X_ADAPTER_TRAE_GLOBAL_PRODUCT_PATH: productPath,
        X_ADAPTER_TRAE_GLOBAL_APP_VERSION: undefined,
        X_ADAPTER_TRAE_GLOBAL_PLUGIN_VERSION: undefined,
        X_ADAPTER_TRAE_GLOBAL_CLIENT_ID: undefined,
      },
      () => {
        assert.deepEqual(installedTraeProduct('global'), {
          appVersion: 'manifest-app',
          tronBuildVersion: 'manifest-plugin',
          traeVersionCode: 'manifest-version-code',
          quality: 'insider',
          iCubeApp: { authConfig: { TRAE: { insider: 'manifest-client', stable: 'stable-client' } } },
        });
        assert.equal(traeProductIdentity('global').clientId, 'manifest-client');
        assert.equal(traeProductIdentity('global').versionCode, 'manifest-version-code');
        return withEnv(
          {
            X_ADAPTER_TRAE_GLOBAL_APP_VERSION: 'explicit-app',
            X_ADAPTER_TRAE_GLOBAL_PLUGIN_VERSION: 'explicit-plugin',
            X_ADAPTER_TRAE_GLOBAL_CLIENT_ID: 'explicit-client',
          },
          () => {
            const identity = traeProductIdentity('global');
            assert.equal(identity.appVersion, 'explicit-app');
            assert.equal(identity.pluginVersion, 'explicit-plugin');
            assert.equal(identity.clientId, 'explicit-client');
          },
        );
      },
    );
  });
});

test('Trae realm configuration rejects unapproved credential destinations and derives fixed regions', () => {
  assert.equal(traeRealmConfig('global', 'sg').dataBaseUrl, 'https://coresg-normal.trae.ai');
  assert.equal(traeRealmConfig('global', 'us').dataBaseUrl, 'https://coreva-normal.trae.ai');
  assert.equal(traeRealmConfig('cn').dataBaseUrl, 'https://trae-api-cn.mchost.guru');
  assert.equal(traeRealmConfig('global', 'sg').authBaseUrl, 'https://growsg-normal.trae.ai');
  assert.equal(traeRealmConfig('global', 'us').authBaseUrl, 'https://growsg-normal.trae.ai');
  assert.equal(
    assertTraeBaseUrl('global', 'login', 'https://api-sg-central.trae.ai'),
    'https://api-sg-central.trae.ai',
  );
  assert.equal(inferTraeRegion('global', 'usttp'), 'us');
  assert.equal(inferTraeRegion('global', 'coresg-normal.trae.ai'), 'sg');
  assert.equal(inferTraeRegion('cn', 'us'), 'cn');
  assert.throws(() => assertTraeBaseUrl('global', 'auth', 'https://evil.example'), { code: 'invalid_trae_host' });
  assert.throws(() => assertTraeBaseUrl('global', 'data', 'http://coresg-normal.trae.ai'), {
    code: 'invalid_trae_host',
  });
  assert.throws(() => assertTraeBaseUrl('cn', 'data', 'https://coresg-normal.trae.ai'), {
    code: 'invalid_trae_host',
  });
});

test('Trae realm environment overrides cannot escape approved hosts, ports, or paths', () => {
  const variables = {
    X_ADAPTER_TRAE_GLOBAL_GUIDANCE_URL: 'https://api.trae.ai/attacker-controlled',
    X_ADAPTER_TRAE_GLOBAL_AUTH_BASE_URL: 'https://growsg-normal.trae.ai/attacker-controlled',
    X_ADAPTER_TRAE_GLOBAL_DATA_BASE_URL: 'https://coresg-normal.trae.ai:8443',
  };
  for (const [name, value] of Object.entries(variables)) {
    const previous = process.env[name];
    process.env[name] = value;
    try {
      assert.throws(() => traeRealmConfig('global'), { code: 'invalid_trae_host' });
    } finally {
      if (previous === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previous;
      }
    }
  }
});

test('Trae Global and CN credentials are isolated and persisted owner-only', async () => {
  await withTraeData((directory) => {
    writeTraeCredential(credential('global'));
    writeTraeCredential(credential('cn'));
    assert.equal(readTraeCredential('global').account.uid, 'global-user');
    assert.equal(readTraeCredential('cn').account.uid, 'cn-user');
    assert.notEqual(traeCredentialPath('global'), traeCredentialPath('cn'));
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(directory, 'global')).mode & 0o777, 0o700);
      assert.equal(fs.statSync(traeCredentialPath('global')).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.join(directory, 'cn')).mode & 0o777, 0o700);
      assert.equal(fs.statSync(traeCredentialPath('cn')).mode & 0o777, 0o600);
    }
    assert.deepEqual(
      fs.readdirSync(path.join(directory, 'global')).filter((name) => name.endsWith('.tmp')),
      [],
    );
  });
});

test('Trae imports official client credentials and the matching registered device identity per realm', async () => {
  await withTraeData((directory) => {
    const global = writeOfficialStorage(directory, 'global');
    const cn = writeOfficialStorage(directory, 'cn');
    const importedGlobal = importTraeOfficialCredential('global', { storagePath: global.source });
    const importedCn = importTraeOfficialCredential('cn', { storagePath: cn.source });
    assert.equal(importedGlobal.credential.source, 'official-client');
    assert.equal(importedGlobal.region, 'sg');
    assert.equal(importedGlobal.credential.auth.accessToken, global.auth.token);
    assert.equal(importedGlobal.credential.auth.refreshToken, global.auth.refreshToken);
    assert.equal(importedGlobal.credential.auth.authBaseUrl, 'https://growsg-normal.trae.ai');
    assert.equal(importedGlobal.credential.device.deviceId, global.deviceId);
    assert.equal(importedGlobal.credential.device.machineId, 'global-native-machine');
    assert.equal(importedGlobal.credential.device.privateKey.trim(), global.pair.privateKeyPEM.trim());
    assert.equal(importedCn.credential.source, 'official-client');
    assert.equal(importedCn.region, 'cn');
    assert.equal(importedCn.credential.auth.accessToken, cn.auth.token);
    assert.equal(importedCn.credential.auth.authBaseUrl, 'https://api.trae.cn');
    assert.equal(readTraeCredential('global').account.uid, 'global-native-user');
    assert.equal(readTraeCredential('cn').account.uid, 'cn-native-user');
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(traeCredentialPath('global')).mode & 0o777, 0o600);
      assert.equal(fs.statSync(traeCredentialPath('cn')).mode & 0o777, 0o600);
    }
  });
});

test('Trae official import refuses realm mismatch, mismatched device keys, and implicit replacement', async () => {
  await withTraeData((directory) => {
    const global = writeOfficialStorage(directory, 'global');
    assert.throws(() => importTraeOfficialCredential('cn', { storagePath: global.source }), {
      code: 'trae_official_realm_mismatch',
    });
    importTraeOfficialCredential('global', { storagePath: global.source });
    assert.throws(() => importTraeOfficialCredential('global', { storagePath: global.source }), {
      code: 'trae_credentials_exist',
    });
    assert.throws(() => importTraeOfficialCredential('global', { storagePath: global.source, force: true }), {
      code: 'trae_official_credentials_unchanged',
    });
    const replacement = writeOfficialStorage(directory, 'global', {
      auth: { userId: 'replacement-user', refreshToken: 'replacement-refresh-token' },
    });
    importTraeOfficialCredential('global', { storagePath: replacement.source, force: true });
    assert.equal(readTraeCredential('global').account.uid, 'replacement-user');

    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const broken = writeOfficialStorage(directory, 'cn', {
      pair: { publicKeyPEM: other.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
    });
    assert.throws(() => importTraeOfficialCredential('cn', { storagePath: broken.source }), {
      code: 'invalid_trae_official_device',
    });
    assert.equal(readTraeCredential('cn'), null);
  });
});

test('Trae official force import can recover a malformed local credential without trusting it', async () => {
  await withTraeData((directory) => {
    const official = writeOfficialStorage(directory, 'global');
    fs.mkdirSync(path.dirname(traeCredentialPath('global')), { recursive: true, mode: 0o700 });
    fs.writeFileSync(traeCredentialPath('global'), '{not-json', { mode: 0o600 });
    assert.throws(() => importTraeOfficialCredential('global', { storagePath: official.source }), {
      code: 'invalid_trae_credentials',
    });
    importTraeOfficialCredential('global', { storagePath: official.source, force: true });
    assert.equal(readTraeCredential('global').account.uid, 'global-native-user');
  });
});

test('Trae credential reads distinguish absence from malformed credential data', async () => {
  await withTraeData(async () => {
    assert.equal(readTraeCredential('global'), null);
    fs.mkdirSync(path.dirname(traeCredentialPath('global')), { recursive: true, mode: 0o700 });
    fs.writeFileSync(traeCredentialPath('global'), '{not-json', { mode: 0o600 });
    assert.throws(() => readTraeCredential('global'), { code: 'invalid_trae_credentials' });
  });
});

test('Trae credential reads fail closed when its directory or file is broadly readable', async () => {
  if (process.platform === 'win32') {
    return;
  }
  await withTraeData(async () => {
    writeTraeCredential(credential('global'));
    fs.chmodSync(traeCredentialPath('global'), 0o644);
    assert.throws(() => readTraeCredential('global'), { code: 'insecure_trae_credentials' });
    fs.chmodSync(traeCredentialPath('global'), 0o600);
    fs.chmodSync(path.dirname(traeCredentialPath('global')), 0o755);
    assert.throws(() => readTraeCredential('global'), { code: 'insecure_trae_credentials' });
  });
});

test('Trae imported official identity signs DeviceProof with the matching device key', async () => {
  await withTraeData((directory) => {
    const official = writeOfficialStorage(directory, 'global');
    importTraeOfficialCredential('global', { storagePath: official.source });
    return refreshTraeCredential('global', async (input, init) => {
      assert.equal(String(input), 'https://growsg-normal.trae.ai/trae/api/v3/oauth/ExchangeToken');
      const body = JSON.parse(init.body);
      assert.equal(body.RefreshToken, official.auth.refreshToken);
      assert.equal(body.DeviceInfo.DeviceID, official.deviceId);
      assert.equal(body.DeviceInfo.MachineID, 'global-native-machine');
      assert.equal(body.DeviceInfo.DevicePublicKey.trim(), official.pair.publicKeyPEM.trim());
      const canonical = [
        'POST',
        '/trae/api/v3/oauth/ExchangeToken',
        body.ClientID,
        body.RefreshToken,
        String(body.DeviceProof.Timestamp),
        body.DeviceProof.Nonce,
      ].join('\n');
      assert.equal(
        verify(
          'sha256',
          Buffer.from(canonical),
          createPublicKey(official.pair.publicKeyPEM),
          Buffer.from(body.DeviceProof.Signature, 'base64'),
        ),
        true,
      );
      return jsonResponse({
        Result: {
          Token: 'imported-rotated-access-token',
          RefreshToken: 'imported-rotated-refresh-token',
          TokenExpireAt: Math.floor((Date.now() + 120_000) / 1000),
        },
      });
    });
  });
});

test('Trae refresh reuses the allowlisted auth host selected during login', async () => {
  await withTraeData(async () => {
    writeTraeCredential(
      credential('global', { auth: { authBaseUrl: 'https://grow-normal.traeapi.us' }, region: 'us' }),
    );
    let endpoint;
    await refreshTraeCredential('global', async (input) => {
      endpoint = String(input);
      return jsonResponse({
        Result: {
          Token: 'us-rotated-access-token',
          RefreshToken: 'us-rotated-refresh-token',
          TokenExpireAt: Math.floor((Date.now() + 120_000) / 1000),
        },
      });
    });
    assert.equal(endpoint, 'https://grow-normal.traeapi.us/trae/api/v3/oauth/ExchangeToken');
    assert.equal(readTraeCredential('global').auth.authBaseUrl, 'https://grow-normal.traeapi.us');
  });
});

test('Trae refresh rotates both tokens and single-flights concurrent callers per realm', async () => {
  await withTraeData(async () => {
    writeTraeCredential(credential('global'));
    let calls = 0;
    const fetchImpl = async (input, init) => {
      calls += 1;
      assert.equal(String(input), 'https://growsg-normal.trae.ai/trae/api/v3/oauth/ExchangeToken');
      const body = JSON.parse(init.body);
      assert.equal(body.RefreshToken, 'global-refresh-token');
      assert.equal(init.headers['x-cloudide-token'], '');
      assert.equal(body.DeviceInfo.DeviceID, 'global-device');
      assert.equal(body.DeviceProof.Nonce.length, 32);
      const canonical = [
        'POST',
        '/trae/api/v3/oauth/ExchangeToken',
        body.ClientID,
        body.RefreshToken,
        String(body.DeviceProof.Timestamp),
        body.DeviceProof.Nonce,
      ].join('\n');
      assert.equal(
        verify(
          'sha256',
          Buffer.from(canonical),
          createPublicKey(readTraeCredential('global').device.publicKey),
          Buffer.from(body.DeviceProof.Signature, 'base64'),
        ),
        true,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      return jsonResponse({
        Result: {
          Token: 'rotated-access-token',
          RefreshToken: 'rotated-refresh-token',
          TokenExpireAt: Math.floor((Date.now() + 120_000) / 1000),
          UserInfo: { UserID: 'global-user' },
        },
      });
    };
    const [left, right] = await Promise.all([
      refreshTraeCredential('global', fetchImpl),
      refreshTraeCredential('global', fetchImpl),
    ]);
    assert.equal(calls, 1);
    assert.equal(left.auth.accessToken, 'rotated-access-token');
    assert.equal(right.auth.refreshToken, 'rotated-refresh-token');
    assert.equal(readTraeCredential('global').auth.refreshToken, 'rotated-refresh-token');
  });
});

test('Trae refresh failure leaves the complete previous credential untouched', async () => {
  await withTraeData(async () => {
    const original = credential('cn');
    writeTraeCredential(original);
    await assert.rejects(() => refreshTraeCredential('cn', async () => jsonResponse({ message: 'failure' }, 500)), {
      code: 'trae_refresh_failed',
    });
    assert.equal(readTraeCredential('cn').auth.accessToken, original.auth.accessToken);
    assert.equal(readTraeCredential('cn').auth.refreshToken, original.auth.refreshToken);
  });
});

test('Trae refresh authentication rejection requires realm-specific login without exposing a token', async () => {
  await withTraeData(async () => {
    const original = credential('cn');
    writeTraeCredential(original);
    await assert.rejects(
      () => refreshTraeCredential('cn', async () => jsonResponse({ message: 'expired' }, 403)),
      (error) => {
        assert.equal(error.code, 'expired_trae_credentials');
        assert.match(error.message, /Trae cn sign-in has expired; sign in again/);
        assert.doesNotMatch(error.message, /cn-access-token|cn-refresh-token/);
        return true;
      },
    );
    const saved = readTraeCredential('cn');
    assert.equal(saved.auth.accessToken, original.auth.accessToken);
    assert.equal(saved.auth.refreshToken, original.auth.refreshToken);
    assert.equal(saved.device.privateKey.trim(), original.device.privateKey.trim());
    assert.equal(saved.updatedAt, original.updatedAt);
  });
});

test('Trae OAuth uses the desktop callback shape, verifies trace, exchanges the code, and saves no callback query', async () => {
  await withTraeData(async () => {
    let authorizationUrl;
    let exchangeUrl;
    let exchangeBody;
    let exchangeHeaders;
    const fetchImpl = async (input, init) => {
      const url = String(input);
      if (url.includes('GetLoginGuidance')) {
        return jsonResponse({ Result: { LoginHost: 'https://www.trae.ai' } });
      }
      if (url.endsWith('/trae/api/v3/oauth/ExchangeToken')) {
        exchangeUrl = url;
        exchangeBody = JSON.parse(init.body);
        exchangeHeaders = init.headers;
        return jsonResponse({
          Result: {
            Token: 'oauth-access-token',
            RefreshToken: 'oauth-refresh-token',
            TokenExpireAt: Math.floor((Date.now() + 120_000) / 1000),
            UserInfo: { UserID: 'global-oauth-user', ScreenName: 'Global Test' },
          },
        });
      }
      throw new Error(`unexpected mock request: ${url}`);
    };
    const login = runTraeLogin('global', {
      fetchImpl,
      openBrowser: false,
      timeoutMs: 1000,
      onEvent(event) {
        if (event.type === 'auth.login.url') {
          authorizationUrl = event.url;
        }
      },
    });
    while (!authorizationUrl) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const authorization = new URL(authorizationUrl);
    assert.equal(authorization.origin, 'https://www.trae.ai');
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(authorization.searchParams.get('code_challenge'));
    assert.ok(authorization.searchParams.get('state'));
    assert.equal(authorization.searchParams.get('channel_name'), 'common');
    assert.equal(authorization.searchParams.get('device_id'), '0');
    assert.equal(authorization.searchParams.get('x_device_id'), '0');
    assert.equal(authorization.searchParams.has('hide_saas_login'), false);
    const callback = new URL(authorization.searchParams.get('auth_callback_url'));
    assert.equal(callback.hostname, '127.0.0.1');
    assert.equal(callback.pathname, '/authorize');
    assert.equal(callback.search, '');
    callback.searchParams.set(
      'authCodeInfo',
      JSON.stringify({ AuthCode: 'offline-auth-code', ExpireAt: Date.now() + 60_000, ExpireDuration: 60_000 }),
    );
    callback.searchParams.set('loginTraceID', authorization.searchParams.get('login_trace_id'));
    callback.searchParams.set('host', 'https://api-sg-central.trae.ai');
    callback.searchParams.set('userRegion', 'sg');
    callback.searchParams.set(
      'userInfo',
      JSON.stringify({ UserID: 'global-oauth-user', ScreenName: 'Global Test', TenantID: 'personal' }),
    );
    const response = await fetch(callback);
    assert.equal(response.status, 200);
    const session = await login;
    assert.equal(session.realm, 'global');
    assert.equal(session.uid, 'global-oauth-user');
    assert.equal(exchangeUrl, 'https://growsg-normal.trae.ai/trae/api/v3/oauth/ExchangeToken');
    assert.equal(exchangeHeaders['x-cloudide-token'], '');
    assert.equal(exchangeBody.AuthCode, 'offline-auth-code');
    assert.ok(exchangeBody.CodeVerifier);
    assert.equal(exchangeBody.DeviceInfo.DeviceID, '0');
    assert.equal(exchangeBody.DeviceInfo.DeviceCPU, '');
    assert.match(exchangeBody.DeviceInfo.DevicePublicKey, /BEGIN PUBLIC KEY/);
    const saved = fs.readFileSync(traeCredentialPath('global'), 'utf8');
    assert.doesNotMatch(saved, /offline-auth-code|login_trace_id|auth_callback_url/);
    assert.match(saved, /BEGIN PRIVATE KEY/);
  });
});

test('Trae OAuth maps upstream device-cap rejection without persisting callback authorization', async () => {
  await withTraeData(async () => {
    let authorizationUrl;
    const login = runTraeLogin('global', {
      openBrowser: false,
      timeoutMs: 1000,
      fetchImpl: async (input, init) => {
        if (String(input).includes('GetLoginGuidance')) {
          return jsonResponse({ Result: { LoginHost: 'https://www.trae.ai' } });
        }
        assert.equal(String(input), 'https://growsg-normal.trae.ai/trae/api/v3/oauth/ExchangeToken');
        assert.equal(init.headers['x-cloudide-token'], '');
        return jsonResponse(
          { ResponseMetadata: { Error: { Code: '20401', Message: 'sensitive upstream detail' } } },
          403,
        );
      },
      onEvent(event) {
        if (event.type === 'auth.login.url') {
          authorizationUrl = event.url;
        }
      },
    });
    while (!authorizationUrl) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const authorization = new URL(authorizationUrl);
    const callback = new URL(authorization.searchParams.get('auth_callback_url'));
    callback.searchParams.set('authCode', 'device-limit-code');
    callback.searchParams.set('loginTraceID', authorization.searchParams.get('login_trace_id'));
    callback.searchParams.set('host', 'https://api-sg-central.trae.ai');
    callback.searchParams.set('userRegion', 'sg');
    const rejected = assert.rejects(login, (error) => {
      assert.equal(error.code, 'trae_device_limit_reached');
      assert.match(error.message, /device limit reached/i);
      assert.doesNotMatch(error.message, /sensitive upstream detail|device-limit-code/);
      return true;
    });
    assert.equal((await fetch(callback)).status, 200);
    await rejected;
    assert.equal(readTraeCredential('global'), null);
  });
});

test('Trae OAuth ignores mismatched optional state and required trace callbacks before one exact consumption', async () => {
  await withTraeData(async () => {
    let authorizationUrl;
    let exchanges = 0;
    const fetchImpl = async (input, init) => {
      if (String(input).includes('GetLoginGuidance')) {
        return jsonResponse({ Result: { LoginHost: 'https://www.trae.ai' } });
      }
      exchanges += 1;
      assert.equal(JSON.parse(init.body).AuthCode, 'matching-code');
      return jsonResponse({
        Result: {
          Token: 'matching-access',
          RefreshToken: 'matching-refresh',
          TokenExpireAt: Math.floor((Date.now() + 120_000) / 1000),
          UserInfo: { UserID: 'matching-user' },
        },
      });
    };
    const login = runTraeLogin('global', {
      fetchImpl,
      openBrowser: false,
      timeoutMs: 1000,
      onEvent(event) {
        if (event.type === 'auth.login.url') {
          authorizationUrl = event.url;
        }
      },
    });
    while (!authorizationUrl) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const authorization = new URL(authorizationUrl);
    const expectedState = authorization.searchParams.get('state');
    const expectedTrace = authorization.searchParams.get('login_trace_id');
    const original = new URL(authorization.searchParams.get('auth_callback_url'));
    const wrongState = new URL(original);
    wrongState.searchParams.set('state', 'wrong-state');
    wrongState.searchParams.set('loginTraceID', expectedTrace);
    wrongState.searchParams.set('authCode', 'must-not-exchange');
    assert.equal((await fetch(wrongState)).status, 400);
    const wrongTrace = new URL(original);
    wrongTrace.searchParams.set('loginTraceID', 'wrong-trace');
    wrongTrace.searchParams.set('authCode', 'must-not-exchange');
    assert.equal((await fetch(wrongTrace)).status, 400);
    const invalidAuthorization = new URL(original);
    invalidAuthorization.searchParams.set('loginTraceID', expectedTrace);
    assert.equal((await fetch(invalidAuthorization)).status, 400);
    const unapprovedHost = new URL(original);
    unapprovedHost.searchParams.set('loginTraceID', expectedTrace);
    unapprovedHost.searchParams.set('authCode', 'must-not-exchange');
    unapprovedHost.searchParams.set('host', 'https://evil.example');
    assert.equal((await fetch(unapprovedHost)).status, 400);
    const matching = new URL(original);
    matching.searchParams.set('state', expectedState);
    matching.searchParams.set('loginTraceID', expectedTrace);
    matching.searchParams.set('host', 'https://api-sg-central.trae.ai');
    matching.searchParams.set('userRegion', 'sg');
    matching.searchParams.set('authCode', 'matching-code');
    assert.equal((await fetch(matching)).status, 200);
    const second = await fetch(matching).catch(() => null);
    assert.ok(second === null || second.status === 409);
    assert.equal((await login).uid, 'matching-user');
    assert.equal(exchanges, 1);
  });
});

test('Trae OAuth timeout closes the callback listener without writing credentials', async () => {
  await withTraeData(async () => {
    let callbackUrl;
    await assert.rejects(
      () =>
        runTraeLogin('cn', {
          openBrowser: false,
          timeoutMs: 20,
          fetchImpl: async () => jsonResponse({ Result: { LoginHost: 'https://www.trae.cn' } }),
          onEvent(event) {
            if (event.type === 'auth.login.url') {
              callbackUrl = new URL(new URL(event.url).searchParams.get('auth_callback_url'));
            }
          },
        }),
      { code: 'trae_oauth_timeout' },
    );
    assert.equal(readTraeCredential('cn'), null);
    await assert.rejects(() => fetch(callbackUrl));
  });
});

test('Trae session exposes only the credential realm data host and never token-derived routing', () => {
  const global = sessionFromCredential(credential('global'));
  const cn = sessionFromCredential(credential('cn'));
  assert.equal(global.dataBaseUrl, 'https://coresg-normal.trae.ai');
  assert.equal(cn.dataBaseUrl, 'https://trae-api-cn.mchost.guru');
  assert.equal(global.realm, 'global');
  assert.equal(cn.realm, 'cn');
});
