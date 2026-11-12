/**
 * 「随机看一部」的错误文案（P2-5）。
 *
 * 抽成纯函数是为了能直接单测：失败分支的文案取自多种来源（网络错误、
 * 服务端 `no_random`、非 Error 的抛出值），写在 route 里就只能靠手工验证。
 *
 * **不 import `ApiError`**：`api-client.ts` 会记录前端事件、读取浏览器全局，
 * 从它引类会让本模块在 node 下不可直接测。`ApiError extends Error`，所以
 * `instanceof Error` 已经覆盖它，并且能拿到服务端给的 `message`。
 */
export function randomFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') {
    return error.message;
  }
  return '请稍后重试';
}
