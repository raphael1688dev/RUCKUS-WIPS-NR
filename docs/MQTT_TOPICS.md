# MQTT topic reference

All topics published / consumed by [`flows/ruckus_wips.json`](../flows/ruckus_wips.json).
Discovery prefix assumed to be the HA default (`homeassistant/`).

## Availability

| Topic | Direction | Retain | QoS | Payload |
| --- | --- | --- | --- | --- |
| `ruckus_wips/status` | NR → broker | yes | 1 | `online` (birth) / `offline` (LWT + finalize) |

Drives the `availability_topic` of every Discovery entity, so HA shows the
entities as *unavailable* when NR is down or the controller is unreachable.

## State (retained, refreshed every poll)

| Topic | Direction | Retain | QoS | Payload schema |
| --- | --- | --- | --- | --- |
| `ruckus_wips/state/active` | NR → broker | yes | 1 | `{ count: int, last_updated: ms, rogues: Rogue[] }` |
| `ruckus_wips/state/blocked` | NR → broker | yes | 1 | same as above |
| `ruckus_wips/state/total` | NR → broker | yes | 1 | same as above |

- **active** — currently-visible rogues with `blocked == false`.
- **blocked** — rogues with `blocked == true` (the User-Blocked set).
- **total** — union of the two, keyed by BSSID (so a rogue that's both
  active *and* blocked appears once).

`last_updated` is unix milliseconds at the moment NR published the snapshot.

## Events (transient)

| Topic | Direction | Retain | QoS | Payload schema |
| --- | --- | --- | --- | --- |
| `ruckus_wips/event/new_rogue` | NR → broker | no | 1 | `{ event_type: "new_rogue", ...Rogue }` |

Fired once per never-before-seen BSSID. NR seeds its `seenBssids` set
silently on the *first* poll after restart, so you don't get an alert
storm for already-known rogues.

The MQTT Discovery config exposes this as `event.ruckus_wips_new_rogue_detected`
on every connected HA. State-platform triggers will see the full Rogue
payload as `trigger.to_state.attributes.*`.

## Commands (from HA → NR)

| Topic | Direction | Retain | QoS | Payload |
| --- | --- | --- | --- | --- |
| `ruckus_wips/cmd/mark_malicious` | HA → broker → NR | no | 1+ | `aa:bb:cc:dd:ee:ff` |
| `ruckus_wips/cmd/unmark_malicious` | HA → broker → NR | no | 1+ | `aa:bb:cc:dd:ee:ff` |
| `ruckus_wips/cmd/ack` | NR → broker | no | 1 | `{ bssid, action, ok, message?, ts }` |

NR subscribes to `ruckus_wips/cmd/+`, validates the BSSID, executes the
corresponding `blockrogue` / `unblockrogue` XML against the controller,
publishes an ack, and triggers a fresh poll so the state topics update
within a second instead of waiting for the next interval.

If `RUCKUS_ENABLE_UNBLOCK=false` (set in NR add-on env), unmark commands
are rejected with `{ ok: false, message: "unmark disabled" }` on ack.

## Discovery (retained, published once on first run)

| Topic | Discovery component |
| --- | --- |
| `homeassistant/sensor/ruckus_wips_active/config` | `sensor.ruckus_wips_active_rogues` |
| `homeassistant/sensor/ruckus_wips_blocked/config` | `sensor.ruckus_wips_blocked_rogues` |
| `homeassistant/sensor/ruckus_wips_total/config` | `sensor.ruckus_wips_rogues_total` |
| `homeassistant/event/ruckus_wips_new_rogue/config` | `event.ruckus_wips_new_rogue_detected` |

Each config attaches to a single device:

```json
{
  "identifiers": ["ruckus_wips_main"],
  "name": "RUCKUS Unleashed WIPS",
  "manufacturer": "Ruckus Networks",
  "model": "Unleashed (via Node-RED)",
  "configuration_url": "https://<controller-host>/"
}
```

So every connected HA shows **one** device with four entities.

## Rogue object schema

The `rogues` array elements (and the `new_rogue` event payload) are:

```ts
type Rogue = {
  bssid: string;                    // lowercase, colon-separated MAC
  ssid: string;                     // may be empty for hidden SSIDs
  channel: string;                  // controller reports as string, kept as-is
  radio_band: "2.4g" | "5g" | "";
  radio_type: string;               // e.g. "802.11g/n", "802.11ac"
  encryption: "Encrypted" | "Open" | "";
  rogue_type: string;               // e.g. "malicious AP (User-blocked)"
  blocked: boolean;                 // true = currently deauth'd
  last_seen: number;                // unix epoch seconds (NOT ms)
  detection_ap: string;             // sys-name of strongest-RSSI detector
  detection_ap_location: string;    // free-text location field on that AP
  detection_ap_mac: string;         // lowercase MAC of the detector
  rssi: number;                     // 0-100, higher = stronger
};
```

`detection_*` fields are populated from the AP that saw the rogue with the
highest RSSI. The raw controller response may include multiple detectors
in a `detection` list — NR picks the strongest and discards the rest. If
you need all detectors, switch `pickStrongestDetection` in the function
node to surface the full list.

## Quick test from the CLI

```sh
# Watch all topics
mosquitto_sub -h <broker> -u <user> -P <pass> -v -t 'ruckus_wips/#'

# Block a BSSID
mosquitto_pub -h <broker> -u <user> -P <pass> \
  -t 'ruckus_wips/cmd/mark_malicious' \
  -m 'aa:bb:cc:dd:ee:ff'

# Watch the ack
mosquitto_sub -h <broker> -u <user> -P <pass> -v -t 'ruckus_wips/cmd/ack'
```
