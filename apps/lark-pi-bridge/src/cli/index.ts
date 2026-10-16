#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFile, rename, rm } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { Command } from 'commander';
import pkg from '../../package.json' with { type: 'json' };
import { startChannel } from '../bot/channel.js';
import { resolveAppPaths, type AppPaths } from '../config/app-paths.js';
import type { CompatiblePiApi } from '../config/pi-models.js';
import { inspectEffectivePiModelConfiguration } from '../config/pi-paths.js';
import {
  activateProfile,
  canonicalWorkspaceDirectory,
  configureProfileModel,
  getDefaultWorkspace,
  getPublicProfile,
  listPublicProfiles,
  removeWorkspace,
  setDefaultWorkspace,
  setWorkspace,
  updateProfileMentionOptionalChat,
  updateProfilePiConfigScope,
  updateProfileSessionRetention,
  updateProfileTransport,
  validateWorkspaceAlias,
} from '../config/profile-management.js';
import {
  CURRENT_CONFIG_SCHEMA_VERSION,
  createProfileConfig,
  type ProfileMode,
  type RootConfig,
  type TenantBrand,
} from '../config/profile-schema.js';
import {
  loadRootConfig,
  resolveAppSecret,
  saveAppSecret,
  saveRootConfig,
  writeActiveProfile,
} from '../config/store.js';
import { runDoctor } from './doctor.js';
import { renderLaunchdManifest, writeLaunchdManifest } from '../daemon/launchd.js';
import { ManagedService, type ServiceAction } from '../daemon/managed-service.js';
import { LocalServiceController } from '../daemon/service.js';
import { registerBridgeApp } from '../registration/app-registration.js';
import { createRuntimeAgent } from '../runtime/agent-runtime.js';
import {
  clearConnectionFailuresAfterStableConnection,
  CONNECTION_STABLE_RESET_MS,
  recordConnectionFailure,
  waitForConnectionRetryWindow,
} from '../runtime/connection-retry.js';
import {
  optionalRuntimeControlStatus,
  refreshRuntime,
  runtimeControlStatus,
  runtimeControlUnavailable,
  startRuntimeControlServer,
} from '../runtime/control.js';
import { loadProfileRuntimeFingerprint, ReloadableBridgeRuntime } from '../runtime/reloadable.js';
import { acquireRuntimeLock, RuntimeLockConflictError } from '../runtime/locks.js';
import { pruneSessions } from '../session/retention.js';
import { updateBridge } from '../update/updater.js';
import { resolveEffectiveWorkspace } from '../policy/workspace.js';
import { startWebConsole } from '../web/server.js';

interface GlobalOptions {
  home?: string;
}
interface ProfileOption {
  profile?: string;
  piBin?: string;
}

export const program = new Command();
program
  .name('lark-pi-bridge')
  .description('本地 Pi coding-agent 飞书/Lark bridge')
  .allowUnknownOption(false)
  .showHelpAfterError()
  .version(pkg.version, '-v, --version')
  .option('--home <path>', 'bridge 数据目录（默认 ~/.lark-pi-bridge）');

