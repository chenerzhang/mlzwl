import { describe, expect, it } from 'vitest';
import { buildPiChildEnv } from '../../src/platform/pi-env.js';

describe('Pi child environment', () => {
  it('uses a narrow allowlist and never forwards parent secrets', () => {
    const env = buildPiChildEnv({
      piConfigDir: '/private/profile/pi-agent',
      bridgeEnv: { LARK_PI_BRIDGE: '1', LARK_PI_BRIDGE_PROFILE: 'default', LARKSUITE_CLI_CONFIG_DIR: '/must-not-pass' },
      baseEnv: {
        PATH: '/bin',
        HOME: '/home/user',
        APP_SECRET: 'must-not-pass',
        OPENAI_API_KEY: 'must-not-pass',
        NPM_TOKEN: 'must-not-pass',
        COOKIE: 'must-not-pass',
      },
    });
    expect(env).toMatchObject({
      PATH: '/bin',
      HOME: '/home/user',
      LARK_PI_BRIDGE: '1',
      LARK_PI_BRIDGE_PROFILE: 'default',
      PI_CODING_AGENT_DIR: '/private/profile/pi-agent',
      PI_TELEMETRY: '0',
      PI_SKIP_VERSION_CHECK: '1',
    });
    expect(env).not.toHaveProperty('APP_SECRET');
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(env).not.toHaveProperty('NPM_TOKEN');
    expect(env).not.toHaveProperty('COOKIE');
    expect(env).not.toHaveProperty('LARKSUITE_CLI_CONFIG_DIR');
  });
});
