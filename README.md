# RUCKUS WIPS — Node-RED + MQTT bridge

A **Node-RED flow** that polls a RUCKUS Unleashed controller for rogue-AP /
WIPS state and publishes it to MQTT, so any number of Home Assistant
instances on the same broker can consume it without each one hammering the
controller.

Targets Home Assistant **`2026.5.0`+**. Tested with R720 on Unleashed
`200.15.6.212`, Node-RED `4.1.10` on Node.js 24.x (Frenck's community
Node-RED add-on, base `hassio-addons/base:20.1.1`).

> **Why not the HACS integration?** This repo was originally a HACS
> integration (still archived in git history). The HACS version polls the
> controller directly from each HA instance — N instances means N admin
> sessions and N× the load on a controller that only natively allows one
> admin session. The Node-RED flow polls **once** and fans state out via
> MQTT, so adding a second / third HA costs the controller nothing.

## Architecture

```
                                                   ┌───────────────┐
                                                   │ HA instance A │ (MQTT Discovery
                                                   └───────┬───────┘  auto-creates
                                                           │          sensors + event)
   ┌────────────┐  poll 30 s  ┌────────────┐  pub  ┌───────┴───────┐
   │  Ruckus    │ ◄────────── │  Node-RED  │ ────► │  Mosquitto    │
   │ Unleashed  │  AJAX/XML   │   (this    │       │   broker      │
   │ controller │ ──────────► │   flow)    │ ◄──── │               │
   └────────────┘             └────────────┘  cmd  └───────┬───────┘
                                                           │
                                                   ┌───────┴───────┐
                                                   │ HA instance B │
                                                   └───────────────┘
```

Every HA instance pointed at the same broker sees the same three sensors
plus a new-rogue event, and any of them can call `mark_malicious` /
`unmark_malicious` by publishing to a command topic.

## What you get on every connected HA

- `sensor.ruckus_wips_active_rogues` — currently-visible rogues that have
  *not* been marked malicious. Attributes hold the full list (BSSID, SSID,
  channel, RSSI, encryption, detecting AP, room).
- `sensor.ruckus_wips_blocked_rogues` — rogues currently being deauthed.
- `sensor.ruckus_wips_rogues_total` — sum of the above.
- `event.ruckus_wips_new_rogue_detected` — fires `new_rogue` the first time
  a BSSID is seen. Restart-safe (first poll seeds silently).