program
  .command('init')
  .description('创建或更新本地 profile；--register 会发起需人工确认的扫码注册')
  .option('--profile <name>', 'profile 名称', 'default')
  .option('--register', '使用官方 device-code 流程创建或选择应用')
  .option('--create-only', '注册时仅允许创建新应用，不显示已有应用入口')
  .option('--existing-app <id>', '注册并增量更新指定已有 App ID')
  .option('--qr-format <png|ascii>', '二维码输出格式', 'ascii')
  .option('--lark-cli-bin <path>', 'lark-cli binary（只用于生成二维码）', 'lark-cli')
  .option('--app-id <id>', '手工导入的飞书/Lark App ID')
  .option('--app-secret-file <path>', '手工导入的 App Secret 文件；secret 不进入 argv')
  .option('--tenant <feishu|lark>', '注册入口/手工凭据的租户品牌；新 profile 默认 feishu')
  .option('--mode <personal|team>', '入口模式；新 profile 默认 personal')
  .option('--pi-config-scope <user|profile>', 'Pi 配置来源；新 profile 默认 user')
  .option('--workspace <absolute-path>', 'direct default 工作目录；建议随后设置命名 workspace default')
  .option('--workspace-alias <alias=absolute-path...>', '命名 workspace，可通过 /workspace use <alias> 切换')
  .option('--allow-user <open-id...>', '个人模式允许的 DM 用户 open_id')
  .option('--admin <open-id...>', '管理员 open_id')
  .option('--allow-chat <chat-id...>', '个人模式允许的群 chat_id')
  .option('--access <read-only|full>', '默认 Pi access mode；新 profile 默认 full')
  .option('--max-access <read-only|full>', 'profile 最大 Pi access mode；新 profile 默认 full')
  .option('--transport <spawn-per-turn|rpc>', 'bridge 到本机 Pi 的 transport；新 profile 默认 rpc')
  .action(
    async (opts: {
      profile: string;
      register?: boolean;
      createOnly?: boolean;
      existingApp?: string;
      qrFormat: string;
      larkCliBin: string;
      appId?: string;
      appSecretFile?: string;
      tenant?: string;
      mode?: string;
      piConfigScope?: string;
      workspace?: string;
      workspaceAlias?: string[];
      allowUser?: string[];
      admin?: string[];
      allowChat?: string[];
      access?: string;
      maxAccess?: string;
      transport?: string;
    }) => {
      if (opts.tenant !== undefined && opts.tenant !== 'feishu' && opts.tenant !== 'lark') {
        throw new Error('--tenant 只能是 feishu 或 lark');
      }
      if (opts.mode !== undefined && opts.mode !== 'personal' && opts.mode !== 'team') {
        throw new Error('--mode 只能是 personal 或 team');
      }
      if (opts.transport !== undefined && opts.transport !== 'spawn-per-turn' && opts.transport !== 'rpc') {
        throw new Error('--transport 只能是 spawn-per-turn 或 rpc');
      }
      if (opts.piConfigScope !== undefined && opts.piConfigScope !== 'user' && opts.piConfigScope !== 'profile') {
        throw new Error('--pi-config-scope 只能是 user 或 profile');
      }
      if (opts.qrFormat !== 'png' && opts.qrFormat !== 'ascii') {
        throw new Error('--qr-format 只能是 png 或 ascii');
      }
      if (opts.createOnly && opts.existingApp) {
        throw new Error('--create-only 与 --existing-app 不能同时使用');
      }
      const hasManualId = Boolean(opts.appId);
      const hasManualSecret = Boolean(opts.appSecretFile);
      if (opts.register && (hasManualId || hasManualSecret)) {
        throw new Error('--register 与 --app-id/--app-secret-file 互斥');
      }
      if (!opts.register && (!hasManualId || !hasManualSecret)) {
        throw new Error('请选择 --register，或同时提供 --app-id 与 --app-secret-file');
      }
      if (!opts.register && (opts.createOnly || opts.existingApp)) {
        throw new Error('--create-only/--existing-app 只能与 --register 一起使用');
      }
      const paths = resolveAppPaths({ rootDir: program.opts<GlobalOptions>().home, profile: opts.profile });
      const current = await loadRootConfig(paths.configFile);
      const existing = current?.profiles[paths.profile];
      const allowedUsers = opts.allowUser ? strings(opts.allowUser) : [...(existing?.access.allowedUsers ?? [])];
      const admins = opts.admin ? strings(opts.admin) : [...(existing?.access.admins ?? [])];
      const allowedChats = opts.allowChat ? strings(opts.allowChat) : [...(existing?.access.allowedChats ?? [])];
      let appId: string;
      let appSecret: string;
      let tenant = (opts.tenant ?? existing?.accounts.app.tenant ?? 'feishu') as TenantBrand;
      const mode = (opts.mode ?? existing?.mode ?? 'personal') as ProfileMode;
      if (opts.register) {
        const registered = await registerBridgeApp({
          tenant,
          createOnly: opts.createOnly,
          existingAppId: opts.existingApp,
          qrFormat: opts.qrFormat,
          qrOutputPath: paths.registrationQrFile,
          larkCliBinary: opts.larkCliBin,
        });
        appId = registered.appId;
        appSecret = registered.appSecret;
        tenant = registered.tenant;
        if (registered.ownerOpenId && !allowedUsers.includes(registered.ownerOpenId)) {
          allowedUsers.push(registered.ownerOpenId);
        }
      } else {
        appId = opts.appId!;
        appSecret = (await readFile(opts.appSecretFile!, 'utf8')).trim();
        if (!appSecret) {
          throw new Error('--app-secret-file 为空');
        }
      }
      if (mode === 'personal' && allowedUsers.length + admins.length + allowedChats.length === 0) {
        throw new Error('personal profile 至少需要一个 --allow-user、--admin 或 --allow-chat，以保持入口 fail-closed');
      }
      const namedWorkspaces = opts.workspaceAlias
        ? await parseWorkspaceAliases(opts.workspaceAlias)
        : { ...(existing?.workspaces.named ?? {}) };
      const workspaces = opts.workspace
        ? { defaultPath: await canonicalWorkspaceDirectory(opts.workspace), named: namedWorkspaces }
        : {
            ...(existing?.workspaces.defaultAlias ? { defaultAlias: existing.workspaces.defaultAlias } : {}),
            ...(existing?.workspaces.defaultPath ? { defaultPath: existing.workspaces.defaultPath } : {}),
            named: namedWorkspaces,
          };
      const transport =
        opts.transport === 'spawn-per-turn' || opts.transport === 'rpc'
          ? opts.transport
          : (existing?.preferences.transport ?? 'rpc');
      const profile = createProfileConfig({
        app: {
          id: appId,
          secretFile: relative(paths.rootDir, paths.appSecretFile),
          tenant,
        },
        mode,
        workspaces,
        access: {
          allowedUsers,
          allowedChats,
          mentionOptionalChats: existing?.access.mentionOptionalChats,
          admins,
          requireMentionInGroup: existing?.access.requireMentionInGroup,
        },
        permissions: {
          defaultAccess: opts.access
            ? accessMode(opts.access, '--access')
            : (existing?.permissions.defaultAccess ?? 'full'),
          maxAccess: opts.maxAccess
            ? accessMode(opts.maxAccess, '--max-access')
            : (existing?.permissions.maxAccess ?? 'full'),
        },
        preferences: {
          piConfigScope: (opts.piConfigScope ?? existing?.preferences.piConfigScope ?? 'user') as 'user' | 'profile',
          ...existing?.preferences,
          ...(opts.piConfigScope ? { piConfigScope: opts.piConfigScope as 'user' | 'profile' } : {}),
          transport,
        },
      });
      const root = {
        schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
        activeProfile: paths.profile,
        profiles: { ...(current?.profiles ?? {}), [paths.profile]: profile },
      };
      await installProfileConfig(paths, current, root, appSecret);
      await writeActiveProfile(paths.activeProfileFile, paths.profile);
      await rm(paths.registrationQrFile, { force: true });
      console.log(
        JSON.stringify({
          ok: true,
          profile: paths.profile,
          appId,
          tenant,
          config: paths.configFile,
          secretFile: paths.appSecretFile,
          home: paths.rootDir,
        }),
      );
    },
  );

