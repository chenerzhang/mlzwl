import { describe, expect, it } from 'vitest';
import { program, validatePublicCommandPath } from '../../src/cli/index.js';

function command(...names: string[]) {
  let current = program;
  for (const name of names) {
    const next = current.commands.find((item) => item.name() === name);
    if (!next) {
      throw new Error(`missing command: ${names.join(' ')}`);
    }
    current = next;
  }
  return current;
}

describe('CLI public help hierarchy', () => {
  it('lists the required top-level and nested command groups', () => {
    expect(program.helpInformation()).toContain('config');
    expect(program.helpInformation()).toContain('update');
    expect(program.helpInformation()).toContain('默认 ~/.lark-pi-bridge');
    expect(command('profile').helpInformation()).toMatch(
      /list|status|pi-config-scope|mention-optional|transport|activate/,
    );
    expect(command('profile', 'mention-optional').helpInformation()).toMatch(/list|add|remove/);
    expect(command('profile', 'mention-optional', 'add').helpInformation()).toMatch(/<chat-id>|--profile/);
    expect(command('profile', 'pi-config-scope').helpInformation()).toMatch(/get|set/);
    expect(command('profile', 'pi-config-scope', 'get').helpInformation()).toContain('--profile');
    expect(command('profile', 'pi-config-scope', 'set').helpInformation()).toMatch(/<scope>|--profile/);
    expect(command('init').helpInformation()).toContain('--pi-config-scope');
    expect(command('init').helpInformation()).toMatch(/--transport[\s\S]*新 profile 默认 rpc/);
    expect(command('workspace').helpInformation()).toMatch(/list|set|remove|default/);
    expect(command('workspace', 'default').helpInformation()).toMatch(/get|set \[options\] <alias>/);
    expect(command('config').helpInformation()).toContain('refresh');
    expect(command('update').helpInformation()).toMatch(/公共 npm registry.*恢复.*service/s);
    expect(command('service').helpInformation()).toMatch(/install\|bootstrap\|start\|status\|stop/);
    expect(command('service').helpInformation()).toContain('install 写入定义');
    for (const item of program.commands) {
      expect(item.helpInformation(), `${item.name()} --help`).toContain(item.description().slice(0, 12));
    }
  });

  it('rejects an unknown command even when --help is present', () => {
    expect(() => validatePublicCommandPath(['does-not-exist', '--help'])).toThrow(/未知命令：[\s\S]*Usage:/);
    expect(() => validatePublicCommandPath(['workspace', 'does-not-exist', '--help'])).toThrow(
      /未知命令：[\s\S]*Usage:.*workspace/s,
    );
    expect(() => validatePublicCommandPath(['profile', 'pi-config-scope', 'unknown'])).toThrow(
      /未知命令：[\s\S]*get[\s\S]*set/,
    );
    expect(() => validatePublicCommandPath(['--home', '/tmp/home', 'workspace', 'list', '--help'])).not.toThrow();
    expect(() => validatePublicCommandPath(['init', '--profile', 'custom'])).not.toThrow();
    expect(() => validatePublicCommandPath(['workspace', 'set', 'alias', '/tmp/workspace'])).not.toThrow();
  });
});
