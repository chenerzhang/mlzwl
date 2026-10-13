import { describe, expect, it } from 'vitest';
import { buildPiRpcArgs } from '../../src/agent/pi/rpc-argv.js';

describe('Pi RPC argv', () => {
  it('uses RPC unattended mode and no @file prompt arguments', () => {
    const args = buildPiRpcArgs({
      accessMode: 'read-only',
      sessionId: 'session-a',
      sessionDir: '/private/sessions',
      model: 'local/model',
      bridgeSystemPromptFile: '/private/system.md',
    });
    expect(args).toEqual([
      '--mode',
      'rpc',
      '--session-dir',
      '/private/sessions',
      '--no-approve',
      '--session',
      'session-a',
      '--model',
      'local/model',
      '--append-system-prompt',
      '/private/system.md',
      '--tools',
      'read,grep,find,ls',
    ]);
    expect(args.some((value) => value.startsWith('@'))).toBe(false);
  });
});