program
  .command('validate')
  .description('校验配置和 Pi；仅调用本机回环 mock，不连接飞书或真实模型')
  .option('--profile <name>', 'profile 名称；省略时使用 active profile')
  .option('--pi-bin <path>', 'Pi binary 路径（默认 PATH 中的 pi）')
  .action(async (opts: ProfileOption) => {
    const { paths, profile } = await selectedProfile(opts);
    const agent = createRuntimeAgent(profile, paths, opts.piBin);
    const report = await runDoctor(paths, profile, agent);
    if (!report.ok) {
      const failed = report.checks.filter((check) => check.status === 'fail').map((check) => check.name);
      throw new Error(`validation failed: ${failed.join(', ')}`);
    }
    console.log(
      JSON.stringify({
        ok: true,
        profile: paths.profile,
        agent: agent.id,
        piVersion: report.checks.find((check) => check.name === 'pi_capability')?.detail ?? null,
        home: paths.rootDir,
        checks: report.checks,
        model: report.model,
      }),
    );
  });

const profileCommand = program.command('profile').description('查看和管理非机密 profile 状态');
profileCommand
  .command('list')
  .description('列出 profile；省略选择时使用 active profile')
  .action(async () => {
    const paths = await managementPaths({});
    console.log(JSON.stringify({ profiles: await listPublicProfiles(paths) }));
  });
profileCommand
  .command('status')
  .description('查看一个 profile 的非机密状态')
  .argument('[name]', 'profile 名称；省略时使用 active profile')
  .action(async (name?: string) => {
    const paths = await managementPaths({ profile: name });
    console.log(JSON.stringify(await getPublicProfile(paths)));
  });
const piConfigScopeCommand = profileCommand.command('pi-config-scope').description('读取或设置 profile 的 Pi 配置来源');
piConfigScopeCommand
  .command('get')
  .option('--profile <name>', 'profile 名称；省略时使用 active profile')
  .action(async (opts: ProfileOption) => {
    const paths = await managementPaths(opts);
    const profile = await getPublicProfile(paths);
    console.log(JSON.stringify({ profile: paths.profile, piConfigScope: profile.preferences.piConfigScope }));
  });
const piConfigScopeSetCommand = piConfigScopeCommand
  .command('set')
  .argument('<scope>', 'user 或 profile')
  .option('--profile <name>', 'profile 名称；省略时使用 active profile')
  .action(async (scope: string, opts: ProfileOption) => {
    if (scope !== 'user' && scope !== 'profile') {
      throw new Error(`Pi config scope 必须是 user 或 profile\n\n${piConfigScopeSetCommand.helpInformation()}`);
    }
    const paths = await managementPaths(opts);
    await updateProfilePiConfigScope(paths, scope);
    console.log(JSON.stringify({ ok: true, profile: paths.profile, piConfigScope: scope }));
  });
const mentionOptionalCommand = profileCommand.command('mention-optional').description('管理已授权群聊的免 @ 触发例外');
mentionOptionalCommand
  .command('list')
  .option('--profile <name>', 'profile 名称；省略时使用 active profile')
  .action(async (opts: ProfileOption) => {
    const paths = await managementPaths(opts);
    const profile = await getPublicProfile(paths);
    console.log(JSON.stringify({ profile: paths.profile, mentionOptionalChats: profile.access.mentionOptionalChats }));
  });
