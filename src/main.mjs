import { ENABLE_UNBLOCK, MQTT_BASE_TOPIC } from './config.mjs';
import { markMalicious, unmarkMalicious } from './api.mjs';
import { performPoll } from './poll.mjs';

// --- main: handle inbound message ----------------------------------------
const topic = (msg && msg.topic) || '';

// 1. Unified Command Processor (WIPS Only)
if (topic.startsWith('ruckus_wips/cmd/') || topic.startsWith('ruckus/cmd/') || topic.startsWith(`${MQTT_BASE_TOPIC}/cmd/`)) {
  let action = '';
  let commandPath = '';
  
  if (topic.startsWith(`${MQTT_BASE_TOPIC}/cmd/`)) {
    commandPath = `${MQTT_BASE_TOPIC}/cmd/`;
    action = topic.substring(commandPath.length);
  } else if (topic.startsWith('ruckus_wips/cmd/')) {
    commandPath = 'ruckus_wips/cmd/';
    action = topic.substring('ruckus_wips/cmd/'.length);
  } else {
    commandPath = 'ruckus/cmd/';
    action = topic.substring('ruckus/cmd/'.length);
  }

  // Prevents infinite JSON stringify loops when the node subscribes to its own ACK topic.
  if (action === 'ack') {
    // Do nothing
  } else {
    const payloadRaw = (msg.payload === undefined || msg.payload === null) ? '' : msg.payload;
    const ackTopic = `${commandPath}ack`;
    const ackBase = { payload: payloadRaw, action, ts: Date.now() };

    try {
      if (action === 'mark_malicious') {
        const bssid = String(payloadRaw).trim().toLowerCase().replace(/-/g, ':');
        if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(bssid)) throw new Error('invalid BSSID');
        await markMalicious(bssid);
      } 
      else if (action === 'unmark_malicious') {
        if (!ENABLE_UNBLOCK) throw new Error('unmark disabled (set RUCKUS_ENABLE_UNBLOCK=true)');
        const bssid = String(payloadRaw).trim().toLowerCase().replace(/-/g, ':');
        if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(bssid)) throw new Error('invalid BSSID');
        await unmarkMalicious(bssid);
      } 
      else {
        throw new Error('unknown WIPS action: ' + action);
      }

      node.send([null, { topic: ackTopic, payload: JSON.stringify({ ...ackBase, ok: true }), retain: false, qos: 1 }]);
      await performPoll();
    } catch (err) {
      node.send([null, { topic: ackTopic, payload: JSON.stringify({ ...ackBase, ok: false, message: err.message || String(err) }), retain: false, qos: 1 }]);
      node.error('WIPS Command ' + action + ' failed: ' + (err.message || err), msg);
    }
  }
}
// 1b. Home Assistant Birth Message (Re-publish discovery on HA online status)
else if (topic === 'homeassistant/status') {
  if (String(msg.payload) === 'online') {
    context.set('discoveryPublished', false);
    try {
      await performPoll();
    } catch (err) {
      node.error('Failed to republish discovery on HA birth message: ' + (err.message || err));
    }
  }
}
// 1c. MQTT connection status changed (Re-publish discovery on connection)
else if (msg.status && (msg.status.text === 'node-red:common.status.connected' || (msg.status.text && msg.status.text.indexOf('connected') !== -1))) {
  context.set('discoveryPublished', false);
  try {
    await performPoll();
  } catch (err) {
    node.error('Failed to republish discovery on MQTT reconnect: ' + (err.message || err));
  }
}
// 2. Poll Router (WIPS Only)
else {
  try {
    await performPoll();
  } catch (err) {
    node.status({ fill: 'red', shape: 'ring', text: 'WIPS poll failed: ' + (err.message || err).toString().slice(0, 60) });
    node.error('WIPS Poll failed: ' + (err.stack || err.message || err), msg);
  }
}
