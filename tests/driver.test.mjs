import test from 'node:test';
import assert from 'node:assert';
import tls from 'tls';
import xml2js from 'xml2js';
import zlib from 'zlib';

// 1. Mock Node-RED Globals in globalThis so they are accessible to imported modules
const mockEnvStore = {
  RUCKUS_HOST: 'ruckus.raphaelchen.org',
  RUCKUS_USER: 'admin',
  RUCKUS_PASS: 'test_pass',
  RUCKUS_ENABLE_UNBLOCK: 'true',
  RUCKUS_MQTT_BASE_TOPIC: 'ruckus_wips',
  RUCKUS_DEVICE_IDENTIFIER: 'ruckus_wips_main',
  RUCKUS_DEVICE_NAME: 'RUCKUS Unleashed WIPS',
  RUCKUS_DEVICE_MODEL: 'Unleashed WIPS (via Node-RED)'
};

const mockContextStore = {
  seenBssids: {},
  discoveryPublished: false,
  cookieJar: {},
  lockoutTimestamp: 0,
  failCount: 0,
  lastAvailability: 'online'
};

globalThis.env = {
  get: (key) => mockEnvStore[key]
};

globalThis.context = {
  get: (key) => mockContextStore[key],
  set: (key, val) => { mockContextStore[key] = val; }
};

const sentMessages = [];
globalThis.node = {
  send: (msg) => { sentMessages.push(msg); },
  error: (err, msg) => { console.error('[Mock Node Error]:', err, msg); },
  warn: (msg) => { console.warn('[Mock Node Warn]:', msg); },
  status: (statusObj) => { globalThis.node.lastStatus = statusObj; }
};

// Global xml2js and tls mapping to support bundled evaluation
globalThis.xml2js = xml2js;
globalThis.tls = tls;
globalThis.zlib = zlib;

// 2. Import modules to test dynamically after mock globals are set up
const { parseUrl, encodeParams, dechunkBuf, normalizeRogue } = await import('../src/utils.mjs');
const { cookieHeaderStr, saveCookies, rawReq } = await import('../src/http.mjs');
const { login, getActiveRogues, getBlockedRogues, markMalicious, unmarkMalicious } = await import('../src/api.mjs');
const { discoveryMessages } = await import('../src/discovery.mjs');
const { performPoll } = await import('../src/poll.mjs');

// 3. Setup mutable mock behavior for TLS socket
let mockResponseText = '';
let capturedRequest = '';

const originalConnect = tls.connect;
tls.connect = (options, connectCb) => {
  const socket = {
    write: (data) => {
      capturedRequest = data.toString();
      process.nextTick(() => {
        try {
          const response = typeof mockResponseText === 'function'
            ? mockResponseText(capturedRequest)
            : mockResponseText;
          if (socket.dataCb) {
            if (Buffer.isBuffer(response)) {
              socket.dataCb(response);
            } else {
              socket.dataCb(Buffer.from(response));
            }
          }
          if (socket.endCb) socket.endCb();
        } catch (e) {
          if (socket.errorCb) socket.errorCb(e);
        }
      });
    },
    on: (event, cb) => {
      if (event === 'data') socket.dataCb = cb;
      if (event === 'end') socket.endCb = cb;
      if (event === 'close') socket.closeCb = cb;
      if (event === 'error') socket.errorCb = cb;
    },
    setTimeout: (timeout, cb) => {},
    destroy: () => {}
  };
  if (connectCb) {
    process.nextTick(connectCb);
  }
  return socket;
};

// 4. Test Suite
test('parseUrl helper tests', () => {
  const res = parseUrl('https://192.168.88.181/admin/login.jsp');
  assert.strictEqual(res.hostname, '192.168.88.181');
  assert.strictEqual(res.port, 443);
  assert.strictEqual(res.pathAndQuery, '/admin/login.jsp');
});

test('encodeParams helper tests', () => {
  const params = { foo: 'bar', 'test name': 'hello world' };
  const encoded = encodeParams(params);
  assert.strictEqual(encoded, 'foo=bar&test%20name=hello+world');
});

test('dechunkBuf helper tests', () => {
  const CRLF = '\r\n';
  const chunked = Buffer.from(`4${CRLF}Wiki${CRLF}5${CRLF}pedia${CRLF}0${CRLF}${CRLF}`);
  const dechunked = dechunkBuf(chunked);
  assert.strictEqual(dechunked.toString(), 'Wikipedia');
});

