export interface NetworkInterfaceInfoLike {
  address: string;
  family: string | number;
  internal: boolean;
}

export type NetworkInterfacesLike = Record<string, readonly NetworkInterfaceInfoLike[] | undefined>;

/** 判断监听主机是否只指向本机回环地址。 */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === 'localhost' || normalized === '::1' || normalized === '[::1]') {
    return true;
  }

  const octets = normalized.split('.');
  if (octets.length !== 4 || octets[0] !== '127') {
    return false;
  }
  return octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

function formatHost(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) {
    return host;
  }
  return host.includes(':') ? `[${host}]` : host;
}

export function describeListenTargets(
  host: string,
  port: number,
  interfaces: NetworkInterfacesLike,
): { urls: string[]; openToLan: boolean } {
  const openToLan = !isLoopbackHost(host);
  if (host !== '0.0.0.0' && host !== '::') {
    return { urls: [`http://${formatHost(host)}:${port}`], openToLan };
  }

  const urls = new Set<string>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (!entry.internal && (entry.family === 'IPv4' || entry.family === 4)) {
        urls.add(`http://${entry.address}:${port}`);
      }
    }
  }
  const loopbackUrl = `http://127.0.0.1:${port}`;
  urls.delete(loopbackUrl);
  urls.add(loopbackUrl);
  return { urls: [...urls], openToLan };
}
