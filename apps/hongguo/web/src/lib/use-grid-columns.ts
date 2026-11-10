import { useEffect, useState } from 'react';

/**
 * 读出某个 grid 容器当前实际渲染成几列。
 *
 * 为什么不直接用 `matchMedia` 断点判断：断点是「设计意图」，实际列数由
 * `grid-template-columns` 决定。一旦以后改断点或加容器查询，手写映射就会
 * 和真实布局脱钩，骨架屏又会算错格子数。
 * `getComputedStyle().gridTemplateColumns` 返回的是已解析的轨道列表
 * （例如 `"197px 197px 197px"`），按空格切分就是真实列数。
 */
export function useGridColumns(ref: React.RefObject<HTMLElement | null>, fallback = 2): number {
  const [columns, setColumns] = useState(fallback);

  useEffect(() => {
    const element = ref.current;
    if (element === null) {
      return;
    }

    const measure = (): void => {
      const value = getComputedStyle(element).gridTemplateColumns;
      if (value === '' || value === 'none') {
        return;
      }
      const count = value.trim().split(/\s+/).length;
      setColumns((previous) => (previous === count ? previous : count));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [ref]);

  return columns;
}