test('normalizeRogue normalizes raw XML structures', () => {
  const raw = {
    mac: 'AA:BB:CC:DD:EE:FF',
    ssid: 'RogueAP',
    channel: '1',
    'radio-band': '2.4g',
    'radio-type': '802.11g/n',
    'is-open': 'Encrypted',
    'rogue-type': 'malicious AP',
    blocked: 'false',
    'last-seen': '1770000000',
    detection: {
      'sys-name': 'R720-1F',
      location: 'LIVING ROOM',
      ap: '80:03:84:1A:9E:30',
      rssi: '35'
    }
  };
  const normalized = normalizeRogue(raw);
  assert.strictEqual(normalized.bssid, 'aa:bb:cc:dd:ee:ff');
  assert.strictEqual(normalized.ssid, 'RogueAP');
  assert.strictEqual(normalized.blocked, false);
  assert.strictEqual(normalized.rssi, 35);
  assert.strictEqual(normalized.detection_ap_location, 'LIVING ROOM');
});

test('normalizeRogue picks strongest detection from array', () => {
  const raw = {
    mac: 'AA:BB:CC:DD:EE:FF',
    detection: [
      { 'sys-name': 'AP1', rssi: '20' },
      { 'sys-name': 'AP2', rssi: '45' },
      { 'sys-name': 'AP3', rssi: '10' }
    ]
  };
  const normalized = normalizeRogue(raw);
  assert.strictEqual(normalized.detection_ap, 'AP2');
  assert.strictEqual(normalized.rssi, 45);
});

test('saveCookies saves cookies and cookieHeaderStr outputs them', () => {
  mockContextStore.cookieJar = {};
  const headers = {
    'set-cookie': [
      'PHPSESSID=session123; path=/',
      'csrf_token=abc456; Secure'
    ]
  };
  saveCookies(headers);
  const ckHeader = cookieHeaderStr();
  assert.ok(ckHeader.includes('PHPSESSID=session123'));
  assert.ok(ckHeader.includes('csrf_token=abc456'));
});

test('discoveryMessages formats valid config payloads', () => {
  const msgs = discoveryMessages();
  assert.strictEqual(msgs.length, 4);
  const sensor = JSON.parse(msgs[0].payload);
  assert.strictEqual(sensor.unique_id, 'ruckus_wips_active');
  assert.strictEqual(sensor.device.identifiers[0], 'ruckus_wips_main');
  assert.strictEqual(sensor.device.name, 'RUCKUS Unleashed WIPS');
  assert.strictEqual(sensor.origin.name, 'ruckus_wips_nodered');
});

test('login and cmdstat flow testing', async () => {
  // Clear cookie jar
  mockContextStore.cookieJar = {};
  mockContextStore.loginUrl = null;

  let loginRound = 0;
  mockResponseText = (req) => {
    if (loginRound === 0) {
      loginRound++;
      return 'HTTP/1.0 302 Found\r\nLocation: /admin/login.jsp\r\n\r\n';
    } else {
      return 'HTTP/1.0 302 Found\r\nSet-Cookie: php_sess=sess999\r\nhttp_x_csrf_token: csrf111222\r\nLocation: /admin/main.jsp\r\n\r\n';
    }
  };

  await login();
  assert.strictEqual(mockContextStore.csrfToken, 'csrf111222');
  assert.strictEqual(mockContextStore.cookieJar['php_sess'], 'sess999');
});

test('getActiveRogues endpoint parses XML response correctly', async () => {
  mockResponseText = `HTTP/1.0 200 OK\r\nContent-Type: text/xml\r\n\r\n
<ajax-response>
  <response>
    <rogue mac="AA:BB:CC:DD:EE:FF" ssid="RogueAP1" channel="1" blocked="false">
      <detection sys-name="AP1" rssi="40"/>
    </rogue>
  </response>
</ajax-response>`;

  const rogues = await getActiveRogues();
  assert.strictEqual(rogues.length, 1);
  assert.strictEqual(rogues[0].mac, 'AA:BB:CC:DD:EE:FF');
});

test('markMalicious command sends valid XML request', async () => {
  mockResponseText = `HTTP/1.0 200 OK\r\nContent-Type: text/xml\r\n\r\n
<ajax-response>
  <response>
    <xmsg type="0" lmsg="Success"/>
  </response>
</ajax-response>`;

  capturedRequest = '';
  await markMalicious('aa:bb:cc:dd:ee:ff');
  assert.ok(capturedRequest.includes('blockrogue'));
  assert.ok(capturedRequest.includes("rogue='aa:bb:cc:dd:ee:ff'"));
});

