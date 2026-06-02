// ============================================================================
//  Automated Test Driver for Ruckus WIPS Node-RED Bridge
//  Validates the raw logic of func.js within a mocked Node-RED sandbox.
//  Run via: node test_driver.js
// ============================================================================

const fs = require('fs');
const path = require('path');

// 1. Mock Node-RED Sandbox environment
const mockEnvStore = {
  RUCKUS_HOST: 'ruckus.raphaelchen.org',
  RUCKUS_USER: 'admin',
  RUCKUS_PASS: 'test_password',
  RUCKUS_ENABLE_UNBLOCK: 'true'
};

const mockContextStore = {};

const env = {
  get: (key) => mockEnvStore[key]
};

const context = {
  get: (key) => mockContextStore[key],
  set: (key, val) => { mockContextStore[key] = val; }
};

const sentMessages = [];
const node = {
  send: (msg) => { sentMessages.push(msg); },
  error: (err, msg) => { console.error('node.error called:', err, msg); },
  warn: (msg) => { console.warn('node.warn called:', msg); },
  status: (statusObj) => { console.log('node.status updated:', statusObj); }
};

// Mock xml2js & tls dependencies for local import if not installed
let xml2js;
try {
  xml2js = require('xml2js');
} catch (e) {
  xml2js = {
    Parser: class {
      parseString(xml, cb) { cb(null, {}); }
    }
  };
}

let tls;
try {
  tls = require('tls');
} catch (e) {
  tls = {
    connect: () => ({ on: () => {}, write: () => {}, setTimeout: () => {} })
  };
}

// 2. Load strictly the helper function definitions from func.js, discarding the main execution block
const funcCodeRaw = fs.readFileSync(path.join(__dirname, 'func.js'), 'utf8');
const separator = '// --- main: handle inbound message ----------------------------------------';
const funcCode = funcCodeRaw.substring(0, funcCodeRaw.indexOf(separator));

// Evaluate the helper functions in a sandbox environment
const runSandbox = new Function('env', 'context', 'node', 'xml2js', 'tls', 'msg', funcCode + '\nreturn { parseUrl, dechunkBuf, normalizeRogue, discoveryMessages };');

let sandboxExports;
try {
  sandboxExports = runSandbox(env, context, node, xml2js, tls, { topic: 'test' });
  console.log('✔ Sandbox compiled successfully.');
} catch (e) {
  console.error('❌ Failed to compile sandbox:', e);
  process.exit(1);
}

const { parseUrl, dechunkBuf, normalizeRogue, discoveryMessages } = sandboxExports;

  // 3. Test Cases
  console.log('\nRunning Test Suite...');

  // Test 1: parseUrl
  try {
    const p1 = parseUrl('https://192.168.88.181/admin/login.jsp');
    if (p1.hostname === '192.168.88.181' && p1.port === 443 && p1.pathAndQuery === '/admin/login.jsp') {
      console.log('✔ parseUrl basic test passed.');
    } else {
      throw new Error('Unexpected parseUrl output: ' + JSON.stringify(p1));
    }
  } catch (e) {
    console.error('❌ parseUrl test failed:', e.message);
    process.exit(1);
  }

  // Test 2: normalizeRogue
  try {
    const mockRawRogue = {
      mac: '00:11:22:33:44:55',
      ssid: 'Test AP',
      channel: '1',
      'radio-band': '2.4g',
      'radio-type': '802.11b/g/n',
      'is-open': 'Open',
      'rogue-type': 'malicious AP',
      blocked: 'false',
      'last-seen': '1780000000',
      detection: {
        'sys-name': 'R720-1F',
        location: 'LIVING ROOM',
        ap: '80:03:84:1A:9E:30',
        rssi: '45'
      }
    };
    const normalized = normalizeRogue(mockRawRogue);
    if (normalized.bssid === '00:11:22:33:44:55' && normalized.ssid === 'Test AP' && normalized.rssi === 45 && normalized.detection_ap_location === 'LIVING ROOM') {
      console.log('✔ normalizeRogue basic test passed.');
    } else {
      throw new Error('Unexpected normalizeRogue output: ' + JSON.stringify(normalized));
    }
  } catch (e) {
    console.error('❌ normalizeRogue test failed:', e.message);
    process.exit(1);
  }

  // Test 3: discoveryMessages
  try {
    const msgs = discoveryMessages();
    if (msgs.length === 4) {
      const sensorActive = JSON.parse(msgs[0].payload);
      if (sensorActive.unique_id === 'ruckus_wips_active' && sensorActive.device.name === 'RUCKUS Unleashed WIPS') {
        console.log('✔ discoveryMessages sensor configuration schema test passed.');
      } else {
        throw new Error('Unexpected discovery schema: ' + JSON.stringify(sensorActive));
      }
    } else {
      throw new Error('Expected 4 discovery messages, got ' + msgs.length);
    }
  } catch (e) {
    console.error('❌ discoveryMessages test failed:', e.message);
    process.exit(1);
  }

  console.log('\nAll validation smoke tests completed successfully!');
})();
