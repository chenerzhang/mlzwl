import { describe, expect, it } from 'vitest';
import { judgePointerMotion, type ScreenPoint } from './pointer-motion';

/**
 * 指针移动去重的纯逻辑测试。
 *
 * 期望值全部手写常量，不用被测实现的规则反推：否则实现写错时测试会跟着一起错。
 */

describe('judgePointerMotion', () => {
  describe('首次事件（没有基准）', () => {
    it('reveals when the first event reports a non-zero movement', () => {
      const verdict = judgePointerMotion(null, { screenX: 100, screenY: 200, movementX: 5, movementY: -3 });
      expect(verdict).toEqual({ reveal: true, next: { x: 100, y: 200 } });
    });

    it('ignores a movement-less first event and keeps no baseline', () => {
      // 全屏切换补发的无位移事件：不能成为基准，也不能唤出控件。
      const verdict = judgePointerMotion(null, { screenX: 100, screenY: 200, movementX: 0, movementY: 0 });
      expect(verdict).toEqual({ reveal: false, next: null });
    });

    it('reveals when the movement fields are missing entirely', () => {
      // 浏览器不支持 movementX/movementY：宁可多唤出一次，也不吞掉真实移动。
      const verdict = judgePointerMotion(null, { screenX: 7, screenY: 8 });
      expect(verdict).toEqual({ reveal: true, next: { x: 7, y: 8 } });
    });

    it('reveals when only movementX is missing even though movementY is zero', () => {
      // 只要有一个字段缺失就不能判定「无位移」，否则会把这次移动吞掉。
      const verdict = judgePointerMotion(null, { screenX: 7, screenY: 8, movementY: 0 });
      expect(verdict).toEqual({ reveal: true, next: { x: 7, y: 8 } });
    });
  });

  describe('有基准（后续事件）', () => {
    const previous: ScreenPoint = { x: 100, y: 200 };

    it('ignores an event whose screen coordinates are unchanged and returns the same baseline object', () => {
      const verdict = judgePointerMotion(previous, { screenX: 100, screenY: 200 });
      expect(verdict.reveal).toBe(false);
      // 引用相等：每次返回新对象会让调用方误判成「基准变了」。
      expect(verdict.next).toBe(previous);
    });

    it('reveals when screenX changed', () => {
      const verdict = judgePointerMotion(previous, { screenX: 101, screenY: 200 });
      expect(verdict).toEqual({ reveal: true, next: { x: 101, y: 200 } });
    });

    it('reveals when screenY changed', () => {
      const verdict = judgePointerMotion(previous, { screenX: 100, screenY: 199 });
      expect(verdict).toEqual({ reveal: true, next: { x: 100, y: 199 } });
    });

    it('stays hidden when the screen coordinates repeat and movement is absent', () => {
      // 常见情形：全屏切换后浏览器补发的事件，两个字段都没实现。
      const verdict = judgePointerMotion(previous, { screenX: 100, screenY: 200 });
      expect(verdict.reveal).toBe(false);
      expect(verdict.next).toBe(previous);
    });

    it('stays hidden when the screen coordinates repeat and movement is explicitly zero', () => {
      const verdict = judgePointerMotion(previous, { screenX: 100, screenY: 200, movementX: 0, movementY: 0 });
      expect(verdict.reveal).toBe(false);
      expect(verdict.next).toBe(previous);
    });

    it('reveals when the screen coordinates repeat but movement is non-zero', () => {
      // `screenX`/`screenY` 不可信的环境（隐私模式、嵌入式 WebView 里恒为 0,0）：
      // 只看坐标会把首次唤出之后的每一次真实移动都吞掉，控件再也出不来。
      const verdict = judgePointerMotion(previous, { screenX: 100, screenY: 200, movementX: 4, movementY: 4 });
      expect(verdict.reveal).toBe(true);
      expect(verdict.next).toEqual({ x: 100, y: 200 });
    });

    it('reveals on movement alone when the screen coordinates are pinned at the origin', () => {
      // 恒为 `0,0` 的环境：基准也是 `0,0`，只能靠 movement 判定。
      const origin: ScreenPoint = { x: 0, y: 0 };
      const verdict = judgePointerMotion(origin, { screenX: 0, screenY: 0, movementX: -3, movementY: 0 });
      expect(verdict.reveal).toBe(true);
      expect(verdict.next).toEqual({ x: 0, y: 0 });
    });

    it('reveals when both coordinates change', () => {
      const verdict = judgePointerMotion(previous, { screenX: 0, screenY: 0 });
      expect(verdict).toEqual({ reveal: true, next: { x: 0, y: 0 } });
    });

    it('reveals when the baseline is a zero point and the pointer moves away from it', () => {
      // 0,0 是合法坐标，不能被当成「没有基准」。
      const origin: ScreenPoint = { x: 0, y: 0 };
      const verdict = judgePointerMotion(origin, { screenX: 0, screenY: 1 });
      expect(verdict).toEqual({ reveal: true, next: { x: 0, y: 1 } });
    });
  });
});
