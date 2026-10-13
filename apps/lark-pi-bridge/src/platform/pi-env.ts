/**
 * The Pi child receives a deliberately small environment. In particular, this
 * prevents bridge/app/provider/npm/cloud credentials inherited by the daemon
 * from entering Pi or tool subprocesses. Pi credentials must live in the
 * selected PI_CODING_AGENT_DIR, not in the bridge process environment.
 */
export interface BuildPiChildEnvInput {
  bridgeEnv: NodeJS.ProcessEnv;
  piConfigDir: string;
  baseEnv?: NodeJS.ProcessEnv;
}

const SAFE_PARENT_ENV = [
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
] as const;

export function buildPiChildEnv(input: BuildPiChildEnvInput): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const base = input.baseEnv ?? process.env;
  for (const key of SAFE_PARENT_ENV) {
    if (base[key] !== undefined) {
      env[key] = base[key];
    }
  }
  for (const [key, value] of Object.entries(input.bridgeEnv)) {
    if ((key === 'LARK_PI_BRIDGE' || key === 'LARK_PI_BRIDGE_PROFILE') && value !== undefined) {
      env[key] = value;
    }
  }
  env.PI_CODING_AGENT_DIR = input.piConfigDir;
  env.PI_TELEMETRY = '0';
  env.PI_SKIP_VERSION_CHECK = '1';
  return env;
}
