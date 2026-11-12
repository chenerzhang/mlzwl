// 子路径导入的理由见 `definition-selection.ts`：走 barrel 会把 zod 打进首屏。
import { isRequestableDefinition } from '@mlzwl/hongguo-shared/definitions';

/**
 * 该档位能否作为 `/api/media/:id?definition=` 的值。
 *
 * 直接用 shared 的 `isRequestableDefinition`：播放、下载、服务端校验必须是
 * 同一条规则。这里曾单独写一份 `\d{3,4}p`，与播放器菜单的「任意非空标签」
 * 分叉，结果菜单能选 `unknown`、下载却会静默忽略它。
 */
export function isDownloadableDefinition(definition: string | undefined): definition is string {
  return definition !== undefined && isRequestableDefinition(definition);
}

/**
 * 构造单集下载地址。
 *
 * 只用同源路径，不接触任何上游地址，也不带签名。
 */
export function buildDownloadUrl(episodeId: string, definition: string | undefined): string {
  const base = `/api/media/${encodeURIComponent(episodeId)}`;
  if (!isDownloadableDefinition(definition)) {
    return base;
  }
  return `${base}?definition=${encodeURIComponent(definition)}`;
}

/**
 * 下载文件名。
 *
 * 带档位后缀：同一集用不同清晰度各存一份时，`123.mp4` 会互相覆盖。
 * 不带档位时保持旧名字，避免「我明明没选档位却多出一个后缀」。
 */
export function buildDownloadFilename(episodeId: string, definition: string | undefined): string {
  if (!isDownloadableDefinition(definition)) {
    return `${episodeId}.mp4`;
  }
  return `${episodeId}-${definition}.mp4`;
}

/**
 * 从可用档位里挑最高的一档。
 *
 * 服务端按「从低到高」返回，所以最后一个就是最高档。不能按数字解析标签：
 * 标签是上游给的字符串，可能是 `1080p`、`2k`、`4k`，写死数字解析会挑错。
 * 返回 `undefined` 表示没有可用档位，此时交给服务端默认选档。
 */
export function pickHighestDefinition(available: readonly string[]): string | undefined {
  for (let index = available.length - 1; index >= 0; index -= 1) {
    const candidate = available[index];
    if (candidate !== undefined && isDownloadableDefinition(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * 决定下载用哪一档。
 *
 * 优先级：用户为下载显式选的档位 > 可用档位里的最高档 > 服务端默认。
 *
 * 下载偏好与播放偏好分开存：用户可能想「在线看 480p 省流量，下载留 1080p」，
 * 把两者绑在一起会让他每次下载都得手动改回来。
 */
export function resolveDownloadDefinition(
  preferred: string | undefined,
  available: readonly string[],
): string | undefined {
  if (isDownloadableDefinition(preferred) && (available.length === 0 || available.includes(preferred))) {
    return preferred;
  }
  return pickHighestDefinition(available);
}

/**
 * 档位信息的就绪状态。
 *
 * 详情响应里没有清晰度，档位要单独查一次播放信息。查询未完成时 `available` 是
 * 空数组，`resolveDownloadDefinition` 会返回 `undefined`，请求就变成「不带
 * `definition`」——服务端按**默认档**（实测优先 720p）返回，而不是承诺的
 * 「默认最高档」。慢网下用户打开面板立刻点下载就会踩到。
 *
 * 所以提交前必须先确认档位信息就绪。
 */
export type DefinitionReadiness = 'pending' | 'error' | 'ready';

export interface DownloadDefinitionPlan {
  /** 实际要请求的档位；`undefined` 表示交给服务端默认选档。 */
  definition: string | undefined;
  /** 为 `true` 时不允许提交下载：档位还没拿到，此时提交会下错档。 */
  blocked: boolean;
}

/**
 * 把「档位就绪状态 + 用户偏好 + 可用档位」折算成提交计划。
 *
 * `pending` 与 `error` 都算阻塞：两种情况都没有可信的档位列表，静默按服务端
 * 默认档下载会与界面承诺的「默认最高档」不符。`error` 由界面提供重试入口。
 */
export function downloadDefinitionPlan(
  readiness: DefinitionReadiness,
  preferred: string | undefined,
  available: readonly string[],
): DownloadDefinitionPlan {
  if (readiness !== 'ready') {
    return { definition: undefined, blocked: true };
  }
  return { definition: resolveDownloadDefinition(preferred, available), blocked: false };
}
