import { describe, expect, it } from 'vitest';
import { buildMenuItems } from './page-header-actions';

describe('buildMenuItems', () => {
  it('空数组保持为空', () => {
    expect(buildMenuItems([])).toEqual([]);
  });

  it('过滤条件操作并保持原有顺序', () => {
    const first = { label: '随机看一部' };
    const last = { label: '搜索' };

    expect(buildMenuItems([first, undefined, last])).toEqual([
      { label: '随机看一部', disabled: false },
      { label: '搜索', disabled: false },
    ]);
  });

  it('保留禁用态', () => {
    expect(buildMenuItems([{ label: '导出诊断', disabled: true }])).toEqual([{ label: '导出诊断', disabled: true }]);
  });
});
