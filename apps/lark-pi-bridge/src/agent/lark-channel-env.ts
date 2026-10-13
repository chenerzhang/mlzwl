export interface LarkChannelEnvContext {
  profile?: string;
  rootDir?: string;
}

export function buildLarkChannelEnv(context?: LarkChannelEnvContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { LARK_PI_BRIDGE: '1' };
  if (context?.profile?.trim()) {
    env.LARK_PI_BRIDGE_PROFILE = context.profile;
  }
  if (context?.rootDir?.trim()) {
    env.LARK_PI_BRIDGE_HOME = context.rootDir;
  }
  return env;
}
