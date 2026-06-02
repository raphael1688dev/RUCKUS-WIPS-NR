import xml2js from 'xml2js';

export function parseUrl(raw) {
  const sep = raw.indexOf('://');
  const noScheme = sep === -1 ? raw : raw.slice(sep + 3);
  const slash = noScheme.indexOf('/');
  const authority = slash === -1 ? noScheme : noScheme.slice(0, slash);
  const pathAndQuery = slash === -1 ? '/' : noScheme.slice(slash);
  const colon = authority.indexOf(':');
  const hostname = colon === -1 ? authority : authority.slice(0, colon);
  const port = colon === -1 ? 443 : (parseInt(authority.slice(colon + 1), 10) || 443);
  return { hostname: hostname, port: port, pathAndQuery: pathAndQuery };
}

export function encodeParams(params) {
  return Object.keys(params).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(String(params[k])).replace(/%20/g, '+')).join('&');
}

export function dechunkBuf(buf) {
  const CRLF = String.fromCharCode(13, 10);
  const parts = [];
  let i = 0;
  while (i < buf.length) {
    const lineEnd = buf.indexOf(CRLF, i);
    if (lineEnd === -1) break;
    let sizeStr = buf.slice(i, lineEnd).toString('latin1').trim();
    const semi = sizeStr.indexOf(';');
    if (semi !== -1) sizeStr = sizeStr.slice(0, semi);
    const size = parseInt(sizeStr, 16);
    if (isNaN(size) || size <= 0) break;
    const dataStart = lineEnd + 2;
    parts.push(buf.slice(dataStart, dataStart + size));
    i = dataStart + size + 2;
  }
  return parts.length ? Buffer.concat(parts) : buf;
}

export function parseXml(xml) {
  return new Promise((resolve, reject) => {
    new xml2js.Parser({ explicitArray: false, mergeAttrs: true })
      .parseString(xml, (err, res) => err ? reject(err) : resolve(res));
  });
}

export function collectElements(node, tagName, acc) {
  if (!node || typeof node !== 'object') return acc;
  if (node[tagName] !== undefined) {
    const r = node[tagName];
    if (Array.isArray(r)) { for (const x of r) acc.push(x); } else { acc.push(r); }
  }
  const keys = Object.keys(node);
  for (let i = 0; i < keys.length; i++) {
    if (keys[i] === tagName) continue;
    const v = node[keys[i]];
    if (Array.isArray(v)) { for (const x of v) collectElements(x, tagName, acc); }
    else if (v && typeof v === 'object') collectElements(v, tagName, acc);
  }
  return acc;
}

export function findDone(node) {
  if (!node || typeof node !== 'object') return undefined;
  if (node.done !== undefined) return String(node.done);
  const keys = Object.keys(node);
  for (let i = 0; i < keys.length; i++) {
    const v = node[keys[i]];
    if (v && typeof v === 'object') { const d = findDone(v); if (d !== undefined) return d; }
  }
  return undefined;
}

export function pickStrongestDetection(detection) {
  if (!detection) return {};
  if (Array.isArray(detection)) {
    let best = detection[0] || {};
    let bestRssi = parseInt(best.rssi || '0', 10);
    for (const d of detection) {
      const r = parseInt(d?.rssi || '0', 10);
      if (r > bestRssi) { best = d; bestRssi = r; }
    }
    return best || {};
  }
  return detection;
}

export function normalizeRogue(rec) {
  const det = pickStrongestDetection(rec.detection);
  return {
    bssid: String(rec.mac || '').toLowerCase(),
    ssid: rec.ssid || '',
    channel: String(rec.channel || ''),
    radio_band: rec['radio-band'] || '',
    radio_type: rec['radio-type'] || rec['ieee80211-radio-type'] || '',
    encryption: rec['is-open'] || '',
    rogue_type: rec['rogue-type'] || '',
    blocked: String(rec.blocked || '').toLowerCase() === 'true',
    last_seen: parseInt(rec['last-seen'] || '0', 10),
    detection_ap: det['sys-name'] || '',
    detection_ap_location: det.location || '',
    detection_ap_mac: String(det.ap || '').toLowerCase(),
    rssi: parseInt(det.rssi || '0', 10),
  };
}
