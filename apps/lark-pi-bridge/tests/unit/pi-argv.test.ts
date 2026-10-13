import { describe, expect, it } from 'vitest';
import { buildPiArgs } from '../../src/agent/pi/argv.js';

describe('Pi JSON argv', () => {
  it('uses unattended mode and a profile-local session directory', () => {
    expect(
      buildPiArgs({
        accessMode: 'full',
        sessionDir: '/private/profile/pi-agent/sessions',
        sessionId: 'session-1',
        model: 'provider/model:high',
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
      'provider/model:high',
      '--append-system-prompt',
      '/private/profile/pi-agent/lark-pi-bridge-system-prompt.md',
      '@/private/profile/media/image.png',
    ]);
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
