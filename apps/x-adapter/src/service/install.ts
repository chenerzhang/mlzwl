import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDir, port } from '../config/env.js';

export type ServiceKind = 'launchd' | 'systemd';

export type CommandResult = {
  status: number | null;
  error?: Error;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
};

export type CommandRunner = (command: string, args: string[]) => CommandResult;

export type ServiceUninstallResult = {
  ok: true;
  kind: ServiceKind;
  path: string;
  removed: boolean;
  commands: string[];
  warnings: string[];
};

function xmlEscape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function launchdPlist({
  nodePath = process.execPath,
  scriptPath,
  daemonPort = port(),
}: {
  nodePath?: string;
  scriptPath: string;
  daemonPort?: number;
}): string {
  const logDir = path.join(dataDir(), 'logs');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.x-adapter</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(scriptPath)}</string>
    <string>__daemon__</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>X_ADAPTER_PORT</key><string>${daemonPort}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(`${logDir}/launchd.out.log`)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(`${logDir}/launchd.err.log`)}</string>
</dict>
</plist>
`;
}

export function systemdUnit({
  nodePath = process.execPath,
  scriptPath,
  daemonPort = port(),
}: {
  nodePath?: string;
  scriptPath: string;
  daemonPort?: number;
}): string {
  return `[Unit]
Description=x-adapter local model gateway
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${scriptPath} __daemon__
Environment=X_ADAPTER_PORT=${daemonPort}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
}

export function defaultServiceKind(): ServiceKind {
  return os.platform() === 'darwin' ? 'launchd' : 'systemd';
}

export function defaultServiceTarget(kind: ServiceKind): string {
  return kind === 'launchd'
    ? path.join(os.homedir(), 'Library', 'LaunchAgents', 'ai.x-adapter.plist')
    : path.join(os.homedir(), '.config', 'systemd', 'user', 'x-adapter.service');
}

export function writeServiceTemplate(kind: ServiceKind, scriptPath: string, outputPath?: string): string {
  const target = outputPath ?? defaultServiceTarget(kind);
  const content = kind === 'launchd' ? launchdPlist({ scriptPath }) : systemdUnit({ scriptPath });
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, content, { encoding: 'utf8', mode: 0o600 });
  return target;
}

export function serviceInstallInstructions(kind: ServiceKind, targetPath: string): string[] {
  if (kind === 'launchd') {
    return [`launchctl load ${targetPath}`, `launchctl list | grep x-adapter`];
  }
  return [
    'systemctl --user daemon-reload',
    `systemctl --user enable --now ${path.basename(targetPath)}`,
    `systemctl --user status ${path.basename(targetPath)}`,
  ];
}

export function serviceUninstallInstructions(kind: ServiceKind, targetPath: string): string[] {
  if (kind === 'launchd') {
    return [`launchctl unload ${targetPath}`, `rm -f ${targetPath}`];
  }
  return [
    `systemctl --user disable --now ${path.basename(targetPath)}`,
    `rm -f ${targetPath}`,
    'systemctl --user daemon-reload',
  ];
}

function defaultRunner(command: string, args: string[]): CommandResult {
  return spawnSync(command, args, { encoding: 'utf8' });
}

function commandText(command: string, args: string[]): string {
  return [command, ...args].join(' ');
}

function outputText(value: string | Buffer | null | undefined): string {
  return Buffer.isBuffer(value) ? value.toString('utf8') : (value ?? '');
}

function runBestEffort(runner: CommandRunner, command: string, args: string[]): string | null {
  let result: CommandResult;
  try {
    result = runner(command, args);
  } catch (error) {
    return `${commandText(command, args)} failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (result.error) {
    return `${commandText(command, args)} failed: ${result.error.message}`;
  }
  if (result.status === 0) {
    return null;
  }
  const details = (outputText(result.stderr) || outputText(result.stdout)).trim();
  return details
    ? `${commandText(command, args)} failed: ${details}`
    : `${commandText(command, args)} failed with status ${result.status ?? 'unknown'}`;
}

export function uninstallService(
  kind: ServiceKind,
  targetPath = defaultServiceTarget(kind),
  runner: CommandRunner = defaultRunner,
): ServiceUninstallResult {
  const warnings: string[] = [];
  const existed = fs.existsSync(targetPath);
  if (existed) {
    const warning =
      kind === 'launchd'
        ? runBestEffort(runner, 'launchctl', ['unload', targetPath])
        : runBestEffort(runner, 'systemctl', ['--user', 'disable', '--now', path.basename(targetPath)]);
    if (warning) {
      warnings.push(warning);
    }
  }
  fs.rmSync(targetPath, { force: true });
  if (kind === 'systemd' && existed) {
    const warning = runBestEffort(runner, 'systemctl', ['--user', 'daemon-reload']);
    if (warning) {
      warnings.push(warning);
    }
  }
  return {
    ok: true,
    kind,
    path: targetPath,
    removed: existed,
    commands: serviceUninstallInstructions(kind, targetPath),
    warnings,
  };
}
