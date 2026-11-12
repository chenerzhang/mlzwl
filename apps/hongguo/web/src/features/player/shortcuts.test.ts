import { describe, expect, it, vi } from 'vitest';
import {
  bindingFor,
  DEFAULT_SHORTCUTS,
  findShortcutConflicts,
  handleShortcut,
  normalizeKey,
  type ShortcutContext,
} from './shortcuts';

/**
 * 快捷键的纯逻辑测试。
 *
 * `handleShortcut` 的入参只用到 `code` / `key` / `shiftKey` / `ctrlKey` / `metaKey` /
 * `altKey` / `target` / `preventDefault`，所以用一个最小对象代替真实
 * `KeyboardEvent`：模块不 import 期访问 `window`，测试不需要 jsdom。
 */

interface FakeKeyInit {
  code?: string;
  key?: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  target?: unknown;
}

function makeEvent(init: FakeKeyInit): KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> } {
  const event = {
    code: init.code ?? '',
    key: init.key ?? '',
    shiftKey: init.shiftKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    altKey: init.altKey ?? false,
    target: init.target ?? null,
    preventDefault: vi.fn(),
  };
  return event as unknown as KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> };
}

function makeContext(): ShortcutContext & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    togglePlay: () => calls.push('togglePlay'),
    seekBy: (delta) => calls.push(`seekBy:${delta}`),
    adjustVolume: (delta) => calls.push(`adjustVolume:${delta}`),
    toggleMute: () => calls.push('toggleMute'),
    toggleFullscreen: () => calls.push('toggleFullscreen'),
  };
}

describe('normalizeKey', () => {
  it('prefers event.code', () => {
    expect(normalizeKey({ code: 'KeyF', key: 'f' })).toBe('KeyF');
    expect(normalizeKey({ code: 'Space', key: ' ' })).toBe('Space');
    expect(normalizeKey({ code: 'ArrowLeft', key: 'ArrowLeft' })).toBe('ArrowLeft');
  });

  it('keeps the physical key even when the layout differs', () => {
    expect(normalizeKey({ code: 'KeyF', key: 'у' })).toBe('KeyF');
  });

  it('falls back to the lowercased key when code is empty', () => {
    expect(normalizeKey({ code: '', key: 'F' })).toBe('f');
    expect(normalizeKey({ code: '', key: 'ArrowRight' })).toBe('arrowright');
  });

  it('returns an empty string when both are missing', () => {
    expect(normalizeKey({ code: '', key: '' })).toBe('');
  });
});