for (const enabled of [true, false] as const) {
  mentionOptionalCommand
    .command(enabled ? 'add' : 'remove')
    .argument('<chat-id>', '已在 allowedChats 中的 oc_ 群 chat_id')
    .option('--profile <name>', 'profile 名称；省略时使用 active profile')
    .action(async (chatId: string, opts: ProfileOption) => {
      const paths = await managementPaths(opts);
      console.log(
        JSON.stringify({
          ok: true,
          profile: paths.profile,
          ...(await updateProfileMentionOptionalChat(paths, chatId, enabled)),
          refreshRequired: true,
        }),
      );
    });
}
profileCommand
  .command('transport')
  .description('查看或设置 Pi transport')
  .argument('[transport]', '省略时查看；可设置 spawn-per-turn 或 rpc')
  .option('--profile <name>', 'profile 名称；省略时使用 active profile')
  .action(async (transport: string | undefined, opts: ProfileOption) => {
    const paths = await managementPaths(opts);
    if (transport === undefined) {
      const profile = await getPublicProfile(paths);
      console.log(JSON.stringify({ profile: paths.profile, transport: profile.preferences.transport }));
      return;
    }
    if (transport !== 'spawn-per-turn' && transport !== 'rpc') {
      throw new Error('transport 只能是 spawn-per-turn 或 rpc');
    }
    await updateProfileTransport(paths, transport);
    console.log(JSON.stringify({ ok: true, profile: paths.profile, transport }));
  });
const sessionRetentionCommand = profileCommand
  .command('session-retention')
  .description('查看或设置自动 session 保留策略；修改后需 config refresh');
sessionRetentionCommand
  .command('get')
  .option('--profile <name>', 'profile 名称；省略时使用 active profile')
  .action(async (opts: ProfileOption) => {
    const paths = await managementPaths(opts);
    const profile = await getPublicProfile(paths);
    console.log(JSON.stringify({ profile: paths.profile, sessionRetention: profile.preferences.sessionRetention }));
  });
sessionRetentionCommand
  .command('set')
  .option('--profile <name>', 'profile 名称；省略时使用 active profile')
  .option('--enabled <true|false>', '启用或关闭自动清理')
  .option('--active-days <days>', 'active session 保留天数，7–3650')
  .option('--archived-days <days>', 'archived session 保留天数，1–365')
  .option('--orphan-days <days>', 'orphan session 保留天数，1–365')
  .action(
    async (
      opts: ProfileOption & { enabled?: string; activeDays?: string; archivedDays?: string; orphanDays?: string },
    ) => {
      if (
        opts.enabled === undefined &&
        opts.activeDays === undefined &&
        opts.archivedDays === undefined &&
        opts.orphanDays === undefined
      ) {
        throw new Error('至少指定一个 session retention 设置');
      }
      const paths = await managementPaths(opts);
      const sessionRetention = await updateProfileSessionRetention(paths, {
        ...(opts.enabled !== undefined ? { enabled: booleanOption(opts.enabled, '--enabled') } : {}),
        ...(opts.activeDays !== undefined ? { activeDays: integerOption(opts.activeDays, '--active-days') } : {}),
        ...(opts.archivedDays !== undefined
          ? { archivedDays: integerOption(opts.archivedDays, '--archived-days') }
          : {}),
        ...(opts.orphanDays !== undefined ? { orphanDays: integerOption(opts.orphanDays, '--orphan-days') } : {}),
      });
      console.log(JSON.stringify({ ok: true, profile: paths.profile, sessionRetention, refreshRequired: true }));
    },
  );
profileCommand
  .command('activate')
  .description('设置 active profile')
  .argument('<name>', 'profile 名称')
  .action(async (name: string) => {
    const paths = await managementPaths({});
    await activateProfile(paths, name);
    console.log(JSON.stringify({ ok: true, activeProfile: name }));
  });

const sessionsCommand = program.command('sessions').description('查看和清理当前 profile 的 Pi session');
sessionsCommand
  .command('prune')
  .description('按 profile 保留策略预览或删除过期 session；默认只预览')
  .option('--profile <name>', 'profile 名称；省略时使用 active profile')
  .option('--dry-run', '只预览，不删除（默认）')
  .option('--apply', '实际删除；profile 运行中时拒绝')
  .action(async (opts: ProfileOption & { dryRun?: boolean; apply?: boolean }) => {
    if (opts.apply && opts.dryRun) {
      throw new Error('--apply 与 --dry-run 不能同时使用');
    }
    const { paths, profile } = await selectedProfile(opts);
    let lock: Awaited<ReturnType<typeof acquireRuntimeLock>> | undefined;
    if (opts.apply) {
      try {
        lock = await acquireRuntimeLock(paths.profileLockFile);
      } catch (error) {
        if (error instanceof RuntimeLockConflictError) {
          throw new Error('profile 正在运行；请停止 runtime 后执行 sessions prune --apply', { cause: error });
        }
        throw error;
      }
    }
    try {
      console.log(
        JSON.stringify({
          profile: paths.profile,
          ...(await pruneSessions({
            sessionDir: paths.piSessionDir,
            catalogFile: paths.sessionCatalogFile,
            policy: profile.preferences.sessionRetention,
            dryRun: !opts.apply,
          })),
        }),
      );
    } finally {
      await lock?.release();
    }
  });

const workspaceCommand = program.command('workspace').description('查看和管理当前 profile 的命名 workspace');
workspaceCommand
  .command('list')
  .description('列出 alias、canonical path、默认值和目录可用状态')
  .option('--profile <name>', 'profile 名称；省略时使用 active profile')
  .action(async (opts: ProfileOption) => {
    const paths = await managementPaths(opts);
    const profile = await getPublicProfile(paths);
    console.log(JSON.stringify({ profile: paths.profile, workspaces: profile.workspaces }));
  });
