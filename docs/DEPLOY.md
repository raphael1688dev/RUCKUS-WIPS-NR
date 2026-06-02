# Deployment checklist

Copy-paste-able steps to deploy `flows/ruckus_wips.json` on the Frenck
Node-RED add-on and verify end-to-end. Replace `<...>` placeholders with
your values.

Raphael's defaults (fill the rest):
- Controller host: `ruckus.raphaelchen.org`
- MQTT broker host (from inside HA): `core-mosquitto`
- Broker port: `1883`

---

## 0. Pre-flight

- [ ] **Mosquitto broker add-on** installed & started.
- [ ] A dedicated MQTT user exists. In the Mosquitto add-on Configuration:
      ```yaml
      logins:
        - username: ruckus_wips
          password: <pick-a-password>
      ```
      (Or reuse an existing HA MQTT user. The built-in `homeassistant`/
      add-on auth user also works.)
- [ ] **MQTT integration** added on every HA that should see the entities
      (Settings → Devices & services → Add integration → MQTT → point at
      the broker).
- [ ] Controller reachable from the NR host:
      ```sh
      # from the Node-RED add-on Terminal & SSH (or any host on the LAN)
      curl -skI https://ruckus.raphaelchen.org/ | head -5
      ```
      Expect a redirect (`HTTP/1.1 302` + a `Location:` header pointing at
      `/admin/login.jsp` or similar). That redirect is what the flow's
      login step follows.

## 1. Optional but recommended — sanity-check the controller in Python

```sh
cd /path/to/RUCKUS-NR
python3 -m venv .venv
.venv/bin/pip install "aioruckus>=0.42"
.venv/bin/python probe.py ruckus.raphaelchen.org admin '<password>'
```
Expect it to print the active / known / blocked rogue lists. If this works,
the AJAX surface is healthy and any later failure is on the NR / MQTT side.

## 2. Import the flow

1. Node-RED UI → ☰ (top-right) → **Import**.
2. **select a file to import** → `flows/ruckus_wips.json` → **Import**.
3. NR detects the function node's external modules and shows an install
   prompt. Click **Install** / **Confirm**. Modules pulled into
   `/data/node_modules`:
   - `xml2js`
   - `tls` is a Node built-in — no download.
4. Wait for the install to finish (watch the NR notification toast).

## 3. Credentials

Pick ONE:

**(a) env vars on the add-on** (recommended) — add-on Configuration tab:
```yaml
# in the add-on's "Configuration" → there isn't a native env list, so use
# init_commands OR edit the function node directly (option b).
```
Frenck's add-on doesn't expose arbitrary env vars cleanly, so in practice
use option (b) unless you've wired env another way.

**(b) edit the function node** — open **Ruckus AJAX driver**, top of the
code:
```js
const HOST = env.get('RUCKUS_HOST') || 'ruckus.raphaelchen.org';
const USER = env.get('RUCKUS_USER') || 'admin';
const PASS = env.get('RUCKUS_PASS') || 'CHANGE_ME';   // ← set this
const ENABLE_UNBLOCK = (env.get('RUCKUS_ENABLE_UNBLOCK') || 'true') === 'true';
```
Set `PASS` to the controller admin password. Leave `ENABLE_UNBLOCK` true
unless you want to refuse unblock commands.

## 4. MQTT broker config node

Double-click the **HA Mosquitto** config node (or open it from any
mqtt node → pencil icon):

- **Server**: `core-mosquitto`  ·  **Port**: `1883`
- **Security** tab: username `ruckus_wips` + the password from step 0.
- Leave Birth/Will as imported (they publish `ruckus_wips/status`
  online/offline retained).

> If connection fails with `core-mosquitto`, try `127.0.0.1`, then the HA
> host's LAN IP (`192.168.88.x`). `host_network: true` means loopback works
> but inter-add-on DNS can be flaky.

## 5. Deploy

Click **Deploy** (top-right). Within ~3 s the **Ruckus AJAX driver** node
should show a green status dot:

```
N active / M blocked @ HH:MM:SS
```

`M` should be ≈ your ~7 historical User-Blocked rogues. If it's red, open
the debug sidebar (🐞 icon) — the catch node routes errors there.

## 6. Watch the MQTT traffic

Run from the **Mosquitto add-on Terminal**, or any host with
`mosquitto-clients` (use the broker LAN IP off-host):

```sh
mosquitto_sub -h core-mosquitto -u ruckus_wips -P '<password>' -v \
  -t 'ruckus_wips/#' -t 'homeassistant/#'
```