describe('handleShortcut', () => {
  it('toggles playback on Space', () => {
    const context = makeContext();
    const event = makeEvent({ code: 'Space', key: ' ' });
    expect(handleShortcut(event, context)).toBe(true);
    expect(context.calls).toEqual(['togglePlay']);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('seeks 5 seconds with the arrow keys', () => {
    const context = makeContext();
    handleShortcut(makeEvent({ code: 'ArrowLeft', key: 'ArrowLeft' }), context);
    handleShortcut(makeEvent({ code: 'ArrowRight', key: 'ArrowRight' }), context);
    expect(context.calls).toEqual(['seekBy:-5', 'seekBy:5']);
  });

  it('seeks 15 seconds when Shift is held', () => {
    const context = makeContext();
    handleShortcut(makeEvent({ code: 'ArrowLeft', key: 'ArrowLeft', shiftKey: true }), context);
    handleShortcut(makeEvent({ code: 'ArrowRight', key: 'ArrowRight', shiftKey: true }), context);
    expect(context.calls).toEqual(['seekBy:-15', 'seekBy:15']);
  });

  it('falls back to the unshifted binding for Shift+Space', () => {
    const context = makeContext();
    const event = makeEvent({ code: 'Space', key: ' ', shiftKey: true });
    expect(handleShortcut(event, context)).toBe(true);
    expect(context.calls).toEqual(['togglePlay']);
  });

  it('adjusts the volume with the vertical arrows', () => {
    const context = makeContext();
    handleShortcut(makeEvent({ code: 'ArrowUp', key: 'ArrowUp' }), context);
    handleShortcut(makeEvent({ code: 'ArrowDown', key: 'ArrowDown' }), context);
    expect(context.calls).toEqual(['adjustVolume:0.05', 'adjustVolume:-0.05']);
  });

  it('toggles fullscreen on KeyF', () => {
    const context = makeContext();
    handleShortcut(makeEvent({ code: 'KeyF', key: 'f' }), context);
    expect(context.calls).toEqual(['toggleFullscreen']);
  });

  it('toggles mute on KeyM', () => {
    const context = makeContext();
    handleShortcut(makeEvent({ code: 'KeyM', key: 'm' }), context);
    expect(context.calls).toEqual(['toggleMute']);
  });

  it('ignores input and textarea targets', () => {
    const context = makeContext();
    const input = makeEvent({ code: 'Space', key: ' ', target: { tagName: 'INPUT' } });
    const textarea = makeEvent({ code: 'ArrowLeft', key: 'ArrowLeft', target: { tagName: 'TEXTAREA' } });
    expect(handleShortcut(input, context)).toBe(false);
    expect(handleShortcut(textarea, context)).toBe(false);
    expect(context.calls).toEqual([]);
    expect(input.preventDefault).not.toHaveBeenCalled();
  });

  it('ignores contenteditable targets', () => {
    const context = makeContext();
    const event = makeEvent({ code: 'Space', key: ' ', target: { tagName: 'DIV', isContentEditable: true } });
    expect(handleShortcut(event, context)).toBe(false);
    expect(context.calls).toEqual([]);
  });

  it('ignores modified key presses', () => {
    const context = makeContext();
    expect(handleShortcut(makeEvent({ code: 'KeyF', key: 'f', ctrlKey: true }), context)).toBe(false);
    expect(handleShortcut(makeEvent({ code: 'KeyF', key: 'f', metaKey: true }), context)).toBe(false);
    expect(handleShortcut(makeEvent({ code: 'KeyF', key: 'f', altKey: true }), context)).toBe(false);
    expect(context.calls).toEqual([]);
  });

  it('returns false for unbound keys without preventing default', () => {
    const context = makeContext();
    const event = makeEvent({ code: 'KeyQ', key: 'q' });
    expect(handleShortcut(event, context)).toBe(false);
    expect(context.calls).toEqual([]);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('falls back to event.key when code is missing', () => {
    const context = makeContext();
    expect(handleShortcut(makeEvent({ code: '', key: 'f' }), context)).toBe(true);
    expect(context.calls).toEqual(['toggleFullscreen']);
  });
});

describe('DEFAULT_SHORTCUTS', () => {
  it('covers the documented keys', () => {
    expect(Object.keys(DEFAULT_SHORTCUTS).sort()).toEqual([
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'ArrowUp',
      'KeyF',
      'KeyM',
      'Shift+ArrowLeft',
      'Shift+ArrowRight',
      'Space',
    ]);
  });
});

describe('bindingFor', () => {
  it('returns the plain binding without Shift', () => {
    expect(bindingFor({ code: 'ArrowLeft', key: 'ArrowLeft', shiftKey: false })).toEqual({
      action: 'seekBy',
      amount: -5,
    });
  });

  it('returns the longer step with Shift', () => {
    expect(bindingFor({ code: 'ArrowRight', key: 'ArrowRight', shiftKey: true })).toEqual({
      action: 'seekBy',
      amount: 15,
    });
  });

  it('falls back to the unshifted binding when there is no Shift variant', () => {
    expect(bindingFor({ code: 'KeyM', key: 'M', shiftKey: true })).toBe('toggleMute');
  });

  it('returns undefined for unbound keys', () => {
    expect(bindingFor({ code: 'KeyQ', key: 'q', shiftKey: false })).toBeUndefined();
  });
});

describe('findShortcutConflicts', () => {
  it('returns an empty list for a unique table', () => {
    expect(findShortcutConflicts({ play: 'Space', fullscreen: 'KeyF' })).toEqual([]);
  });

  it('reports keys bound to more than one action', () => {
    expect(findShortcutConflicts({ play: 'Space', fullscreen: 'KeyF', mute: 'KeyF' })).toEqual(['KeyF']);
  });

  it('reports every duplicated key once, sorted', () => {
    expect(findShortcutConflicts({ a: 'KeyF', b: 'KeyF', c: 'Space', d: 'Space', e: 'KeyM' })).toEqual([
      'KeyF',
      'Space',
    ]);
  });

  it('returns an empty list for an empty table', () => {
    expect(findShortcutConflicts({})).toEqual([]);
  });
});
