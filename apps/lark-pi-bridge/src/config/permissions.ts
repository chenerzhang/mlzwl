/**
 * Pi has no workspace sandbox. The bridge intentionally exposes only a
 * best-effort read-only tool allowlist and unrestricted full access.
 */
export type AccessMode = 'read-only' | 'full';

export interface PermissionConfig {
  defaultAccess: AccessMode;
  maxAccess: AccessMode;
}

const ORDER: Record<AccessMode, number> = { 'read-only': 0, full: 1 };

export function normalizePermissions(input: unknown): PermissionConfig {
  if (input === undefined) {
    return { defaultAccess: 'full', maxAccess: 'full' };
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('permissions must be an object');
  }
  const raw = input as Partial<PermissionConfig>;
  if (!isAccessMode(raw.defaultAccess) || !isAccessMode(raw.maxAccess)) {
    throw new Error('permissions.defaultAccess and permissions.maxAccess must be read-only or full');
  }
  if (ORDER[raw.defaultAccess] > ORDER[raw.maxAccess]) {
    throw new Error('permission defaultAccess cannot exceed maxAccess');
  }
  return { defaultAccess: raw.defaultAccess, maxAccess: raw.maxAccess };
}

export function clampAccess(
  defaultAccess: AccessMode,
  profileMax: AccessMode,
  capabilityMax: AccessMode = 'full',
): AccessMode {
  const max = ORDER[profileMax] < ORDER[capabilityMax] ? profileMax : capabilityMax;
  return ORDER[defaultAccess] <= ORDER[max] ? defaultAccess : max;
}

export function isAccessMode(value: unknown): value is AccessMode {
  return value === 'read-only' || value === 'full';
}
