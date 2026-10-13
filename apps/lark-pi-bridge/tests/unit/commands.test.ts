import { describe, expect, it } from 'vitest';
import { parseBridgeCommand } from '../../src/commands/index.js';

describe('bridge commands', () => {
  it.each([
    ['/new', { type: 'new' }],
    ['/resume', { type: 'resume' }],
    ['/status', { type: 'status' }],
    ['/stop', { type: 'stop' }],
    ['/steer change direction', { type: 'steer', prompt: 'change direction' }],
    ['/follow-up summarize after', { type: 'follow-up', prompt: 'summarize after' }],
    ['/followup summarize alias', { type: 'follow-up', prompt: 'summarize alias' }],
    ['/timeout 15', { type: 'timeout', minutes: 15 }],
    ['/access read-only', { type: 'access', accessMode: 'read-only' }],
    ['/access full', { type: 'access', accessMode: 'full' }],
    ['/pi commands', { type: 'pi-commands' }],
    ['/pi /plan a  b', { type: 'pi-command', command: '/plan a  b', name: 'plan' }],
    ['/pi   /plan a  b', { type: 'pi-command', command: '/plan a  b', name: 'plan' }],
    ['/pi /skill:review target', { type: 'pi-command', command: '/skill:review target', name: 'skill:review' }],
    ['/workspace', { type: 'workspace-current' }],
    ['/workspace current', { type: 'workspace-current' }],
    ['/workspace list', { type: 'workspace-list' }],
    ['/workspace use repo', { type: 'workspace-use', alias: 'repo' }],
    ['/workspace use default', { type: 'workspace-use' }],
    ['/workspace default get', { type: 'workspace-default-get' }],
    ['/workspace default set repo', { type: 'workspace-default-set', alias: 'repo' }],
  ])('parses %s', (input, expected) => {
    expect(parseBridgeCommand(input)).toEqual(expected);
  });

  it('intercepts malformed and unknown slash commands instead of forwarding them as prompts', () => {
    for (const input of [
      '/timeout 0',
      '/timeout NaN',
      '/new extra',
      '/access admin',
      '/steer',
      '/follow-up',
      '/workspace use',
      '/workspace unknown',
      '/pi',
      '/pi plan',
      '/pi /',
      '/totally-unknown',
    ]) {
      expect(parseBridgeCommand(input)).toMatchObject({ type: 'invalid' });
    }
    expect(parseBridgeCommand('normal prompt')).toBeUndefined();
  });
});
