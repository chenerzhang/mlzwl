import { describe, expect, it } from 'vitest';
import { channelPolicy } from '../../src/bot/channel.js';
import { createProfileConfig } from '../../src/config/profile-schema.js';

/** The channel receives SDK policy and repeats the application-level check. */
describe('channel policy input', () => {
  it('keeps personal DM and group access fail-closed in profile configuration', () => {
    const profile = createProfileConfig({
      app: { id: 'cli_test', secret: '${TEST_SECRET}', tenant: 'feishu' },
      access: {
        allowedUsers: ['ou_user'],
        allowedChats: ['oc_group'],
        mentionOptionalChats: [],
        admins: ['ou_admin'],
        requireMentionInGroup: true,
      },
    });
    expect(profile.mode).toBe('personal');
    expect(profile.access).toEqual({
      allowedUsers: ['ou_user'],
      allowedChats: ['oc_group'],
      mentionOptionalChats: [],
      admins: ['ou_admin'],
      requireMentionInGroup: true,
    });
    expect(channelPolicy(profile)).toEqual({
      dmMode: 'allowlist',
      dmAllowlist: ['ou_user', 'ou_admin'],
      groupAllowlist: ['oc_group'],
      requireMention: true,
      respondToMentionAll: false,
      botLoopGuard: { enabled: true, onTrip: 'reject' },
    });
  });

  it('moves mention enforcement into the bridge only when per-chat exceptions exist', () => {
    const profile = createProfileConfig({
      app: { id: 'cli_test', secret: '${TEST_SECRET}', tenant: 'feishu' },
      access: {
        allowedChats: ['oc_quiet', 'oc_active'],
        mentionOptionalChats: ['oc_active'],
        requireMentionInGroup: true,
      },
    });
    expect(channelPolicy(profile)).toMatchObject({
      groupAllowlist: ['oc_quiet', 'oc_active'],
      requireMention: false,
    });
  });
});
