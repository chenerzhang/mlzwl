import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface LaunchdManifestInput {
  label: string;
  programArguments: string[];
  workingDirectory: string;
  standardOutPath: string;
  standardErrorPath: string;
}

/**
 * Renders a macOS user-agent plist without invoking launchctl. Installation and
 * loading remain a separately authorized service/E2E operation.
 */
export function renderLaunchdManifest(input: LaunchdManifestInput): string {
  if (!/^ai\.x-connect\.lark-pi-bridge\.[A-Za-z0-9._-]+$/.test(input.label)) {
    throw new Error('invalid launchd label');
  }
  if (!input.programArguments.length || input.programArguments.some((value) => !value)) {
    throw new Error('launchd programArguments are required');
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(input.label)}</string>
  <key>ProgramArguments</key>
  <array>
${input.programArguments.map((value) => `    <string>${xml(value)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(input.workingDirectory)}</string>
  <key>RunAtLoad</key>
  <false/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${xml(input.standardOutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(input.standardErrorPath)}</string>
</dict>
</plist>
`;
}

/** Write a private generated manifest only; this does not install, load, or start it. */
export async function writeLaunchdManifest(path: string, manifest: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, manifest, { mode: 0o600 });
}

function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