workspaceCommand
  .command('set')
  .description('注册或更新命名 alias；default 是保留字')
  .argument('<alias>', '安全 alias（不能是 default）')
  .argument('<absolute-path>', '已存在目录的绝对路径')
  .option('--profile <name>', 'profile 名称；省略时使用 active profile')
  .action(async (alias: string, path: string, opts: ProfileOption) => {
    const paths = await managementPaths(opts);
    console.log(JSON.stringify({ ok: true, profile: paths.profile, ...(await setWorkspace(paths, { alias, path })) }));
  });
workspaceCommand
  .command('remove')
  .description('删除非默认的已有 alias')
  .argument('<alias>', '已有 alias')
  .option('--profile <name>', 'profile 名称；省略时使用 active profile')
  .action(async (alias: string, opts: ProfileOption) => {
    const paths = await managementPaths(opts);
    await removeWorkspace(paths, alias);
    console.log(JSON.stringify({ ok: true, profile: paths.profile, alias }));
  });
const workspaceDefaultCommand = workspaceCommand
  .command('default')
  .description('查看或设置 profile 默认 workspace alias');
workspaceDefaultCommand
  .command('get')
  .option('--profile <name>', 'profile 名称；省略时使用 active profile')
  .action(async (opts: ProfileOption) => {
    const paths = await managementPaths(opts);
    console.log(JSON.stringify({ profile: paths.profile, default: await getDefaultWorkspace(paths) }));
  });
workspaceDefaultCommand
  .command('set')
  .argument('<alias>', '已经存在的命名 alias')
  .option('--profile <name>', 'profile 名称；省略时使用 active profile')
  .action(async (alias: string, opts: ProfileOption) => {
    const paths = await managementPaths(opts);
    console.log(JSON.stringify({ ok: true, profile: paths.profile, default: await setDefaultWorkspace(paths, alias) }));
  });

const configCommand = program.command('config').description('刷新 bridge 配置');
configCommand
  .command('refresh')
  .description('通过 profile 私有本机控制通道刷新非 workspace 运行时配置')
  .option('--profile <name>', 'profile 名称；省略时使用 active profile')
  .option('--pi-bin <path>', 'runtime 未运行时用于验证的 Pi binary 路径（默认 PATH 中的 pi）')
  .action(async (opts: ProfileOption) => {
    const { paths, profile } = await selectedProfile(opts);
    try {
      console.log(JSON.stringify(await refreshRuntime(paths)));
    } catch (error) {
      if (!runtimeControlUnavailable(error)) {
        throw error;
      }
      await optionalRuntimeControlStatus(paths);
      await validateStoppedRuntimeConfig(paths, profile, opts.piBin);
      console.log(
        JSON.stringify({
          ok: true,
          profile: paths.profile,
          running: false,
          refreshed: false,
          changed: false,
          message: 'runtime 未运行；配置已验证，将在下次启动时生效。',
        }),
      );
    }
  });

program
  .command('update')
  .description('从固定公共 npm registry 安全更新包并恢复 owned service 状态')
  .action(async () => {
    const home = resolveAppPaths({ rootDir: program.opts<GlobalOptions>().home }).rootDir;
    console.log(JSON.stringify(await updateBridge({ rootDirs: [home] })));
  });

program
  .command('model-config')
  .description('配置当前 profile 独立 PI_CODING_AGENT_DIR 中的兼容 provider/model；不会读取默认 Pi auth')
  .requiredOption('--provider <id>', 'Pi provider ID')
  .requiredOption('--model <id>', 'provider 内的 model ID')
  .requiredOption('--base-url <url>', 'provider base URL；HTTP 只允许 loopback')
  .requiredOption('--api <type>', 'openai-completions、openai-responses 或 anthropic-messages')
  .option('--input <text|text,image>', '模型输入能力；默认 text，只有上游确认支持图片时才声明 image', 'text')
  .option('--api-key-file <path>', '私有 API key 文件；key 不进入 argv 或普通 bridge 配置')
  .option('--profile <name>', 'profile 名称；省略时使用 active profile')
  .action(
    async (opts: {
      profile?: string;
      provider: string;
      model: string;
      baseUrl: string;
      api: string;
      input: string;
      apiKeyFile?: string;
    }) => {
      const { paths } = await selectedProfile(opts);
      const api = compatibleApi(opts.api);
      await configureProfileModel(paths, {
        providerId: opts.provider,
        modelId: opts.model,
        baseUrl: opts.baseUrl,
        api,
        input: modelInput(opts.input),
        apiKeyFile: opts.apiKeyFile,
      });
      console.log(
        JSON.stringify({
          ok: true,
          profile: paths.profile,
          provider: opts.provider,
          model: opts.model,
          endpoint: opts.baseUrl,
          api,
          input: modelInput(opts.input),
          credentialStored: Boolean(opts.apiKeyFile),
        }),
      );
    },
  );

program
  .command('model-status')
  .description('检查有效 Pi provider/model 选择；不连接 provider')
  .option('--profile <name>', 'profile 名称；省略时使用 active profile')
  .action(async (opts: ProfileOption) => {
    const { paths, profile } = await selectedProfile(opts);
    console.log(JSON.stringify(await inspectEffectivePiModelConfiguration(profile, paths)));
  });

