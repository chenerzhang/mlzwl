/** TanStack Query 的键。集中管理，避免拼写漂移导致缓存失效。 */
export const queryKeys = {
  feed: () => ['feed'] as const,
  search: (keyword: string) => ['search', keyword] as const,
  rankingCatalog: () => ['ranking', 'catalog'] as const,
  ranking: (content: string | undefined, board: string | undefined) => ['ranking', content ?? '', board ?? ''] as const,
  series: (id: string) => ['series', id] as const,
  playback: (episodeId: string, definition?: string) =>
    definition === undefined ? (['playback', episodeId] as const) : (['playback', episodeId, definition] as const),
  sprite: (episodeId: string) => ['sprite', episodeId] as const,
};
