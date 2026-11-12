// 必须走子路径导入：`@mlzwl/hongguo-shared` 的 barrel 会连带引入 zod schema，
// 首屏包会因此从 315 kB 涨到 400 kB（实测）。`./definitions` 是不依赖 zod 的纯模块。
import { isRequestableDefinition } from '@mlzwl/hongguo-shared/definitions';
import type { Playback } from '@mlzwl/hongguo-shared';

/**
 * 清晰度选择。
 *
 * 后端一直在 `Playback.availableDefinitions` 里返回可用档位，但前端从没消费过它，
 * `playback-error.ts` 的 `switch-definition` 动作还被降级成 `none`。这个模块只做
 * 纯逻辑：档位清洗、默认档选择、换集时的档位继承。UI 与请求由调用方负责。
 */

/**
 * 档位标签是否合法。
 *
 * 上游给的是 `1080p`、`720p` 这类标签，但也会出现 `unknown`（上游没给
 * `definition` 时服务端映射出来的值）。这里只要求「非空、不含控制字符、不超过
 * 32 字符」，不写死分辨率白名单：上游随时可能加档，写死会让新档位静默消失。
 *
 * 不用正则：含控制字符区间的正则会触发 ESLint 的 `no-control-regex`，
 * 而按码点判断更直白。
 */
export function isValidDefinitionLabel(label: string): boolean {
  if (label.length === 0 || label.length > 32) {
    return false;
  }
  for (const char of label) {
    const code = char.codePointAt(0) ?? 0;
    // 控制字符（含 DEL）会让按钮文字渲染异常，且不可能是真实档位。
    if (code < 0x20 || code === 0x7f) {
      return false;
    }
  }
  return true;
}

/**
 * 清洗可用档位列表，只保留**能真正请求**的档位。
 *
 * 三件事：丢掉非字符串与不合法标签、去掉首尾空白、去重且保持原顺序。
 * 保持顺序很重要——服务端按「从低到高」返回，UI 直接照这个顺序渲染，
 * 不排序才能让「默认档」始终是列表里的某一项。
 *
 * 用共享的 `isRequestableDefinition` 而不是本地规则：服务端
 * `PlaybackQuerySchema` 只接受 `\d{3,4}p`，而 `availableDefinitions` 里会出现
 * `unknown`（上游没给标签时的占位值）。若把它渲染成可点选项，用户点下去必然 400。
 * 「能选的档」必须等于「能请求的档」。
 */
export function normalizeDefinitions(raw: readonly unknown[] | undefined): string[] {
  if (raw === undefined) {
    return [];
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') {
      continue;
    }
    const label = item.trim();
    if (!isValidDefinitionLabel(label) || !isRequestableDefinition(label) || seen.has(label)) {
      continue;
    }
    seen.add(label);
    result.push(label);
  }
  return result;
}

/**
 * 是否应该显示清晰度选择器。
 *
 * 只有真正有多档时才显示。单档时显示一个「只有一项」的菜单只是噪音，
 * 空列表（上游没给）更是必须不显示。
 *
 * 入参必须是 `normalizeDefinitions` 的结果（只含可请求档位）：若拿原始
 * `availableDefinitions` 判断，`['720p', 'unknown']` 会显示菜单，但菜单里
 * 只有一项可点。
 */
export function shouldShowDefinitionPicker(available: readonly string[]): boolean {
  return available.length > 1;
}

export interface DefinitionChoice {
  /** 本次播放实际请求的档位；`undefined` 表示让服务端自动挑。 */
  requested: string | undefined;
  /** 是否因为用户记住的档位不存在而回退。 */
  fellBack: boolean;
}

/**
 * 决定本次播放请求哪一档。
 *
 * 优先级：用户记住的档位 > 服务端当前选定的档位 > 自动（`undefined`）。
 *
 * 记住的档位必须**存在于可用列表**才采用：换了一部剧之后旧档位可能不存在，
 * 直接发给服务端会 400，或者更糟——服务端静默返回别的档，UI 显示的却是旧档。
 */