program
  .command('doctor')
  .description('分层诊断配置、App Secret、Pi、provider 可达性及可选真实模型；默认不连接 provider')
  .option('--profile <name>', 'profile 名称；省略时使用 active profile')
  .option('--pi-bin <path>', 'Pi binary 路径（默认 PATH 中的 pi）')
  .option('--check-provider', '只检查配置中 provider endpoint 的 TCP 可达性')
  .option('--check-credentials', '执行一次真实模型 turn；会产生真实 provider 调用')
  .action(async (opts: ProfileOption & { checkProvider?: boolean; checkCredentials?: boolean }) => {
    const { paths, profile } = await selectedProfile(opts);
    const agent = createRuntimeAgent(profile, paths, opts.piBin);
    const workspace = await resolveEffectiveWorkspace(profile.workspaces);
    const report = await runDoctor(paths, profile, agent, {
      checkProvider: opts.checkProvider || opts.checkCredentials,
      checkCredentials: opts.checkCredentials,
      probeModel:
        opts.checkCredentials && workspace.ok
          ? () =>
              agent.probeModel!({
                cwd: workspace.cwdRealpath,
                accessMode: 'read-only',
                model: profile.preferences.model,
              })
          : undefined,
    });
    console.log(JSON.stringify(report));
    if (!report.ok) {
      process.exitCode = 1;
    }
  });

program
  .command('web')
  .description('启动仅监听 127.0.0.1 的本地管理控制台；不执行真实模型检查')
  .option('--port <port>', '本地端口（默认随机可用端口）')
  .option('--pi-bin <path>', 'Pi binary 路径（默认 PATH 中的 pi）')
  .action(async (opts: { port?: string; piBin?: string }) => {
    const port = opts.port === undefined ? undefined : webPort(opts.port);
    const handle = await startWebConsole({ rootDir: program.opts<GlobalOptions>().home, port, piBin: opts.piBin });
    console.log(`lark-pi-bridge 本地控制台：${handle.url}`);
    try {
      await untilSignal();
    } finally {
      await handle.close();
    }
  });

program
  .command('run')
  .description('在前台连接指定 profile；需要有效飞书 App 凭据，真实连接')
  .option('--profile <name>', 'profile 名称；省略时使用 active profile')
  .option('--pi-bin <path>', 'Pi binary 路径（默认 PATH 中的 pi）')
  .action(async (opts: ProfileOption) => {
    const { paths, profile } = await selectedProfile(opts);
    const runtime = new ReloadableBridgeRuntime({
      profile: paths.profile,
      initialProfile: profile,
      loadProfile: async () => {
        const latest = await loadRootConfig(paths.configFile);
        const next = latest?.profiles[paths.profile];
        if (!next) {
          throw new Error(`profile 不存在：${paths.profile}`);
        }
        return next;
      },
      loadRuntimeFingerprint: (next) => loadProfileRuntimeFingerprint(paths, next),
      createAgent: (next) => createRuntimeAgent(next, paths, opts.piBin),
      startChannel: (next, agent) => startChannel({ profile: next, paths, agent }),
    });
    const controller = serviceController(paths);
    let control: Awaited<ReturnType<typeof startRuntimeControlServer>> | undefined;
    let bridge: Awaited<ReturnType<typeof controller.start>> | undefined;
    let connectedAt = 0;
    let stableTimer: NodeJS.Timeout | undefined;
    try {
      const retryDelay = await waitForConnectionRetryWindow(paths.connectionRetryFile);
      if (retryDelay > 0) {
        console.error(`飞书连接恢复退避等待 ${Math.ceil(retryDelay / 1_000)} 秒。`);
      }
      bridge = await controller.start(async () => {
        await runtime.start();
        try {
          control = await startRuntimeControlServer(paths, runtime);
        } catch (error) {
          await runtime.stop().catch(() => {});
          throw error;
        }
        return {
          stop: async () => {
            await control?.close();
            await runtime.stop();
          },
        };
      });
      connectedAt = Date.now();
      stableTimer = setTimeout(() => {
        void clearConnectionFailuresAfterStableConnection(paths.connectionRetryFile, connectedAt).catch(() => {});
      }, CONNECTION_STABLE_RESET_MS);
      stableTimer.unref();
      console.log(`lark-pi-bridge 已连接 profile「${paths.profile}」。按 Ctrl-C 退出。`);
      const signal = untilSignal();
      try {
        await Promise.race([signal.promise, runtime.waitForFailure()]);
      } finally {
        signal.cancel();
      }
    } catch (error) {
      if (connectedAt) {
        await clearConnectionFailuresAfterStableConnection(paths.connectionRetryFile, connectedAt).catch(() => {});
      }
      await recordConnectionFailure(paths.connectionRetryFile).catch(() => {});
      throw error;
    } finally {
      if (stableTimer) {
        clearTimeout(stableTimer);
      }
      await bridge?.stop();
    }
  });

