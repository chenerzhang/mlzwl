import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useHistoryStore } from '../features/history/history-store';
import { exportDiagnostics } from '../features/diagnostics/export-diagnostics';
import { api } from '../lib/api-client';
import { snapshot } from '../lib/client-events';
import { HeaderTextButton, PageHeader, SHELL_WIDTH, type PageHeaderAction } from '../components/page-header';

/** 导出结果提示的展示时长：5 秒后自动收起。 */
const EXPORT_MESSAGE_MS = 5_000;

/** 「导出诊断」按钮的状态机。`idle` 时按钮可用、不显示提示。 */
type ExportState = 'idle' | 'pending' | 'ok' | 'error';

/** 观看历史。按最近更新时间排序。 */
export function HistoryRoute(): React.JSX.Element {
  const navigate = useNavigate();
  const entries = useHistoryStore((state) => state.entries);
  const remove = useHistoryStore((state) => state.remove);
  const clear = useHistoryStore((state) => state.clear);

  /**
   * 「导出诊断」（P1-19）。
   *
   * 放在历史页而不是首页：首页顶栏已经有随机 / 历史 / 搜索三个入口，再塞一个
   * 会拥挤；而历史页是排障时用户最容易到达、且顶栏最空的页面。
   *
   * 状态与文案分开存：`exportState` 控制按钮禁用与提示条是否显示，
   * `exportMessage` 只负责文案。合成一个联合类型会让提示条的渲染条件变复杂。
   */
  const [exportState, setExportState] = useState<ExportState>('idle');
  const [exportMessage, setExportMessage] = useState<string | null>(null);

  /**
   * 结果提示 5 秒后自动收起。
   *
   * 依赖里只看 `exportState`：`ok` / `error` 才需要计时，`pending` 与 `idle`
   * 直接返回。卸载时清掉定时器，否则快速切页后 `setState` 会打到已卸载组件上。
   */
  useEffect(() => {
    if (exportState !== 'ok' && exportState !== 'error') {
      return undefined;
    }
    const timer = setTimeout(() => {
      setExportState('idle');
      setExportMessage(null);
    }, EXPORT_MESSAGE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [exportState]);

  /**
   * 收集并导出诊断信息。
   *
   * 环境信息在这里从真实全局对象读一次，然后整条流程交给可测的
   * `exportDiagnostics`——纯逻辑层不碰 `window` / `navigator`。
   */
  const handleExport = async (): Promise<void> => {
    // 禁用只挡住鼠标点击，连点仍可能在两帧之间入队，这里再挡一次。
    if (exportState === 'pending') {
      return;
    }
    setExportState('pending');
    setExportMessage(null);
    const result = await exportDiagnostics({
      now: () => new Date().toISOString(),
      userAgent: navigator.userAgent,
      language: navigator.language,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      route: window.location.pathname,
      events: snapshot(),
      fetchDiagnostics: () => api.diagnostics(),
      fetchHealth: () => api.health(),
      writeClipboard: (text) => navigator.clipboard.writeText(text),
    });
    if (result.ok) {
      setExportState('ok');
      setExportMessage('诊断信息已复制到剪贴板');
      return;
    }
    setExportState('error');
    setExportMessage(`复制失败：${result.error ?? '未知错误'}`);
  };

  const list = Object.values(entries).sort((a, b) => b.updatedAt - a.updatedAt);

  /**
   * 顶栏操作显式标注为 `PageHeaderAction[]`。
   *
   * `exactOptionalPropertyTypes` 下，「清空」按条件出现会让字面量数组推断成
   * `disabled?: never` 的联合类型，与 `PageHeaderAction` 的 `disabled?: boolean`
   * 冲突。这里先声明目标类型再填充，避免在 JSX 属性里堆类型断言。
   */
  const headerActions: PageHeaderAction[] = [];
  if (list.length > 0) {
    headerActions.push({
      label: '清空',
      onClick: clear,
      // 垃圾桶：清空是破坏性操作，图标要能一眼看出后果。
      icon: (
        <svg viewBox="0 0 24 24" aria-hidden className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.8}>
          <path d="M4 7h16" strokeLinecap="round" />
          <path d="M9.5 7V5.2A1.2 1.2 0 0110.7 4h2.6a1.2 1.2 0 011.2 1.2V7" strokeLinecap="round" />
          <path d="M6.2 7l.85 11.6A1.9 1.9 0 008.94 20.5h6.12a1.9 1.9 0 001.89-1.9L17.8 7" strokeLinecap="round" />
        </svg>
      ),
    });
  }
  headerActions.push({
    label: '导出诊断',
    disabled: exportState === 'pending',
    // 向下箭头入托盘：与「清空」区分开，同时表达「取出信息」。
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.8}>
        <path d="M12 3.5v10" strokeLinecap="round" />
        <path d="M8.2 10.2L12 14l3.8-3.8" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M4.5 16.5v2.2A1.8 1.8 0 006.3 20.5h11.4a1.8 1.8 0 001.8-1.8v-2.2" strokeLinecap="round" />
      </svg>
    ),
    onClick: () => {
      void handleExport();
    },
  });

  return (
    <div className={`mx-auto w-full ${SHELL_WIDTH} pb-24`}>
      <PageHeader
        left={
          <HeaderTextButton
            label="返回"
            onClick={() => {
              void navigate(-1);
            }}
          >
            返回
          </HeaderTextButton>
        }
        title="观看历史"
        actions={headerActions}
      />

      {/*
        导出结果就地提示：toast 会被 sticky 顶栏遮住，且自动消失后用户不知道刚才那一下
        成没成。外层只负责与列表一致的水平内边距，提示块复用首页 / 详情页的错误块样式。
      */}
      {exportState !== 'idle' && (
        <div className="px-3 pt-3 sm:px-5">
          <div className="mb-3 rounded-xl bg-surface-raised p-4 text-sm text-text-secondary ring-1 ring-border-subtle">
            {exportState === 'pending' ? '正在收集诊断信息…' : exportMessage}
          </div>
        </div>
      )}

      {list.length === 0 && (
        <p className="px-3 pt-20 text-center text-[13px] text-text-secondary sm:px-5">还没有观看记录</p>
      )}

      <ul className="grid grid-cols-1 gap-2 px-3 pt-4 sm:px-5 md:grid-cols-2 xl:grid-cols-3">
        {list.map((entry) => {
          const progress = entry.duration > 0 ? Math.min(entry.position / entry.duration, 1) : 0;
          return (
            <li
              key={entry.seriesId}
              className="group flex gap-3 overflow-hidden rounded-lg bg-surface-raised transition-colors hover:bg-surface-overlay"
            >
              <button
                type="button"
                onClick={() => {
                  void navigate(`/watch/${entry.episodeId}?series=${entry.seriesId}`);
                }}
                className="flex min-w-0 flex-1 gap-3 p-2 text-left"
              >
                {entry.coverUrl !== undefined ? (
                  <img
                    src={entry.coverUrl}
                    alt={entry.seriesTitle}
                    className="h-20 w-15 flex-none rounded-md object-cover"
                  />
                ) : (
                  <div className="h-20 w-15 flex-none rounded-md bg-surface-overlay" />
                )}
                <div className="flex min-w-0 flex-1 flex-col justify-center">
                  <p className="truncate text-[13px] font-medium tracking-tight text-text-primary">
                    {entry.seriesTitle}
                  </p>
                  <p className="mt-1 text-[11px] tabular-nums text-text-tertiary">第 {entry.episodeNumber} 集</p>
                  <div className="mt-2.5 flex items-center gap-2">
                    <div className="h-0.5 flex-1 overflow-hidden rounded-full bg-border-subtle">
                      <div
                        className="h-full rounded-full bg-accent"
                        style={{ width: `${Math.round(progress * 100)}%` }}
                      />
                    </div>
                    <span className="flex-none text-[10px] tabular-nums text-text-tertiary">
                      {Math.round(progress * 100)}%
                    </span>
                  </div>
                </div>
              </button>
              <button
                type="button"
                onClick={() => remove(entry.seriesId)}
                aria-label="删除记录"
                className="flex w-11 flex-none items-center justify-center self-stretch text-text-tertiary transition-colors hover:text-text-primary"
              >
                <svg
                  viewBox="0 0 24 24"
                  aria-hidden
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