export function chooseDefinition(
  preferred: string | undefined,
  available: readonly string[],
  current: string | undefined,
): DefinitionChoice {
  if (preferred !== undefined && available.includes(preferred)) {
    return { requested: preferred, fellBack: false };
  }
  // 记住的档位不存在：能沿用服务端当前档就沿用，避免无谓地重新解析播放地址。
  if (current !== undefined && available.includes(current)) {
    return { requested: current, fellBack: preferred !== undefined };
  }
  // 列表为空时交给服务端自动挑，不猜。
  return { requested: undefined, fellBack: preferred !== undefined };
}

/**
 * 是否必须**先**补一次档位请求，再挂载播放器。
 *
 * 首次进入一集时，`playback` 请求不带 `definition`，服务端按默认档返回。若用户
 * 记住的档位不是默认档，直接挂载播放器会先让浏览器去拉默认档整集媒体（服务端
 * 在响应前会 `await` 完整下载 + 解密），紧接着切档又拉一次目标档——同一集双倍
 * 上游流量与磁盘缓存。
 *
 * 所以这里在渲染期同步判断：需要二次选档时先不挂载播放器，等目标档的
 * `playback` 回来再挂。
 *
 * `alreadyRequested` 为真表示用户（或上一次自动选档）已经显式指定过档位，
 * 此时 `playback` 本身就是目标档，不需要再拦。
 */
export function shouldRequestBeforePlayback(
  preferred: string | undefined,
  available: readonly string[],
  current: string | undefined,
  alreadyRequested: boolean,
): boolean {
  if (alreadyRequested) {
    return false;
  }
  const choice = chooseDefinition(preferred, available, current);
  return choice.requested !== undefined && choice.requested !== current;
}

/**
 * 切换档位时是否要保留当前播放进度。
 *
 * 换档等于换一条媒体流，但用户看的是同一集，进度必须保留。
 * 唯一的例外是「还没开始播」（`position <= 0`）：此时从 0 开始即可，
 * 传 `currentTime = 0` 与不传等价，但显式返回 `undefined` 能让调用方少一次 seek。
 */
export function resumeTimeAfterSwitch(position: number, duration: number): number | undefined {
  if (!Number.isFinite(position) || !Number.isFinite(duration) || position <= 0) {
    return undefined;
  }
  // 已经播完（或超出片长）时从头开始：换档后停在片尾什么也看不到。
  if (duration > 0 && position >= duration) {
    return undefined;
  }
  return position;
}

/**
 * 从播放响应里取出「当前档位」与「可用档位」。
 *
 * 抽成函数是为了让「档位清洗」只有一处实现：`Playback` 来自网络，字段可能缺失
 * 或被旧版本服务端写成别的形态，所有消费方都走这里。
 */
/**
 * 一条「带集号的切档状态」是否对当前集生效。
 *
 * 两个条件同时成立才生效：集号相同，且这次切档还没被消费。
 *
 * 为什么需要第二个条件：`player-route` 换集时会清空切档状态，但清空是 effect，
 * 在渲染之后才跑。而「回到曾经切过档的集」这个场景里，状态是上一次访问留下的
 * 旧值——只看集号会把它当成新的切档意图，把播放器拽回旧位置并盖掉观看历史。
 *
 * @param state 记录的状态；`null` 表示没有
 * @param episodeId 当前集
 */
export function isSwitchStateForEpisode<T extends { episodeId: string }>(
  state: T | null | undefined,
  episodeId: string | undefined,
): state is T {
  if (state === null || state === undefined || episodeId === undefined || episodeId === '') {
    return false;
  }
  return state.episodeId === episodeId;
}

export function readDefinitions(playback: Pick<Playback, 'definition' | 'availableDefinitions'>): {
  current: string | undefined;
  available: string[];
} {
  const available = normalizeDefinitions(playback.availableDefinitions);
  const current = typeof playback.definition === 'string' ? playback.definition.trim() : '';
  return {
    // 当前档不在可用列表里时不报告它：否则 UI 会显示一个选不中的档位。
    current: available.includes(current) ? current : undefined,
    available,
  };
}
