// 同源转发器（哑转发）：浏览器里的 WASM SDK 负责签名，这里只做转发。
// 三条硬性要求见 docs/reverse-engineering.md 5.6：
//   1. 剥掉 content-encoding / content-length / transfer-encoding
//   2. 把 Set-Cookie 解析成 {name: value} 对象回传（SDK 只认这个形状）
//   3. 跨端口时返回 CORS 头
//
// 用法：node proxy.mjs [port]
// 前端：docs/reference/wasm-full.html 里的 transport 指向 http://127.0.0.1:<port>/proxy
import http from 'node:http';

const PORT = Number(process.argv[2] ?? 8902);

// 只放行这几个域名。放开等于把签名能力交给任意站点。
const ALLOW = [
  /(^|\.)fqnovel\.com$/,
  /(^|\.)snssdk\.com$/,
  /(^|\.)byteimg\.com$/,
  /(^|\.)fqnovelpic\.com$/,
  /(^|\.)qznovelvod\.com$/,
];

// 这些头描述的是「浏览器到转发器」这一段传输，不能透传。
const DROP_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection']);

function parseCookies(header) {
  const lines = header?.getSetCookie?.() ?? [];
  const cookies = {};
  for (const line of lines) {
    const pair = line.split(';', 1)[0];
    const at = pair.indexOf('=');
    if (at > 0) cookies[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
  }
  return cookies;
}

const srv = http.createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', '*');
  res.setHeader('access-control-allow-methods', 'POST,GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  if (!req.url.startsWith('/proxy')) return res.writeHead(404).end('not found');

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let payload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'bad json' }));
  }

  let target;
  try {
    target = new URL(payload.url);
  } catch {
    return res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'bad url' }));
  }
  if (!/^https?:$/.test(target.protocol) || !ALLOW.some((re) => re.test(target.hostname))) {
    return res
      .writeHead(403, { 'content-type': 'application/json' })
      .end(JSON.stringify({ error: 'host not allowed: ' + target.hostname }));
  }

  try {
    const upstream = await fetch(target.href, {
      method: payload.method ?? 'GET',
      headers: payload.headers ?? {},
      body: payload.body?.length ? Buffer.from(payload.body) : undefined,
      redirect: 'follow',
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    const headers = {};
    upstream.headers.forEach((value, name) => {
      if (!DROP_HEADERS.has(name)) headers[name] = value;
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({ status: upstream.status, headers, cookies: parseCookies(upstream.headers), body: [...body] }),
    );
  } catch (error) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(error?.message ?? error) }));
  }
});

srv.listen(PORT, () => console.log(`proxy on ${PORT}`));
