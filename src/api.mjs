import { CONFIG } from './config.mjs';
import { parseXml, collectElements, findDone } from './utils.mjs';
import { httpHead, httpGet, httpPost } from './http.mjs';

export async function discoverLoginUrl() {
  const r = await httpHead(`https://${CONFIG.HOST}/`);
  let loc = r.headers?.location;
  if (!loc) throw new Error('Discover: no Location header from https://' + CONFIG.HOST + '/');
  if (!loc.startsWith('http')) {
    loc = `https://${CONFIG.HOST}${loc.startsWith('/') ? '' : '/'}${loc}`;
  }
  const r2 = await httpHead(loc);
  if (r2.status === 302 && r2.headers?.location) {
    let loc2 = r2.headers.location;
    if (!loc2.startsWith('http')) {
      loc = `https://${CONFIG.HOST}${loc2.startsWith('/') ? '' : '/'}${loc2}`;
    } else {
      loc = loc2;
    }
  }
  const baseUrl = loc.substring(0, loc.lastIndexOf('/'));
  context.set('loginUrl', loc);
  context.set('baseUrl', baseUrl);
  context.set('cmdstatUrl', baseUrl + '/_cmdstat.jsp');
  return { loginUrl: loc, baseUrl };
}

export async function login() {
  const lastUser = context.get('lastUser');
  const lastPass = context.get('lastPass');
  const lastHost = context.get('lastHost');
  if (CONFIG.USER !== lastUser || CONFIG.PASS !== lastPass || CONFIG.HOST !== lastHost) {
    context.set('lockoutTimestamp', 0);
    context.set('lastUser', CONFIG.USER);
    context.set('lastPass', CONFIG.PASS);
    context.set('lastHost', CONFIG.HOST);
  }

  const lockout = context.get('lockoutTimestamp') || 0;
  if (Date.now() < lockout) {
    const minLeft = Math.ceil((lockout - Date.now()) / 60000);
    throw new Error(`Login is locked out due to previous credential failure. Cooldown remaining: ${minLeft} minutes.`);
  }

  let loginUrl = context.get('loginUrl');
  let baseUrl = context.get('baseUrl');
  if (!loginUrl) {
    ({ loginUrl, baseUrl } = await discoverLoginUrl());
  }

  const mask = (str) => {
    if (!str) return 'empty';
    if (str.length <= 2) return '*'.repeat(str.length);
    return str[0] + '*'.repeat(str.length - 2) + str[str.length - 1];
  };
  if (typeof node !== 'undefined') {
    node.warn(`[Ruckus Config Debug] HOST=${CONFIG.HOST}, USER=${CONFIG.USER}, PASS=${mask(CONFIG.PASS)} (length=${CONFIG.PASS.length})`);
  }

  const r = await httpHead(loginUrl, {
    params: { username: CONFIG.USER, password: CONFIG.PASS, ok: 'Log In' },
  });
  const loc = r.headers?.location || '';
  if (r.status === 200 || loc.indexOf('login.jsp') !== -1) {
    context.set('lockoutTimestamp', Date.now() + 10 * 60 * 1000); // 10 minutes lockout
    throw new Error('LOGIN_INCORRECT');
  }
  let token = null;
  if (r.headers) {
    for (const [k, v] of Object.entries(r.headers)) {
      if (k.toLowerCase().replace(/-/g, '_') === 'http_x_csrf_token') { token = v; break; }
    }
  }
  if (!token) {
    const tk = await httpGet(baseUrl + '/_csrfTokenVar.jsp');
    if (tk.status === 200 && typeof tk.data === 'string') {
      const m = tk.data.match(/=\s*["']([A-Za-z0-9]+)["']/);
      if (m) token = m[1];
    }
  }
  context.set('csrfToken', token);
}

export async function cmdstat(xml, _retried) {
  let url = context.get('cmdstatUrl');
  let token = context.get('csrfToken');
  if (!url) { await login(); url = context.get('cmdstatUrl'); token = context.get('csrfToken'); }
  const headers = { 'Content-Type': 'text/xml' };
  if (token) headers['X-CSRF-Token'] = token;
  const r = await httpPost(url, xml, { headers });
  if (r.status === 302) {
    if (_retried) throw new Error('Session redirect loop — bad credentials?');
    context.set('csrfToken', null);
    await login();
    return cmdstat(xml, true);
  }
  if (!r.data || r.data === '\n') throw new Error('Empty response from cmdstat');
  let xmlText = r.data;
  const lt = xmlText.indexOf('<');
  if (lt > 0) xmlText = xmlText.slice(lt);
  try {
    return await parseXml(xmlText);
  } catch (e) {
    if (!context.get('parseFailDump')) {
      context.set('parseFailDump', true);
      node.warn('Ruckus XML parse failed: ' + String(r.data).slice(0, 200));
    }
    throw e;
  }
}

export async function getActiveRogues() {
  const xml = "<ajax-request action='getstat' comp='stamgr' enable-gzip='0'>"
    + "<rogue LEVEL='1' recognized='!true'/></ajax-request>";
  const res = await cmdstat(xml);
  return collectElements(res, 'rogue', []);
}

export async function getRoguesPiecewise(filterAttr, updaterName) {
  const ts = Date.now();
  const rnd = Math.floor(9000 * Math.random()) + 1000;
  const reqId = `${updaterName}.${ts}`;
  const cleanupId = `${updaterName}.${ts}.${rnd}`;
  const pageSize = 100;
  const limit = 300;
  const out = [];
  let pid = 0;
  let start = 0;
  while (out.length < limit) {
    pid++;
    const remaining = Math.min(pageSize, limit - out.length);
    const xml = `<ajax-request action='getstat' comp='stamgr' enable-gzip='0' updater='${cleanupId}'>`
      + `<rogue sortBy='time' sortDirection='-1' LEVEL='1' ${filterAttr}/>`
      + `<pieceStat pid='${pid}' start='${start}' number='${remaining}' requestId='${reqId}' cleanupId='${cleanupId}'/>`
      + `</ajax-request>`;
    const res = await cmdstat(xml);
    const page = collectElements(res, 'rogue', []);
    for (const r of page) { out.push(r); start++; }
    const done = findDone(res);
    if (done === 'true' || page.length === 0) break;
  }
  return out;
}

export async function getBlockedRogues() {
  return getRoguesPiecewise("blocked='true'", 'brogue');
}

export async function markMalicious(bssid) {
  const xml = `<ajax-request action='docmd' xcmd='blockrogue' check-ability='10' comp='stamgr'>`
    + `<xcmd cmd='blockrogue' tag='rogue' rogue='${bssid}'/></ajax-request>`;
  const res = await cmdstat(xml);
  const xmsg = res?.['ajax-response']?.response?.xmsg;
  if (xmsg && String(xmsg.type || '0') !== '0') {
    throw new Error('Unleashed rejected blockrogue: ' + (xmsg.lmsg || JSON.stringify(xmsg)));
  }
}

export async function unmarkMalicious(bssid) {
  const xml = `<ajax-request action='docmd' xcmd='unblockrogue' check-ability='10' comp='stamgr'>`
    + `<xcmd cmd='unblockrogue' tag='rogue' rogue='${bssid}'/></ajax-request>`;
  const res = await cmdstat(xml);
  const xmsg = res?.['ajax-response']?.response?.xmsg;
  if (xmsg && String(xmsg.type || '0') !== '0') {
    throw new Error('Unleashed rejected unblockrogue: ' + (xmsg.lmsg || JSON.stringify(xmsg)));
  }
}
