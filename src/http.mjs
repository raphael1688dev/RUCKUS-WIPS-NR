import tls from 'tls';
import { parseUrl, encodeParams, dechunkBuf } from './utils.mjs';

export function cookieHeaderStr() {
  const jar = context.get('cookieJar') || {};
  return Object.keys(jar).map((k) => `${k}=${jar[k]}`).join('; ');
}

export function saveCookies(headers) {
  const sc = headers && headers['set-cookie'];
  if (!sc) return;
  const jar = context.get('cookieJar') || {};
  for (const line of sc) {
    const pair = String(line).split(';')[0];
    const i = pair.indexOf('=');
    if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  context.set('cookieJar', jar);
}

export function rawReq(method, url, data, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const parsed = parseUrl(url);
    let path = parsed.pathAndQuery;
    if (opts.params) {
      const qs = encodeParams(opts.params);
      if (qs) path += (path.indexOf('?') === -1 ? '?' : '&') + qs;
    }
    const headers = Object.assign({}, opts.headers);
    const ck = cookieHeaderStr();
    if (ck) headers.Cookie = ck;
    headers.Host = parsed.hostname;
    headers.Connection = 'close';
    if (!headers['Accept-Encoding']) headers['Accept-Encoding'] = 'identity';
    let body = '';
    if (data !== undefined && data !== null && method !== 'head' && method !== 'get') {
      body = typeof data === 'string' ? data : String(data);
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const CRLF = String.fromCharCode(13, 10);
    let reqText = method.toUpperCase() + ' ' + path + ' HTTP/1.0' + CRLF;
    const hk = Object.keys(headers);
    for (let i = 0; i < hk.length; i++) reqText += hk[i] + ': ' + headers[hk[i]] + CRLF;
    reqText += CRLF + body;
    const chunks = [];
    let done = false;
    const socket = tls.connect({ host: parsed.hostname, port: parsed.port, servername: parsed.hostname, rejectUnauthorized: false }, () => {
      socket.write(reqText);
    });
    const finish = () => {
      if (done) return; done = true;
      try { socket.destroy(); } catch (e) {}
      const buf = Buffer.concat(chunks);
      const sep4 = String.fromCharCode(13, 10, 13, 10);
      const sep2 = String.fromCharCode(10, 10);
      let idx = buf.indexOf(sep4); let skip = 4;
      if (idx === -1) { idx = buf.indexOf(sep2); skip = 2; }
      const headText = (idx === -1 ? buf : buf.slice(0, idx)).toString('latin1');
      let bodyBuf = idx === -1 ? Buffer.alloc(0) : buf.slice(idx + skip);
      const lines = headText.split(String.fromCharCode(10));
      const statusLine = (lines.shift() || '').trim();
      const sp = statusLine.split(' ');
      const status = parseInt(sp[1], 10) ?? 0;
      const resHeaders = {};
      const setCookie = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const c = line.indexOf(':');
        if (c === -1) continue;
        const name = line.slice(0, c).trim().toLowerCase();
        const val = line.slice(c + 1).trim();
        if (name === 'set-cookie') setCookie.push(val);
        else if (resHeaders[name] !== undefined) resHeaders[name] += ', ' + val;
        else resHeaders[name] = val;
      }
      if (setCookie.length) resHeaders['set-cookie'] = setCookie;
      if ((resHeaders['transfer-encoding'] || '').toLowerCase().indexOf('chunked') !== -1) {
        bodyBuf = dechunkBuf(bodyBuf);
      }
      saveCookies(resHeaders);
      resolve({ status: status, headers: resHeaders, data: bodyBuf.toString('utf8') });
    };
    socket.on('data', (c) => chunks.push(c));
    socket.on('end', finish);
    socket.on('close', finish);
    socket.on('error', (e) => { if (!done) { done = true; reject(e); } });
    socket.setTimeout(15000, () => { if (!done) { try { socket.destroy(); } catch (e) {} finish(); } });
  });
}

export async function httpHead(url, opts) { return rawReq('head', url, undefined, opts); }
export async function httpGet(url, opts) { return rawReq('get', url, undefined, opts); }
export async function httpPost(url, data, opts) { return rawReq('post', url, data, opts); }
