import { describe, expect, it } from 'vitest';
import { buildPiArgs } from '../../src/agent/pi/argv.js';

describe('Pi JSON argv', () => {
  it('uses unattended mode and a profile-local session directory', () => {
    expect(
      buildPiArgs({
        accessMode: 'full',
        sessionDir: '/private/profile/pi-agent/sessions',
        sessionId: 'session-1',
        model: 'provider/model',
        thinkingLevel: 'high',
        attachments: ['/private/profile/media/image.png'],
        bridgeSystemPromptFile: '/private/profile/pi-agent/lark-pi-bridge-system-prompt.md',
      }),
    ).toEqual([
      '--mode',
      'json',
      '--session-dir',
      '/private/profile/pi-agent/sessions',
      '--no-approve',
      '--session',
      'session-1',
      '--model',
      'provider/model',
      '--thinking',
      'high',
      '--append-system-prompt',
      '/private/profile/pi-agent/lark-pi-bridge-system-prompt.md',
      '@/private/profile/media/image.png',
    ]);
  });

  it('uses native fork with full tools and explicit approval for handoff', () => {
    const args = buildPiArgs({
      accessMode: 'read-only',
      handoff: true,
      forkPath: '/trusted/source.jsonl',
      sessionDir: '/private/profile/sessions',
      bridgeSystemPromptFile: '/private/system.md',
    });
    expect(args).toEqual(expect.arrayContaining(['--fork', '/trusted/source.jsonl', '--approve']));
    expect(args).not.toContain('--session');
    expect(args).not.toContain('--no-approve');
    expect(args).not.toContain('--tools');
  });

  it('uses an explicit read-only tool allowlist without claiming workspace isolation', () => {
    const args = buildPiArgs({
      accessMode: 'read-only',
      sessionDir: '/tmp/pi-sessions',
      bridgeSystemPromptFile: '/tmp/lark-pi-bridge-system-prompt.md',
    });
    expect(args).toContain('--tools');
    expect(args).toContain('read,grep,find,ls');
    expect(args).not.toContain('workspace');
  });

  it('requires a session directory', () => {
    expect(() =>
      buildPiArgs({ accessMode: 'full', sessionDir: '  ', bridgeSystemPromptFile: '/tmp/bridge-policy.md' }),
    ).toThrow(/sessionDir/i);
  });
});