program
  .command('service')
  .description(
    '管理当前用户 service：install 写入定义（必须 --pi-bin）；bootstrap 加载；start/stop 临时启停；enable/disable 管理登录自启；restart 重启；recover 修复 owned 定义；uninstall 仅移除定义',
  )
  .argument('<action>', 'install|bootstrap|start|status|stop|restart|enable|disable|recover|uninstall')
  .option('--profile <name>', 'profile 名称；省略时使用 active profile')
  .option('--pi-bin <path>', 'Pi binary 绝对路径（install 时必填）')
  .option('--path <path>', 'service 子进程 PATH（默认当前 PATH）')
  .action(async (actionValue: string, opts: ProfileOption & { piBin?: string; path?: string }) => {
    const action = serviceAction(actionValue);
    const paths = await managementPaths(opts);
    const executable = process.argv[1];
    if (!executable) {
      throw new Error('无法确定当前 CLI 可执行路径');
    }
    if (action === 'install' && !opts.piBin) {
      throw new Error('service install 必须提供绝对 --pi-bin');
    }
    const manager = new ManagedService({
      profile: paths.profile,
      rootDir: resolve(paths.rootDir),
      nodePath: process.execPath,
      cliEntryPath: resolve(executable),
      piBin: opts.piBin,
      envPath: opts.path ?? process.env.PATH ?? '',
    });
    console.log(JSON.stringify(await manager[action]()));
  });

program
  .command('service-manifest')
  .description('仅生成 macOS launchd manifest，不安装、不加载、不启动 service')
  .option('--profile <name>', 'profile 名称；省略时使用 active profile')
  .option('--pi-bin <path>', 'Pi binary 路径（默认 PATH 中的 pi）')
  .action(async (opts: ProfileOption) => {
    const paths = await managementPaths(opts);
    const executable = process.argv[1];
    if (!executable) {
      throw new Error('无法确定当前 CLI 可执行路径');
    }
    const manifest = renderLaunchdManifest({
      label: `ai.x-connect.lark-pi-bridge.${paths.profile}`,
      programArguments: [
        process.execPath,
        executable,
        '--home',
        paths.rootDir,
        'run',
        '--profile',
        paths.profile,
        ...(opts.piBin ? ['--pi-bin', opts.piBin] : []),
      ],
      workingDirectory: paths.rootDir,
      standardOutPath: `${paths.logsDir}/service.stdout.log`,
      standardErrorPath: `${paths.logsDir}/service.stderr.log`,
    });
    await writeLaunchdManifest(paths.launchdManifestFile, manifest);
    console.log(
      JSON.stringify({ ok: true, profile: paths.profile, manifest: paths.launchdManifestFile, installed: false }),
    );
  });

program
  .command('status')
  .description('检查本地 runtime 的进程与飞书连接状态；不新建飞书或模型连接')
  .option('--profile <name>', 'profile 名称；省略时使用 active profile')
  .action(async (opts: ProfileOption) => {
    const paths = await managementPaths(opts);
    const local = await serviceController(paths).status();
    if (!local.running) {
      console.log(JSON.stringify(local));
      return;
    }
    try {
      console.log(JSON.stringify({ ...local, runtime: await runtimeControlStatus(paths) }));
    } catch (error) {
      console.log(
        JSON.stringify({
          ...local,
          runtime: { ready: false, error: error instanceof Error ? error.message : 'runtime control unavailable' },
        }),
      );
    }
  });

program
  .command('stop')
  .description('向本地前台 service 请求 SIGTERM；不连接飞书或模型')
  .option('--profile <name>', 'profile 名称；省略时使用 active profile')
  .action(async (opts: ProfileOption) => {
    const paths = await managementPaths(opts);
    await serviceController(paths).stop();
    console.log(JSON.stringify({ ok: true, profile: paths.profile }));
  });

program
  .command('paths')
  .description('打印当前 profile 的本地数据路径；不读取凭据')
  .option('--profile <name>', 'profile 名称；省略时使用 active profile')
  .action(async (opts: ProfileOption) => {
    console.log(JSON.stringify(await managementPaths(opts), null, 2));
  });

