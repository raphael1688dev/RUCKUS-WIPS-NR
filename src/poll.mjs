import { CONFIG } from './config.mjs';
import { normalizeRogue } from './utils.mjs';
import { getActiveRogues, getBlockedRogues } from './api.mjs';
import { discoveryMessages } from './discovery.mjs';

let activePollPromise = null;

export async function performPoll() {
  if (activePollPromise) {
    return activePollPromise;
  }

  activePollPromise = (async () => {
    const ts = Date.now();

    const lockout = context.get('lockoutTimestamp') || 0;
    if (Date.now() < lockout) {
      const minLeft = Math.ceil((lockout - Date.now()) / 60000);
      node.status({ fill: 'yellow', shape: 'ring', text: `Login locked (cooldown: ${minLeft}m)` });
      return;
    }

    try {
      // WIPS Polling
      const activeRaw = await getActiveRogues();
      const blockedRaw = await getBlockedRogues();

      const rogues = {};
      for (const r of activeRaw) {
        const n = normalizeRogue(r);
        if (!n.bssid) continue;
        rogues[n.bssid] = n;
      }
      for (const r of blockedRaw) {
        const n = normalizeRogue(r);
        if (!n.bssid) continue;
        if (!rogues[n.bssid]) rogues[n.bssid] = n;
      }
      const list = Object.values(rogues);
      const activeUnblocked = list.filter(r => !r.blocked);
      const blocked = list.filter(r => r.blocked);

      // Diff to fire new-rogue events (strictly active unblocked ones)
      let seen = context.get('seenBssids');
      const newOnes = [];
      if (!seen) {
        seen = {};
      }
      
      // Check for newly appeared active unblocked BSSIDs
      for (const r of activeUnblocked) {
        if (!seen[r.bssid]) {
          newOnes.push(r);
        }
      }
      
      // Re-create the seen list to consist strictly of currently active unblocked BSSIDs
      seen = {};
      for (const r of activeUnblocked) {
        seen[r.bssid] = true;
      }
      context.set('seenBssids', seen);

      // Reset failure count and publish online status if it changed
      context.set('failCount', 0);
      if (context.get('lastAvailability') !== 'online' || !context.get('discoveryPublished')) {
        node.send([{ topic: `${CONFIG.MQTT_BASE_TOPIC}/status`, payload: 'online', retain: true, qos: 1 }, null]);
        context.set('lastAvailability', 'online');
      }

      // First-run: publish Discovery configs
      if (!context.get('discoveryPublished')) {
        for (const m of discoveryMessages()) node.send([m, null]);
        context.set('discoveryPublished', true);
      }

      // Publish WIPS state topics
      const stateMsg = (suffix, count, rogues) => ({
        topic: `${CONFIG.MQTT_BASE_TOPIC}/state/${suffix}`,
        payload: JSON.stringify({ count, last_updated: ts, rogues }),
        retain: true,
        qos: 1,
      });
      node.send([stateMsg('active',  activeUnblocked.length, activeUnblocked), null]);
      node.send([stateMsg('blocked', blocked.length,         blocked),         null]);
      node.send([stateMsg('total',   list.length,            list),            null]);

      // Fire new-rogue events
      for (const r of newOnes) {
        const payload = { event_type: 'new_rogue', ...r };
        node.send([{ topic: `${CONFIG.MQTT_BASE_TOPIC}/event/new_rogue`, payload: JSON.stringify(payload), retain: false, qos: 1 }, null]);
      }

      node.status({
        fill: 'green',
        shape: 'dot',
        text: `${activeUnblocked.length} active / ${blocked.length} blocked @ ${new Date(ts).toLocaleTimeString()}`
      });
    } catch (err) {
      const failCount = (context.get('failCount') || 0) + 1;
      context.set('failCount', failCount);
      
      node.status({
        fill: 'red',
        shape: 'ring',
        text: `WIPS poll failed (${failCount}/3): ` + (err.message || err).toString().slice(0, 45)
      });
      
      if (failCount >= 3) {
        if (context.get('lastAvailability') !== 'offline') {
          node.send([{ topic: `${CONFIG.MQTT_BASE_TOPIC}/status`, payload: 'offline', retain: true, qos: 1 }, null]);
          context.set('lastAvailability', 'offline');
        }
      }
      throw err;
    }
  })();

  try {
    await activePollPromise;
  } finally {
    activePollPromise = null;
  }
}