test('gzip decoding in rawReq', async () => {
  const xmlData = '<response>ok</response>';
  const compressed = zlib.gzipSync(Buffer.from(xmlData));
  
  mockResponseText = (req) => {
    const headers = 'HTTP/1.0 200 OK\r\nContent-Type: text/xml\r\nContent-Encoding: gzip\r\nContent-Length: ' + compressed.length + '\r\n\r\n';
    return Buffer.concat([Buffer.from(headers), compressed]);
  };
  
  const res = await rawReq('get', 'https://192.168.88.181/test');
  assert.strictEqual(res.data, xmlData);
});

test('early socket resolution with Content-Length in rawReq', async () => {
  const xmlData = '<response>early</response>';
  mockResponseText = (req) => {
    return 'HTTP/1.0 200 OK\r\nContent-Length: ' + xmlData.length + '\r\n\r\n' + xmlData;
  };
  
  const res = await rawReq('get', 'https://192.168.88.181/test');
  assert.strictEqual(res.data, xmlData);
});

test('login incorrect triggers account lockout cooldown and changes reset it', async () => {
  mockResponseText = 'HTTP/1.0 200 OK\r\n\r\n';
  
  mockContextStore.lockoutTimestamp = 0;
  mockContextStore.lastUser = 'admin';
  mockContextStore.lastPass = 'test_pass';
  mockContextStore.lastHost = 'ruckus.raphaelchen.org';
  
  await assert.rejects(async () => {
    await login();
  }, /LOGIN_INCORRECT/);
  
  const lockoutTime = mockContextStore.lockoutTimestamp;
  assert.ok(lockoutTime > Date.now());
  
  await assert.rejects(async () => {
    await login();
  }, /Login is locked out/);
  
  // Changing password should reset the lockout
  mockEnvStore.RUCKUS_PASS = 'new_test_pass';
  mockResponseText = 'HTTP/1.0 302 Found\r\nLocation: /admin/main.jsp\r\nSet-Cookie: php_sess=sess111\r\nhttp_x_csrf_token: csrf111\r\n\r\n';
  await login();
  assert.strictEqual(mockContextStore.lockoutTimestamp, 0);
  assert.strictEqual(mockContextStore.csrfToken, 'csrf111');
});

test('consecutive failures and MQTT availability online/offline sync in performPoll', async () => {
  mockContextStore.failCount = 0;
  mockContextStore.lastAvailability = 'online';
  mockContextStore.discoveryPublished = true;
  sentMessages.length = 0;
  
  mockResponseText = (req) => {
    throw new Error('TCP Connection Failed');
  };
  
  await assert.rejects(async () => {
    await performPoll();
  }, /TCP Connection Failed/);
  assert.strictEqual(mockContextStore.failCount, 1);
  assert.strictEqual(mockContextStore.lastAvailability, 'online');
  
  await assert.rejects(async () => {
    await performPoll();
  }, /TCP Connection Failed/);
  assert.strictEqual(mockContextStore.failCount, 2);
  
  await assert.rejects(async () => {
    await performPoll();
  }, /TCP Connection Failed/);
  assert.strictEqual(mockContextStore.failCount, 3);
  assert.strictEqual(mockContextStore.lastAvailability, 'offline');
  
  const offlineMsg = sentMessages.find(m => m[0] && m[0].topic === 'ruckus_wips/status');
  assert.ok(offlineMsg);
  assert.strictEqual(offlineMsg[0].payload, 'offline');
  
  mockResponseText = `HTTP/1.0 200 OK\r\nContent-Type: text/xml\r\n\r\n
<ajax-response>
  <response>
    <rogue mac="AA:BB:CC:DD:EE:FF" ssid="RogueAP1" channel="1" blocked="false">
      <detection sys-name="AP1" rssi="40"/>
    </rogue>
  </response>
</ajax-response>`;
  
  sentMessages.length = 0;
  await performPoll();
  assert.strictEqual(mockContextStore.failCount, 0);
  assert.strictEqual(mockContextStore.lastAvailability, 'online');
  
  const onlineMsg = sentMessages.find(m => m[0] && m[0].topic === 'ruckus_wips/status');
  assert.ok(onlineMsg);
  assert.strictEqual(onlineMsg[0].payload, 'online');
});

// Restore tls.connect just in case
test.after(() => {
  tls.connect = originalConnect;
});