- Implicit "mark malicious" / "unmark malicious" controls via MQTT command
  topics — see [MQTT topics](#mqtt-topics) below.

All four entities ship under one device (`RUCKUS Unleashed WIPS`) created
automatically by MQTT Discovery. No YAML required on the HA side.

## Install

### 1. Prereqs on the HA running the flow

You need three add-ons on **one** Home Assistant (any of the cluster):

| Add-on | Source | Why |
| --- | --- | --- |
| **Node-RED** | Community / official | Hosts the flow |
| **Mosquitto broker** | Official | The MQTT broker every HA connects to |
| **MQTT integration** (built-in) | core | On *every* HA that should see WIPS state |

In the Node-RED add-on **Configuration** tab, make sure function-node
external modules are enabled. On NR `4.1.x` this is on by default — open
the function node's **Setup → Modules** tab; you should see an
"Add" button. If you don't, edit the add-on's `settings.js` and set
`functionExternalModules: true` under `module.exports`.

### 2. Import the flow

In Node-RED UI → ☰ → **Import** → **select a file to import** → choose
[`flows/ruckus_wips.json`](flows/ruckus_wips.json) → click **Deploy**.

On first deploy NR will offer to install the function node's external
modules — accept. The list is tiny:

- `xml2js`
- `tls` (Node built-in, no install needed)

> The flow talks to the controller over a **hand-rolled TLS client** (Node's
> built-in `tls`), not axios and not even Node's `http`/`https` modules. The
> controller's embedded web server emits HTTP responses that Node's parser
> rejects outright (*"Expected HTTP/, RTSP/ or ICE/"*) — even with
> `insecureHTTPParser` — while Python's `aiohttp` parses them fine. So we
> open a raw TLS socket, send a minimal HTTP/1.0 request, and parse the
> response by hand. `rejectUnauthorized: false` covers the self-signed cert,
> and the session cookie is hand-managed. Net result: two external modules
> and none of those parser/agent conflicts.

### 3. Set credentials

Open the **Ruckus AJAX driver** function node and either:

- (recommended) Set environment variables on the Node-RED add-on:
  - `RUCKUS_HOST` — e.g. `ruckus.raphaelchen.org`
  - `RUCKUS_USER` — e.g. `admin`
  - `RUCKUS_PASS` — controller admin password
  - `RUCKUS_ENABLE_UNBLOCK` — `true` to allow unblock commands, `false` to
    refuse them silently. Default `true`.
- *or* edit the constants at the top of the function code directly:
  ```js
  const HOST = env.get('RUCKUS_HOST') || 'ruckus.raphaelchen.org';
  const USER = env.get('RUCKUS_USER') || 'admin';
  const PASS = env.get('RUCKUS_PASS') || 'CHANGE_ME';
  ```

### 4. Point the MQTT broker config at your broker

Edit the **mqtt_broker** config node:

- **Server**: `core-mosquitto` (default) — the Mosquitto add-on hostname
  inside HA. If Node-RED runs outside HA, use the broker's IP.
- **Port**: `1883`
- **Security** tab: broker username / password if you set one. The HA
  Mosquitto add-on usually auto-creates an `addons` user; create a
  dedicated user in the Mosquitto add-on Configuration and use that.

Click **Deploy** again. The flow's inject node fires once after 1.5 s and
then every 30 s.

> **Following along step-by-step?** [`docs/DEPLOY.md`](docs/DEPLOY.md) is a
> copy-paste checklist covering everything below plus `mosquitto_sub` /
> `mosquitto_pub` verification commands and a troubleshooting table.

### 5. Check it's working

In NR, the **Ruckus AJAX driver** node should show a green status dot:

```
2 active / 7 blocked @ 14:23:01
```

On any HA pointed at the same broker, **Settings → Devices & services →
MQTT → 1 device** should now list **RUCKUS Unleashed WIPS** with the four
entities. No restart of HA required — Discovery is instant.

## MQTT topics

State (retained, published every poll):

| Topic | Payload | Meaning |
| --- | --- | --- |
| `ruckus_wips/status` | `online` / `offline` | LWT + birth — drives entity availability |
| `ruckus_wips/state/active` | `{count, last_updated, rogues:[...]}` | unblocked rogues |
| `ruckus_wips/state/blocked` | `{count, last_updated, rogues:[...]}` | marked-malicious rogues |
| `ruckus_wips/state/total` | `{count, last_updated, rogues:[...]}` | union of the two |

Events (not retained, one message per occurrence):

| Topic | Payload | Meaning |
| --- | --- | --- |
| `ruckus_wips/event/new_rogue` | `{event_type, bssid, ssid, channel, rssi, detection_ap, ...}` | first time a BSSID is seen |

Commands (publish from HA to drive the controller):

| Topic | Payload | Action |
| --- | --- | --- |
| `ruckus_wips/cmd/mark_malicious` | `aa:bb:cc:dd:ee:ff` | broadcast deauth on that BSSID |
| `ruckus_wips/cmd/unmark_malicious` | `aa:bb:cc:dd:ee:ff` | undo the above (gated by `RUCKUS_ENABLE_UNBLOCK`) |
| `ruckus_wips/cmd/ack` | `{bssid, action, ok, message}` | reply published by NR after each command |

Each `rogues` element looks like:

```json
{
  "bssid": "fc:ee:e6:45:c4:6b",
  "ssid": "Polaroid-fceee645c46b",
  "channel": "1",
  "radio_band": "2.4g",
  "radio_type": "802.11g/n",
  "encryption": "Encrypted",
  "rogue_type": "malicious AP (User-blocked)",
  "blocked": true,
  "last_seen": 1776144464,
  "detection_ap": "R720-1F",
  "detection_ap_location": "LIVING ROOM",
  "detection_ap_mac": "80:03:84:1a:7a:40",
  "rssi": 33
}
```

See [docs/MQTT_TOPICS.md](docs/MQTT_TOPICS.md) for the full schema.

## Dashboard recipe — list current rogues with a one-click block button

The flow intentionally publishes **aggregate** entities, not one-per-BSSID
— keeps HA's entity registry clean as rogues come and go. To get a
per-row block button, pair a markdown card with an `input_text` helper
plus a thin script that publishes the BSSID to the MQTT command topic.

### 1. Create the helper

Settings → Devices & services → **Helpers** → **Create helper** → **Text**:

| Field | Value |
| --- | --- |
| Name | `Ruckus Block BSSID` |
| (advanced) ID | `ruckus_block_bssid` |
| Min length | `17` |
| Max length | `17` |

Result: `input_text.ruckus_block_bssid`.

### 2. Create the bridge script

Settings → Automations & scenes → **Scripts tab** (top tab inside the
page) → **Add Script** → **Start with an empty script** → ⋮ → **Edit in
YAML**, then paste:

```yaml
alias: Ruckus Block Typed BSSID
description: Publish BSSID to ruckus_wips/cmd/mark_malicious
mode: single
sequence:
  - variables:
      bssid: "{{ states('input_text.ruckus_block_bssid') | lower | trim }}"
  - condition: template
    value_template: "{{ bssid | regex_match('^([0-9a-f]{2}:){5}[0-9a-f]{2}$') }}"
  - action: mqtt.publish
    data:
      topic: ruckus_wips/cmd/mark_malicious
      payload: "{{ bssid }}"
      qos: 1
      retain: false
  - action: input_text.set_value
    target:
      entity_id: input_text.ruckus_block_bssid
    data:
      value: ""
```

> ⚠️ **Keep `alias:` in ASCII English.** HA derives the script's service
> name (used by dashboard `tap_action`) from the alias at creation time by
> stripping non-ASCII characters. Once registered, the service name is
> sticky — even a full HA restart will not update it. With this alias
> both entity_id and service become `script.ruckus_block_typed_bssid`.
> Rename the **display Name** to whatever you like afterwards (e.g.
> `Ruckus 封鎖貼上的 BSSID`).

### 3. Dashboard card

```yaml
type: vertical-stack
cards:
  - type: markdown
    content: |
      ## 目前未封鎖的 Rogue AP
      {% set rogues = state_attr('sensor.ruckus_wips_active_rogues', 'rogues') or [] %}
      {% if rogues %}
      {% for r in rogues %}
      - **{{ r.ssid or '(隱藏 SSID)' }}** `{{ r.bssid }}`
        — ch{{ r.channel }} / rssi {{ r.rssi }} / 偵測者 {{ r.detection_ap }} ({{ r.detection_ap_location }})
      {% endfor %}
      {% else %}
      ✓ 目前沒有未處理的 rogue AP
      {% endif %}

  - type: entities
    title: 執行封鎖
    show_header_toggle: false
    entities:
      - entity: input_text.ruckus_block_bssid
        name: 貼上 BSSID
        icon: mdi:identifier
      - type: button
        name: 對上方 BSSID 執行封鎖
        icon: mdi:wifi-cancel
        action_name: 封鎖
        tap_action:
          action: perform-action
          perform_action: script.ruckus_block_typed_bssid
```

### Optional: unblock card

Mirror the pattern with a second helper + script publishing to
`ruckus_wips/cmd/unmark_malicious`. Make sure
`RUCKUS_ENABLE_UNBLOCK=true` in the Node-RED add-on env.

## Automation examples

All of these trigger directly off the MQTT event topic `ruckus_wips/event/new_rogue`.
This is the ultimate, most elegant design: it is 100% immune to Home Assistant reboots, integration reloads, or Node-RED deploys (since no MQTT messages are published during those events), and permits clean, warning-free templates.

### Auto-block any open-encryption rogue

```yaml
- alias: "Auto-block any open rogue"
  triggers:
    - trigger: mqtt
      topic: ruckus_wips/event/new_rogue
  conditions:
    - "{{ trigger.payload_json.get('encryption', '') | lower == 'open' }}"
  actions:
    - action: mqtt.publish
      data:
        topic: ruckus_wips/cmd/mark_malicious
        payload: "{{ trigger.payload_json.get('bssid') }}"
        qos: 1
        retain: false
```

### 🔔 Bell notification (HA built-in, zero external setup)

`persistent_notification` puts a notification on the 🔔 icon top-right of
every HA dashboard. It triggers on the state update of the discovered event entity:

```yaml
- alias: "Ruckus Notify New Rogue"
  triggers:
    - trigger: state
      entity_id: event.ruckus_unleashed_wips_new_rogue_detected
  conditions:
    - condition: template
      value_template: >-
        {{ trigger.to_state is not none and 
           trigger.to_state.state not in ['unavailable', 'unknown'] and
           'bssid' in trigger.to_state.attributes }}
  actions:
    - action: persistent_notification.create
      data:
        title: >-
          New Rogue AP Detected {%- if trigger.to_state.attributes.encryption | lower == 'open' %} (Open Network!){% endif %}
        message: >-
          **{{ trigger.to_state.attributes.ssid or '(Hidden SSID)' }}**

          BSSID: `{{ trigger.to_state.attributes.bssid }}`

          Channel: {{ trigger.to_state.attributes.channel }} ({{ trigger.to_state.attributes.radio_band }}) / RSSI: {{ trigger.to_state.attributes.rssi }}

          Encryption: {{ trigger.to_state.attributes.encryption }}

          Detected by: {{ trigger.to_state.attributes.detection_ap }} ({{ trigger.to_state.attributes.detection_ap_location }})

          Type: {{ trigger.to_state.attributes.rogue_type }}
        notification_id: ruckus_rogue_{{ trigger.to_state.attributes.bssid | replace(':', '_') }}
```

### 📖 Custom Logbook entry

The HACS version had a Python *logbook describer* that rendered new-rogue
events as human-readable lines. A pure-MQTT integration can't register a
describer (no custom component), but the built-in `logbook.log` service
gives the same result from an automation:

```yaml
- alias: "Ruckus rogue → logbook entry"
  triggers:
    - trigger: mqtt
      topic: ruckus_wips/event/new_rogue
  actions:
    - action: logbook.log
      data:
        name: RUCKUS WIPS
        entity_id: event.ruckus_unleashed_wips_new_rogue_detected
        message: >
          new rogue {{ trigger.payload_json.get('ssid') or '(hidden)' }}
          ({{ trigger.payload_json.get('bssid') }})
          ch{{ trigger.payload_json.get('channel') }}
          rssi {{ trigger.payload_json.get('rssi') }}
          detected by {{ trigger.payload_json.get('detection_ap') }}
          ({{ trigger.payload_json.get('detection_ap_location') }})
```

Logbook then shows e.g. *"RUCKUS WIPS: new rogue realme C51 (5e:a6:…)
ch36 rssi 8 detected by R720-2F (MASTER ROOM)"* instead of the generic
"detected event new_rogue" line.

> Want a mobile push instead of / in addition to the bell? Swap
> `persistent_notification.create` for `notify.mobile_app_<your_device>`
> with `title:` + `message:` — same trigger and templates.

## Multi-HA setup

Once the flow runs on the Node-RED host, **any number** of HAs can join:

1. On each HA: **Settings → Devices & services → Add integration → MQTT**.
2. Point it at the same Mosquitto broker (host:port + user).
3. Within a few seconds the **RUCKUS Unleashed WIPS** device appears with
   all four entities. Use the entities exactly as on the main HA.

Each HA gets its own copy of the entities — they're all driven from the
same retained state topics, so reboots / desync are self-healing.

## Verifying / dev tools

A standalone Python session can confirm the controller behaves as expected
before you touch Node-RED:

```sh
python3 -m venv .venv
.venv/bin/pip install "aioruckus>=0.42"
.venv/bin/python probe.py ruckus.raphaelchen.org admin '<password>'
.venv/bin/python probe_unblock.py ruckus.raphaelchen.org admin '<password>'
```

These print the three rogue lists and round-trip a block/unblock so you can
sanity-check the controller side independently of NR.

## Caveats

- "Real-time" is bounded by Ruckus's own background scan cadence (~30 s) plus
  the poll interval. Worst case ≈ poll interval + 30 s.
- Unleashed allows one admin web session by default. NR consumes it. If you
  cannot log in to the Unleashed UI while NR runs, enable multi-session in
  Unleashed → Admin & Services → System → System Info.
- The AJAX surface is **unofficial** (reverse-engineered). It has been
  stable across Unleashed firmware revisions but Ruckus could change it
  without notice. `aioruckus` (the upstream Python library that the AJAX
  payloads in this flow are ported from) is a Home Assistant Core
  dependency, so any breakage is usually fixed there first.

## License

MIT.