Expect, within one poll cycle:
```
ruckus_wips/status online
homeassistant/sensor/ruckus_wips_active/config   {...}   ← first run only
homeassistant/sensor/ruckus_wips_blocked/config  {...}   ← first run only
homeassistant/sensor/ruckus_wips_total/config    {...}   ← first run only
homeassistant/event/ruckus_wips_new_rogue/config {...}   ← first run only
ruckus_wips/state/active   {"count":N,"last_updated":...,"rogues":[...]}
ruckus_wips/state/blocked  {"count":M,...}
ruckus_wips/state/total    {"count":N+M,...}
```

## 7. Verify entities on HA

On any HA pointed at the broker:
- **Settings → Devices & services → MQTT** → **1 device** →
  **RUCKUS Unleashed WIPS** with four entities:
  - `sensor.ruckus_wips_active_rogues`
  - `sensor.ruckus_wips_blocked_rogues`
  - `sensor.ruckus_wips_rogues_total`
  - `event.ruckus_wips_new_rogue_detected`
- All **available** (not greyed-out "unavailable"). If unavailable, the
  `ruckus_wips/status` topic isn't `online` — check the broker connection.

## 8. Block round-trip test

Grab a real **active, unblocked** BSSID from the state topic first:

```sh
mosquitto_sub -h core-mosquitto -u ruckus_wips -P '<password>' -C 1 \
  -t 'ruckus_wips/state/active' | python3 -m json.tool
# copy a "bssid" value from the rogues array
```

In another terminal, watch the ack:
```sh
mosquitto_sub -h core-mosquitto -u ruckus_wips -P '<password>' -v \
  -t 'ruckus_wips/cmd/ack'
```

Fire the block:
```sh
mosquitto_pub -h core-mosquitto -u ruckus_wips -P '<password>' \
  -t 'ruckus_wips/cmd/mark_malicious' \
  -m 'aa:bb:cc:dd:ee:ff'        # ← the BSSID you copied
```

Expect on the ack watcher within ~1 s:
```
ruckus_wips/cmd/ack {"bssid":"aa:bb:cc:dd:ee:ff","action":"mark_malicious","ts":...,"ok":true}
```
Then:
- [ ] `ruckus_wips/state/blocked` count goes up by 1 (the flow re-polls
      after a command).
- [ ] Controller UI → Admin & Services → … → "User Blocked" list grows by 1.

### Unblock (if `ENABLE_UNBLOCK=true`)

```sh
mosquitto_pub -h core-mosquitto -u ruckus_wips -P '<password>' \
  -t 'ruckus_wips/cmd/unmark_malicious' \
  -m 'aa:bb:cc:dd:ee:ff'
```
Ack `ok:true`, blocked count drops by 1.

### Negative test — bad BSSID

```sh
mosquitto_pub -h core-mosquitto -u ruckus_wips -P '<password>' \
  -t 'ruckus_wips/cmd/mark_malicious' -m 'not-a-mac'
# → ack {"...","ok":false,"message":"invalid BSSID"}
```

## 9. (Optional) Wire up notifications

Add the bell + logbook automations from the README's "Automation examples"
section, then trigger a synthetic event to confirm:

```sh
mosquitto_pub -h core-mosquitto -u ruckus_wips -P '<password>' \
  -t 'ruckus_wips/event/new_rogue' \
  -m '{"event_type":"new_rogue","bssid":"de:ad:be:ef:00:01","ssid":"TEST","channel":"6","rssi":20,"encryption":"Open","rogue_type":"test","detection_ap":"R720-1F","detection_ap_location":"LIVING ROOM"}'
```
- [ ] 🔔 bell notification appears top-right.
- [ ] Logbook shows the custom "RUCKUS WIPS: new rogue TEST …" line.

> This synthetic publish is for testing only — it does NOT come from the
> controller and won't appear in the next real poll's state topics.

## Troubleshooting quick table

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Red: `does not support for use with other http(s).Agent` | an OLD flow version with the cookie-jar libs is still imported | re-import the current `flows/ruckus_wips.json` (it hand-manages cookies, no cookie-jar lib) and Deploy |
| Red: `Parse Error: Expected HTTP/, RTSP/ or ICE/` | OLD flow still routing through Node's HTTP parser (axios or `https`) — Ruckus emits HTTP that Node rejects even in lenient mode | re-import the current `flows/ruckus_wips.json` (it uses a raw `tls` socket + hand parsing, bypassing Node's HTTP parser) and Deploy |
| Red: `LOGIN_INCORRECT` | wrong creds | fix `PASS` in the function node |
| Red: `Discover: no Location header` | host wrong / controller down | check `curl -skI https://<host>/` |
| Entities show "unavailable" | broker conn down / status not online | check broker creds, look for `ruckus_wips/status online` |
| No Discovery configs on broker | first-run flag already set from a prior deploy | publish nothing? redeploy clears `discoveryPublished` only on full restart — use `mosquitto_pub -r` to clear stale `homeassistant/.../config` if needed |
| Block ack `ok:false` `MSG_action_failed` | controller rejected | verify the BSSID is a real rogue, not a client |