if (process.env.NODE_ENV !== 'test') {
  try {
    validatePublicCommandPath(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
  if (process.exitCode !== 1) {
    program.parseAsync().catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}

export function validatePublicCommandPath(argv: string[]): void {
  let current = program;
  let index = 0;
  while (current.commands.length) {
    while (index < argv.length) {
      const value = argv[index++]!;
      if (value === '--') {
        return;
      }
      if (current === program && (value === '--home' || value === '-h' || value === '--help')) {
        if (value === '--home') {
          index += 1;
        }
        continue;
      }
      if (current === program && (value === '-v' || value === '--version')) {
        continue;
      }
      if (value.startsWith('-')) {
        return;
      }
      const child = current.commands.find((candidate) => candidate.name() === value);
      if (!child) {
        throw new Error(`未知命令：${value}\n\n${current.helpInformation()}`);
      }
      current = child;
      break;
    }
    if (index >= argv.length || current.commands.length === 0) {
      return;
    }
  }
}

async function installProfileConfig(
  paths: AppPaths,
  current: RootConfig | undefined,
  root: RootConfig,
  appSecret: string,
): Promise<void> {
  const transactionId = `${process.pid}.${randomUUID()}`;
  const stagedSecretFile = `${paths.appSecretFile}.${transactionId}.staged`;
  const stagedConfigFile = `${paths.configFile}.${transactionId}.staged`;
  const previous = current?.profiles[paths.profile];
  let previousSecret: string | undefined;
  if (previous) {
    previousSecret = await resolveAppSecret(previous.accounts.app, paths.configFile, paths.profileDir);
  }
  await saveRootConfig(stagedConfigFile, root);
  await saveAppSecret(stagedSecretFile, appSecret);
  try {
    await rename(stagedSecretFile, paths.appSecretFile);
    try {
      await rename(stagedConfigFile, paths.configFile);
    } catch (error) {
      if (previousSecret !== undefined) {
        await saveAppSecret(paths.appSecretFile, previousSecret);
      } else {
        await rm(paths.appSecretFile, { force: true });
      }
      throw error;
    }
  } finally {
    await Promise.all([rm(stagedSecretFile, { force: true }), rm(stagedConfigFile, { force: true })]);
  }
}

async function selectedProfile(
  opts: ProfileOption,
): Promise<{ paths: AppPaths; profile: ReturnType<typeof createProfileConfig> }> {
  const paths = await managementPaths(opts);
  const config = await loadRootConfig(paths.configFile);
  if (!config) {
    throw new Error(`未找到配置：${paths.configFile}`);
  }
  const profile = config.profiles[paths.profile];
  if (!profile) {
    throw new Error(`profile 不存在：${paths.profile}`);
  }
  return { paths, profile };
}

async function managementPaths(opts: ProfileOption): Promise<AppPaths> {
  const rootDir = program.opts<GlobalOptions>().home;
  if (opts.profile) {
    return resolveAppPaths({ rootDir, profile: opts.profile });
  }
  const initial = resolveAppPaths({ rootDir });
  const config = await loadRootConfig(initial.configFile);
  return config ? resolveAppPaths({ rootDir, profile: config.activeProfile }) : initial;
}

function serviceController(paths: AppPaths): LocalServiceController {
  return new LocalServiceController(paths.profileLockFile, `${paths.runtimeDir}/service.pid`);
}

async function validateStoppedRuntimeConfig(
  paths: AppPaths,
  profile: ReturnType<typeof createProfileConfig>,
  piBin?: string,
): Promise<void> {
  await loadProfileRuntimeFingerprint(paths, profile);
  const agent = createRuntimeAgent(profile, paths, piBin);
  try {
    const available = await agent.checkAvailability?.();
    if (available && !available.ok) {
      throw available.error ?? new Error('Pi binary 不可用');
    }
  } finally {
    await agent.dispose?.().catch(() => {});
  }
}

function strings(values: string[] | undefined): string[] {
  return (values ?? []).filter((value) => value.trim()).map((value) => value.trim());
}

async function parseWorkspaceAliases(values: string[] | undefined): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      strings(values).map(async (value) => {
        const separator = value.indexOf('=');
        if (separator <= 0 || !value.slice(separator + 1).trim()) {
          throw new Error('--workspace-alias 应为 alias=/absolute/path');
        }
        const alias = validateWorkspaceAlias(value.slice(0, separator));
        const path = await canonicalWorkspaceDirectory(value.slice(separator + 1));
        return [alias, path];
      }),
    ),
  );
}

function booleanOption(value: string, option: string): boolean {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new Error(`${option} 只能是 true 或 false`);
}

function integerOption(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${option} 必须是整数`);
  }
  return parsed;
}

function accessMode(value: string, option: string): 'read-only' | 'full' {
  if (value === 'read-only' || value === 'full') {
    return value;
  }
  throw new Error(`${option} 只能是 read-only 或 full`);
}

function modelInput(value: string): Array<'text' | 'image'> {
  if (value === 'text') {
    return ['text'];
  }
  if (value === 'text,image') {
    return ['text', 'image'];
  }
  throw new Error('--input 只能是 text 或 text,image');
}

function compatibleApi(value: string): CompatiblePiApi {
  if (value === 'openai-completions' || value === 'openai-responses' || value === 'anthropic-messages') {
    return value;
  }
  throw new Error('--api 只能是 openai-completions、openai-responses 或 anthropic-messages');
}

function webPort(value: string): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error('--port 必须是 0 到 65535 的整数');
  }
  return port;
}

function serviceAction(value: string): ServiceAction {
  const actions: ServiceAction[] = [
    'install',
    'bootstrap',
    'start',
    'status',
    'stop',
    'restart',
    'enable',
    'disable',
    'recover',
    'uninstall',
  ];
  if (actions.includes(value as ServiceAction)) {
    return value as ServiceAction;
  }
  throw new Error(`未知 service action：${value}`);
}

function untilSignal(): { promise: Promise<void>; cancel(): void } {
  let done = (): void => {};
  const promise = new Promise<void>((resolve) => {
    done = (): void => {
      process.off('SIGINT', done);
      process.off('SIGTERM', done);
      resolve();
    };
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
  return {
    promise,
    cancel() {
      process.off('SIGINT', done);
      process.off('SIGTERM', done);
    },
  };
}
