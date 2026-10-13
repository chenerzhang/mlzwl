import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ManagedService,
  type CommandRunner,
  type ManagedServiceStatus,
  type ServicePlatform,
} from '../daemon/managed-service.js';

const MARKER = 'Managed-By: @mlzwl/lark-pi-bridge';

export interface OwnedServiceDescriptor {
  platform: ServicePlatform;
  profile: string;
  rootDir: string;
  nodePath: string;
  cliEntryPath: string;
  piBin: string;
  envPath: string;
  definitionPath: string;
  status: ManagedServiceStatus;
}

export interface ServiceInventoryOptions {
  platform?: ServicePlatform;
  userHome?: string;
  runner?: CommandRunner;
}

export async function discoverOwnedServices(options: ServiceInventoryOptions = {}): Promise<OwnedServiceDescriptor[]> {
  const platform = options.platform ?? nativePlatform();
  const userHome = options.userHome ?? homedir();
  const candidates = await definitionCandidates(platform, userHome);
  const services: OwnedServiceDescriptor[] = [];
  for (const definitionPath of candidates) {
    const content = await safeOwnedContent(definitionPath);
    if (!content) {
      continue;
    }
    const parsed = parseOwnedDefinition(platform, definitionPath, content);
    const manager = new ManagedService({
      ...parsed,
      definitionPath,
      userHome,
      runner: options.runner,
    });
    services.push({ ...parsed, definitionPath, status: await manager.status() });
  }
  return services.sort((left, right) => left.definitionPath.localeCompare(right.definitionPath));
}

export function managerForOwnedService(
  service: OwnedServiceDescriptor,
  overrides: { nodePath?: string; cliEntryPath?: string; runner?: CommandRunner; userHome?: string } = {},
): ManagedService {
  return new ManagedService({
    platform: service.platform,
    profile: service.profile,
    rootDir: service.rootDir,
    nodePath: overrides.nodePath ?? service.nodePath,
    cliEntryPath: overrides.cliEntryPath ?? service.cliEntryPath,
    piBin: service.piBin,
    envPath: service.envPath,
    definitionPath: service.definitionPath,
    runner: overrides.runner,
    userHome: overrides.userHome,
  });
}

export function parseOwnedDefinition(
  platform: ServicePlatform,
  definitionPath: string,
  content: string,
): Omit<OwnedServiceDescriptor, 'definitionPath' | 'status'> {
  if (!content.split('\n', 6).some((line) => line.includes(MARKER))) {
    throw new Error(`service definition is not owned: ${definitionPath}`);
  }
  const args =
    platform === 'darwin'
      ? parseXmlArguments(content)
      : platform === 'linux'
        ? parseQuotedLine(content, /^ExecStart=(.+)$/m, unescapeSystemd)
        : parsePowerShellArguments(content);
  const rootDir = argumentValue(args, '--home');
  const profile = argumentValue(args, '--profile');
  const piBin = argumentValue(args, '--pi-bin');
  if (args[2] !== '--home' || args[4] !== 'run' || args[5] !== '--profile' || args[7] !== '--pi-bin') {
    throw new Error(`owned service has an unsupported command shape: ${definitionPath}`);
  }
  const envPath =
    platform === 'darwin'
      ? xmlDecode(/<key>PATH<\/key><string>(.*?)<\/string>/s.exec(content)?.[1] ?? '')
      : platform === 'linux'
        ? (parseQuotedLine(content, /^Environment=(.+)$/m, unescapeSystemd)[0]?.replace(/^PATH=/, '') ?? '')
        : parsePowerShellPath(content);
  return {
    platform,
    profile,
    rootDir,
    nodePath: args[0]!,
    cliEntryPath: args[1]!,
    piBin,
    envPath,
  };
}

async function definitionCandidates(platform: ServicePlatform, userHome: string): Promise<string[]> {
  const directory =
    platform === 'darwin'
      ? join(userHome, 'Library', 'LaunchAgents')
      : platform === 'linux'
        ? join(userHome, '.config', 'systemd', 'user')
        : join(userHome, '.lark-pi-bridge', 'profiles');
  if (platform === 'win32') {
    const profiles = await readdir(directory, { withFileTypes: true }).catch(() => []);
    return profiles
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(directory, entry.name, 'runtime', 'lark-pi-bridge-service.ps1'));
  }
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const pattern = platform === 'darwin' ? /^ai\.x-connect\.lark-pi-bridge\..+\.plist$/ : /^lark-pi-bridge-.+\.service$/;
  return entries
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => join(directory, entry.name));
}

async function safeOwnedContent(path: string): Promise<string | undefined> {
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) {
      return undefined;
    }
    const canonical = await realpath(path);
    if (dirname(canonical) !== dirname(path)) {
      return undefined;
    }
    const content = await readFile(path, 'utf8');
    return content.includes(MARKER) ? content : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function parseXmlArguments(content: string): string[] {
  const body = /<key>ProgramArguments<\/key><array>(.*?)<\/array>/s.exec(content)?.[1];
  if (!body) {
    throw new Error('owned launchd definition is missing ProgramArguments');
  }
  return [...body.matchAll(/<string>(.*?)<\/string>/gs)].map((match) => xmlDecode(match[1]!));
}

function parseQuotedLine(content: string, pattern: RegExp, decode: (value: string) => string): string[] {
  const line = pattern.exec(content)?.[1];
  if (!line) {
    throw new Error(`owned service definition is missing ${pattern.source}`);
  }
  return [...line.matchAll(/"((?:\\.|[^"])*)"/g)].map((match) => decode(match[1]!));
}

function parsePowerShellArguments(content: string): string[] {
  const line = content.split('\n').find((value) => value.startsWith('& '));
  if (!line) {
    throw new Error('owned Windows launcher is missing command');
  }
  return [...line.matchAll(/'((?:''|[^'])*)'/g)].map((match) => match[1]!.replace(/''/g, "'"));
}

function parsePowerShellPath(content: string): string {
  const value = /^\$env:PATH = '((?:''|[^'])*)'$/m.exec(content)?.[1];
  if (value === undefined) {
    throw new Error('owned Windows launcher is missing PATH');
  }
  return value.replace(/''/g, "'");
}

function argumentValue(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) {
    throw new Error(`owned service definition is missing ${name}`);
  }
  return value;
}

function unescapeSystemd(value: string): string {
  return value.replace(/\\([\\"])/g, '$1').replace(/%%/g, '%');
}

function xmlDecode(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function nativePlatform(): ServicePlatform {
  if (process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32') {
    return process.platform;
  }
  throw new Error(`unsupported service platform: ${process.platform}`);
}
