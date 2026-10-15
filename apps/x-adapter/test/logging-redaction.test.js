import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log, redactHeaders, redactSensitiveText } from '../dist/logging/jsonl.js';

test('root logger redacts current Trae credential headers, OAuth query values, and device secrets', () => {
  const headers = redactHeaders({
    'x-ide-token': 'cloudide-jwt-secret',
    'x-cloudide-token': 'cloudide-token-secret',
    authorization: 'Cloud-IDE-JWT active-secret',
    'x-request-id': 'safe-request-id',
  });
  assert.equal(headers['x-ide-token'], '<redacted>');
  assert.equal(headers['x-cloudide-token'], '<redacted>');
  assert.equal(headers.authorization, '<redacted>');
  assert.equal(headers['x-request-id'], 'safe-request-id');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-log-'));
  const original = process.env.X_ADAPTER_LOG_FILE;
  process.env.X_ADAPTER_LOG_FILE = path.join(directory, 'x-adapter.jsonl');
  try {
    log(
      'error',
      'callback=http://127.0.0.1/authorize?state=state-secret&login_trace_id=trace-secret&authCode=code-secret',
      {
        privateKey: '-----BEGIN PRIVATE KEY-----\nprivate-secret\n-----END PRIVATE KEY-----',
        device_proof: { signature: 'signature-secret' },
        codeVerifier: 'verifier-secret',
        accessToken: 'camel-access-secret',
        refreshToken: 'camel-refresh-secret',
        userJwt: 'camel-jwt-secret',
        authCodeInfo: 'callback-payload-secret',
        state: 'state-field-secret',
        loginTraceID: 'trace-field-secret',
      },
    );
    const text = fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0]), 'utf8');
    assert.doesNotMatch(
      text,
      /state-secret|trace-secret|code-secret|private-secret|signature-secret|verifier-secret|camel-access-secret|camel-refresh-secret|camel-jwt-secret|callback-payload-secret|state-field-secret|trace-field-secret/,
    );
    assert.match(text, /<redacted>/);
    const direct = redactSensitiveText(
      'Cloud-IDE-JWT direct-jwt https://www.trae.ai/authorization?state=direct-state&authCodeInfo=direct-info#fragment',
    );
    assert.doesNotMatch(direct, /direct-jwt|direct-state|direct-info|fragment/);
    assert.match(direct, /Cloud-IDE-JWT <redacted>/);
    assert.match(direct, /https:\/\/www\.trae\.ai\/authorization\?<redacted-query>/);
  } finally {
    if (original === undefined) {
      delete process.env.X_ADAPTER_LOG_FILE;
    } else {
      process.env.X_ADAPTER_LOG_FILE = original;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('root logger redacts Doubao cookie and risk-token fields', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-log-'));
  const original = process.env.X_ADAPTER_LOG_FILE;
  process.env.X_ADAPTER_LOG_FILE = path.join(directory, 'x-adapter.jsonl');
  try {
    const headers = redactHeaders({ cookie: 'sessionid=secret', 'x-request-id': 'safe' });
    assert.equal(headers.cookie, '<redacted>');
    log('error', 'Doubao failed msToken=secret a_bogus=another', {
      msToken: 'secret',
      a_bogus: 'another',
      sessionid: 'third',
    });
    const text = fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0]), 'utf8');
    assert.doesNotMatch(text, /secret|another|third/);
    assert.match(text, /<redacted>/);
  } finally {
    if (original === undefined) {
      delete process.env.X_ADAPTER_LOG_FILE;
    } else {
      process.env.X_ADAPTER_LOG_FILE = original;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
