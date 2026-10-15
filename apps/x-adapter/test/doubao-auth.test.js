import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  credentialSummary,
  readDoubaoCredential,
  requireDoubaoCredential,
  saveDoubaoCredential,
} from '../dist/providers/doubao/auth/doubao-cookie.js';
import {
  buildDoubaoCookieHeader,
  doubaoDomainCookies,
  isDoubaoPageLoggedIn,
  validateDoubaoCredential,
} from '../dist/providers/doubao/auth/login.js';

function withEnv(values, action) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return action();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('Doubao browser login requires an explicit signed-in page state before accepting cookies', () => {
  assert.equal(isDoubaoPageLoggedIn({ loggedIn: false, userId: '' }), false);
  assert.equal(isDoubaoPageLoggedIn({ loggedIn: true, userId: '' }), false);
  assert.equal(isDoubaoPageLoggedIn({ loggedIn: true, userId: 123 }), false);
  assert.equal(isDoubaoPageLoggedIn({ loggedIn: true, userId: '3911376934803529' }), true);
});

test('Doubao login keeps target-applicable cookies and excludes sibling/lookalike domains', () => {
  const cookies = [
    { name: 'sessionid', value: 'one', domain: '.doubao.com' },
    { name: 'ttwid', value: 'two', domain: 'www.doubao.com' },
    { name: 'risk', value: 'three', domain: 'sub.doubao.com' },
    { name: 'host-only', value: 'host', domain: 'www.doubao.com' },
    { name: 'evil', value: 'four', domain: 'notdoubao.com' },
    { name: 'other', value: 'five', domain: '.example.com' },
    { name: 'wrong-path', value: 'six', domain: '.doubao.com', path: '/alice/only' },
    { name: 'duplicate', value: 'first', domain: '.doubao.com', path: '/' },
    { name: 'duplicate', value: 'second', domain: 'www.doubao.com', path: '/' },
  ];
  assert.deepEqual(doubaoDomainCookies(cookies), [
    { name: 'sessionid', value: 'one' },
    { name: 'ttwid', value: 'two' },
    { name: 'host-only', value: 'host' },
    { name: 'duplicate', value: 'first' },
  ]);
  assert.equal(buildDoubaoCookieHeader(cookies), 'sessionid=one; ttwid=two; host-only=host; duplicate=first');
});

test('Doubao login validates auth independently from model discovery', async () => {
  let calls = 0;
  const valid = await validateDoubaoCredential(
    { cookie: 'sessionid=one', commonQuery: {}, userAgent: 'test', source: 'env', summary: {} },
    async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          status_code: 0,
          downlink_body: {
            pull_recent_conv_chain_downlink_body: {
              cells: [{ conversation: { conversation_id: 'existing', bot_id: '7338286299411103781' } }],
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  );
  assert.equal(valid, true);
  assert.equal(calls, 1, 'login validation must not depend on a second model-catalog request');
});

test('Doubao credential saves owner-only config and exposes only redacted summary', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-auth-'));
  const file = path.join(directory, 'config.json');
  try {
    saveDoubaoCredential(
      'sessionid=secret; ttwid=risk',
      { aid: '497858', web_id: 'web', msToken: 'drop-me' },
      'ua',
      file,
    );
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(raw.cookies, 'sessionid=secret; ttwid=risk');
    assert.equal(raw.common_query.msToken, undefined);
    assert.deepEqual(credentialSummary(raw.cookies, raw.common_query), {
      cookieCount: 2,
      cookieBytes: Buffer.byteLength(raw.cookies),
      queryKeys: ['aid', 'web_id'],
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Doubao credential rejects a broadly readable config file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-insecure-'));
  const file = path.join(directory, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ cookies: 'sessionid=secret' }), { mode: 0o644 });
  try {
    withEnv({ X_ADAPTER_DOUBAO_COOKIE: undefined, X_ADAPTER_DOUBAO_CONFIG_PATH: file }, () =>
      assert.throws(() => readDoubaoCredential(), { code: 'insecure_doubao_config_permissions' }),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Doubao credential reads env without returning cookie in summary', () => {
  withEnv(
    {
      X_ADAPTER_DOUBAO_COOKIE: 'sessionid=top-secret',
      X_ADAPTER_DOUBAO_COMMON_QUERY: JSON.stringify({ aid: '497858', device_id: 'device', a_bogus: 'drop-me' }),
    },
    () => {
      const credential = readDoubaoCredential();
      assert.equal(credential.cookie, 'sessionid=top-secret');
      assert.deepEqual(credential.commonQuery, { aid: '497858', device_id: 'device' });
      assert.deepEqual(credential.summary.queryKeys, ['aid', 'device_id']);
      assert.doesNotMatch(JSON.stringify(credential.summary), /top-secret/);
    },
  );
});

test('missing Doubao credential has actionable x-adapter login guidance', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-missing-'));
  try {
    withEnv(
      { X_ADAPTER_DOUBAO_COOKIE: undefined, X_ADAPTER_DOUBAO_CONFIG_PATH: path.join(directory, 'missing.json') },
      () => assert.throws(() => requireDoubaoCredential(), /x-adapter doubao login/),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
