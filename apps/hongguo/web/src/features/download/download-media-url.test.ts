import { describe, expect, it } from 'vitest';
import {
  buildDownloadFilename,
  downloadDefinitionPlan,
  buildDownloadUrl,
  isDownloadableDefinition,
  pickHighestDefinition,
  resolveDownloadDefinition,
} from './download-media-url';

describe('isDownloadableDefinition', () => {
  it('accepts the labels the server schema accepts', () => {
    for (const definition of ['360p', '480p', '540p', '720p', '1080p', '1440p']) {
      expect(isDownloadableDefinition(definition)).toBe(true);
    }
  });

  it('rejects anything the server would 400 on', () => {
    // `unknown` 是上游没给档位时的映射值，拼进查询串会让整次下载失败。
    for (const definition of [undefined, '', 'unknown', '720P', '720', 'p720', '720p ', ' 720p', '72p']) {
      expect(isDownloadableDefinition(definition)).toBe(false);
    }
  });
});

describe('buildDownloadUrl', () => {
  it('appends the definition when valid', () => {
    expect(buildDownloadUrl('123', '720p')).toBe('/api/media/123?definition=720p');
  });

  it('omits the parameter when the definition is missing or invalid', () => {
    expect(buildDownloadUrl('123', undefined)).toBe('/api/media/123');
    expect(buildDownloadUrl('123', 'unknown')).toBe('/api/media/123');
  });

  it('encodes the episode id and never emits an upstream URL', () => {
    const url = buildDownloadUrl('a/b?c', '1080p');
    expect(url).toBe('/api/media/a%2Fb%3Fc?definition=1080p');
    expect(url.startsWith('/api/media/')).toBe(true);
    expect(url).not.toContain('http');
    expect(url).not.toContain('x-signature');
  });
});

describe('buildDownloadFilename', () => {
  it('suffixes the definition so two qualities do not overwrite each other', () => {
    expect(buildDownloadFilename('123', '720p')).toBe('123-720p.mp4');
    expect(buildDownloadFilename('123', '1080p')).toBe('123-1080p.mp4');
  });

  it('keeps the plain name when there is no usable definition', () => {
    expect(buildDownloadFilename('123', undefined)).toBe('123.mp4');
    expect(buildDownloadFilename('123', 'unknown')).toBe('123.mp4');
  });
});

describe('pickHighestDefinition', () => {
  it('takes the last entry because the server returns low to high', () => {
    expect(pickHighestDefinition(['360p', '720p', '1080p'])).toBe('1080p');
  });

  it('skips trailing labels the server would reject', () => {
    // `unknown` 排在最后时不能选它：拼进地址会让下载 400。
    expect(pickHighestDefinition(['360p', '720p', 'unknown'])).toBe('720p');
  });

  it('returns undefined when nothing usable is left', () => {
    expect(pickHighestDefinition([])).toBeUndefined();
    expect(pickHighestDefinition(['unknown'])).toBeUndefined();
  });
});

describe('resolveDownloadDefinition', () => {
  it('prefers the user choice when it exists in the list', () => {
    expect(resolveDownloadDefinition('480p', ['360p', '480p', '1080p'])).toBe('480p');
  });

  it('falls back to the highest available when the choice is gone', () => {
    expect(resolveDownloadDefinition('480p', ['360p', '720p', '1080p'])).toBe('1080p');
  });

  it('defaults to the highest available when the user never chose', () => {
    expect(resolveDownloadDefinition(undefined, ['360p', '720p', '1080p'])).toBe('1080p');
  });

  it('keeps an explicit choice when the list is unknown', () => {
    // 详情页还没拿到播放信息时不能把用户的选择丢掉。
    expect(resolveDownloadDefinition('720p', [])).toBe('720p');
  });

  it('returns undefined when there is nothing to pick', () => {
    expect(resolveDownloadDefinition(undefined, [])).toBeUndefined();
    expect(resolveDownloadDefinition('unknown', [])).toBeUndefined();
  });
});

describe('downloadDefinitionPlan', () => {
  const available = ['360p', '720p', '1080p'];

  it('blocks submission while the definition query is still pending', () => {
    // 档位没拿到时 `available` 为空，若放行就会下成服务端默认档（720p），
    // 与「默认最高档」的承诺不符。
    expect(downloadDefinitionPlan('pending', undefined, [])).toEqual({ definition: undefined, blocked: true });
    // 即使有偏好也不能放行：不知道这一集有没有该档。
    expect(downloadDefinitionPlan('pending', '1080p', [])).toEqual({ definition: undefined, blocked: true });
  });

  it('blocks submission when the definition query failed', () => {
    expect(downloadDefinitionPlan('error', undefined, [])).toEqual({ definition: undefined, blocked: true });
  });

  it('resolves the highest definition once ready', () => {
    expect(downloadDefinitionPlan('ready', undefined, available)).toEqual({ definition: '1080p', blocked: false });
    expect(downloadDefinitionPlan('ready', '360p', available)).toEqual({ definition: '360p', blocked: false });
    // 没有可用档位时仍可提交：交给服务端默认选档。
    expect(downloadDefinitionPlan('ready', undefined, [])).toEqual({ definition: undefined, blocked: false });
  });
});
