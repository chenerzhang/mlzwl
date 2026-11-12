import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config/config.js';
import { describeListenTargets, isLoopbackHost, type NetworkInterfacesLike } from './listen-address.js';

const interfaces: NetworkInterfacesLike = {
  en0: [
    { address: '127.0.0.1', family: 'IPv4', internal: false },
    { address: '192.168.1.23', family: 'IPv4', internal: false },
    { address: '192.168.1.23', family: 4, internal: false },
    { address: 'fe80::1234', family: 'IPv6', internal: false },
  ],
  bridge0: [{ address: '10.0.0.8', family: 4, internal: false }],
  lo0: [{ address: '172.16.0.1', family: 'IPv4', internal: true }],
};

describe('isLoopbackHost', () => {
  it.each(['127.0.0.1', '127.0.0.53', '127.0.0.0', '127.255.255.255', 'localhost', 'LOCALHOST', '::1', '[::1]'])(
    'recognizes %s as loopback',
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  /*
   * 这些值必须判为非回环，否则会抑制启动时的安全警告。
   * `127.1` 和带尾随空格的 `127.0.0.1 ` 会被判为非回环（保守方向：多打一条警告），
   * 这里把它们固定为当前契约，将来若做归一化需同步改这些断言。
   */
  it.each([
    '0.0.0.0',
    '::',
    '10.0.0.5',
    '192.168.1.2',
    '126.255.255.255',
    '128.0.0.0',
    '127.0.0.256',
    '127.0.0.-1',
    '127.1',
    '127.0.0.1 ',
    '',
  ])('does not recognize %s as loopback', (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe('HOST default', () => {
  it('defaults to 0.0.0.0 so other devices on the network can reach the server', () => {
    expect(loadConfig({}).HOST).toBe('0.0.0.0');
  });

  it('still allows opting back into loopback-only', () => {
    expect(loadConfig({ HOST: '127.0.0.1' }).HOST).toBe('127.0.0.1');
    expect(loadConfig({ HOST: ' 127.0.0.1 ' }).HOST).toBe('127.0.0.1');
  });

  /*
   * 空串与纯空白都会被拒绝，而不是静默回退到默认值。
   * 静默回退会让「不小心把 HOST 设成空」变成「对全网开放」，
   * 这个方向上的错误必须在启动时直接暴露。
   */
  it.each(['', '   '])('rejects %j instead of listening on an invalid address', (host) => {
    expect(() => loadConfig({ HOST: host })).toThrow(/HOST/);
  });
});

describe('describeListenTargets', () => {
  it.each(['0.0.0.0', '::'])('expands wildcard %s to external IPv4 interfaces and appends loopback', (host) => {
    expect(describeListenTargets(host, 9133, interfaces)).toEqual({
      urls: ['http://192.168.1.23:9133', 'http://10.0.0.8:9133', 'http://127.0.0.1:9133'],
      openToLan: true,
    });
  });

  it('returns one LAN URL for a concrete LAN address', () => {
    expect(describeListenTargets('192.168.1.5', 9133, interfaces)).toEqual({
      urls: ['http://192.168.1.5:9133'],
      openToLan: true,
    });
  });

  it('returns one closed URL for a concrete IPv4 loopback address', () => {
    expect(describeListenTargets('127.0.0.1', 9133, interfaces)).toEqual({
      urls: ['http://127.0.0.1:9133'],
      openToLan: false,
    });
  });

  it('wraps a concrete IPv6 address in brackets', () => {
    expect(describeListenTargets('::1', 9133, interfaces)).toEqual({
      urls: ['http://[::1]:9133'],
      openToLan: false,
    });
    expect(describeListenTargets('2001:db8::1', 9133, interfaces)).toEqual({
      urls: ['http://[2001:db8::1]:9133'],
      openToLan: true,
    });
  });

  it('falls back to loopback when interfaces are empty', () => {
    expect(() => describeListenTargets('0.0.0.0', 9133, { en0: [], missing: undefined })).not.toThrow();
    expect(describeListenTargets('0.0.0.0', 9133, { en0: [], missing: undefined })).toEqual({
      urls: ['http://127.0.0.1:9133'],
      openToLan: true,
    });
  });
});
