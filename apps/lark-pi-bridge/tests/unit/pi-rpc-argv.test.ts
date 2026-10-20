import { describe, expect, it } from 'vitest';
import { buildPiRpcArgs } from '../../src/agent/pi/rpc-argv.js';

describe('Pi RPC argv', () => {
  it('uses RPC unattended mode and no @file prompt arguments', () => {
    const args = buildPiRpcArgs({
      accessMode: 'read-only',
      sessionId: 'session-a',
      sessionDir: '/private/sessions',
      model: 'local/model',
      thinkingLevel: 'xhigh',
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
      '--thinking',
      'xhigh',
      '--append-system-prompt',
      '/private/system.md',
      '--tools',
      'read,grep,find,ls',
    ]);
    expect(args.some((value) => value.startsWith('@'))).toBe(false);
  });

  it('keeps resumed handoff sessions full + approve', () => {
    const args = buildPiRpcArgs({
      accessMode: 'read-only',
      handoff: true,
      sessionId: 'fork-id',
      sessionDir: '/private/sessions',
      bridgeSystemPromptFile: '/private/system.md',
    });
    expect(args).toEqual(expect.arrayContaining(['--approve', '--session', 'fork-id']));
    expect(args).not.toContain('--no-approve');
    expect(args).not.toContain('--tools');
  });
});
