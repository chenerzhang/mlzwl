import { createHash } from 'node:crypto';
import type { AccessMode } from '../config/permissions.js';

export interface PolicyFingerprintInput {
  cwdRealpath: string;
  accessMode: AccessMode;
  profile: string;
  scopeId: string;
}

export function policyFingerprint(input: PolicyFingerprintInput): string {
  return createHash('sha256')
    .update(JSON.stringify({ version: 1, ...input }))
    .digest('base64url')
    .slice(0, 22);
}
