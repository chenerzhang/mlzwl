import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { ProfileWorkspaces } from '../config/profile-schema.js';

export type EffectiveWorkspace =
  | {
      ok: true;
      cwdRealpath: string;
      alias?: string;
      source: 'scope' | 'profile-default-alias' | 'profile-direct-default';
    }
  | { ok: false; message: string; alias?: string };

export interface WorkspaceEntryStatus {
  alias: string;
  available: boolean;
  isDefault: boolean;
  path?: string;
}

/** Resolve exactly the selected alias/default. It never falls back to another directory. */
export async function resolveEffectiveWorkspace(
  workspaces: ProfileWorkspaces,
  scopeAlias?: string,
): Promise<EffectiveWorkspace> {
  if (scopeAlias) {
    const configured = workspaces.named?.[scopeAlias];
    if (!configured) {
      return { ok: false, alias: scopeAlias, message: `workspace alias 不存在：${scopeAlias}` };
    }
    return resolveConfiguredWorkspace(configured, { alias: scopeAlias, source: 'scope' });
  }
  if (workspaces.defaultAlias) {
    const configured = workspaces.named?.[workspaces.defaultAlias];
    if (!configured) {
      return {
        ok: false,
        alias: workspaces.defaultAlias,
        message: `默认 workspace alias 不存在：${workspaces.defaultAlias}`,
      };
    }
    return resolveConfiguredWorkspace(configured, {
      alias: workspaces.defaultAlias,
      source: 'profile-default-alias',
    });
  }
  if (workspaces.defaultPath) {
    return resolveConfiguredWorkspace(workspaces.defaultPath, { source: 'profile-direct-default' });
  }
  return { ok: false, message: '尚未配置默认 workspace。' };
}

/** Inspect named aliases in stable order; callers may omit paths from remote output. */
export async function inspectWorkspaceRegistry(
  workspaces: ProfileWorkspaces,
  includePaths = false,
): Promise<WorkspaceEntryStatus[]> {
  return Promise.all(
    Object.entries(workspaces.named ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(async ([alias, path]) => ({
        alias,
        available: (await resolveConfiguredWorkspace(path, { alias, source: 'scope' })).ok,
        isDefault: workspaces.defaultAlias === alias,
        ...(includePaths ? { path } : {}),
      })),
  );
}

async function resolveConfiguredWorkspace(
  path: string,
  selection: { alias?: string; source: 'scope' | 'profile-default-alias' | 'profile-direct-default' },
): Promise<EffectiveWorkspace> {
  if (!isAbsolute(path)) {
    return {
      ok: false,
      ...(selection.alias ? { alias: selection.alias } : {}),
      message: selection.alias
        ? `workspace「${selection.alias}」配置无效：路径不是绝对路径。`
        : '默认 workspace 配置无效：路径不是绝对路径。',
    };
  }
  try {
    const cwdRealpath = await realpath(path);
    if (!(await stat(cwdRealpath)).isDirectory()) {
      throw new Error('not a directory');
    }
    return { ok: true, cwdRealpath, ...selection };
  } catch {
    return {
      ok: false,
      ...(selection.alias ? { alias: selection.alias } : {}),
      message: selection.alias ? `workspace「${selection.alias}」目录不可用。` : '默认 workspace 目录不可用。',
    };
  }
}
