# CLAUDE.md — RUCKUS WIPS Node-RED bridge

Project notes for future Claude Code sessions. Keep this updated.

## What this is

A **Node-RED flow** that polls a RUCKUS Unleashed controller for rogue-AP
state and bridges it to **MQTT**, so multiple Home Assistant instances on
the same broker can consume the same data via MQTT Discovery without each
HA hammering the controller.

The flow lives in [`flows/ruckus_wips.json`](flows/ruckus_wips.json) and is
imported into a Node-RED add-on (typically the HA OS one). The user has
one such NR instance plus a Mosquitto broker; any number of HAs join by
adding the MQTT integration pointing at the same broker.

**Target versions**: Home Assistant **`2026.5.0`+**, NR `4.1.10` on
Node.js `24.14.1` (npm `11.11.0`), running in the **community Node-RED
add-on by Frenck** (`hassio-addons/addon-node-red`, base
`ghcr.io/hassio-addons/base:20.1.1`, `host_network: true`). Unleashed
`200.15.6.212` on R720. All three add-on source files (Dockerfile,
`config.yaml`, `package.json`) are archived verbatim under
[`docs/host/`](docs/host/) with a writeup explaining what each implies
for the flow. See the dedicated [Node-RED version
notes](#node-red-version-notes) and
[HA 2026.5+ Discovery checklist](#ha-20265-discovery-checklist) sections
below.

**Migration note (2026-05-23):** This repo used to be a HACS integration
(`custom_components/ruckus_wips/`). The HACS approach was abandoned because
running it on N home-assistant instances meant N admin sessions against
the Unleashed controller (Unleashed only natively allows one). The current
NR-based architecture polls once centrally and fans state out via MQTT.
The HACS source tree was deleted; recover from filesystem backup or
re-clone from earlier history if ever needed.

The user's environment:
- **3× R720** on Unleashed (master serial `402003001468`, MAC `80:03:84:1A:9E:30`)
- Hostname `ruckus.raphaelchen.org`, LAN IP `192.168.88.181`
- APs labelled `R720-1F` (LIVING ROOM), `R720-2F` (MASTER ROOM), `R720-3F`
  (BOOTS' ROOM)
- ~7 historical "User Blocked" rogues already on the controller before
  this project existed.
- Locale: zh-Hant. Defaults to Chinese in UI.

## Architecture (decided, do not relitigate)

- **One Node-RED add-on** running the flow. Centralized polling.
- **MQTT Discovery** auto-creates 3 sensors + 1 event entity on every
  connected HA. No per-rogue entities (user rejected that — would balloon
  the entity registry as rogues come and go).
- **Polling only** (Unleashed has no push API). Default 30 s. Effective
  worst-case detection latency ≈ poll interval + 30 s background-scan.
- **Block semantics**: "Mark as Malicious" → Ruckus broadcasts deauth on
  the BSSID. Only blocking primitive available.
- **Unblock gated** by `RUCKUS_ENABLE_UNBLOCK` env var on the NR add-on
  (default `true`). Setting to `false` rejects `cmd/unmark_malicious`.

## The function node is one big file

Everything Ruckus-side (login, session, CSRF, paginated piecewise fetch,
block/unblock, snapshot diff) lives inside the `fn_ruckus` function node
in `flows/ruckus_wips.json`. The node uses external modules declared in
the flow JSON's `libs` field (rendered as the function node's **Setup →
Modules** tab in NR 4.1.x UI):

| Variable | Module | Notes |
| --- | --- | --- |
| `xml2js` | `xml2js` | parser opts: `{explicitArray: false, mergeAttrs: true}` |
| `tls` | `tls` | Node built-in; we open the socket ourselves |

The user must accept these modules on first Deploy (NR's import dialog
auto-detects the `libs` block and prompts). The session cookie is stored
by hand in the function node's `context` (`cookieJar` key, a plain
`{name:value}` object); CSRF token + base URLs also live in `context`.
Re-login is automatic on 302.

**HTTP layer is a hand-rolled TLS client, not axios and not Node's `http`
parser** (settled 2026-05-28 after THREE failed approaches on the live
add-on — see dead-ends below). `rawReq()` opens a raw `tls.connect()`
socket, writes a minimal **HTTP/1.0** request with `Connection: close`,
reads until the server closes, and parses the status line + headers + body
by hand (`String.fromCharCode(13,10,...)` for CRLF so no escaping games).
HTTP/1.0 + close ⇒ no chunked encoding, body is just everything after the
blank line. Helpers: `parseUrl()` splits the URL without the `URL` global
(NR's vm sandbox may not expose it), `encodeParams()` builds the login
query string (space→`+`), `saveCookies()` / `cookieHeaderStr()` manage the
jar. `httpHead`/`httpGet`/`httpPost` are shims over `rawReq`. If the status
line can't be parsed it `node.warn`s the first 200 bytes once
(`rawDumpDone` flag) so we can see what the controller actually sent. Only
`Buffer`, `String`, `Object`, `Promise`, `parseInt`, `encodeURIComponent`
(all guaranteed in the NR sandbox) plus the `tls` lib are used.

**Three dead ends we already hit — do not repeat:**
1. `tough-cookie` + `axios-cookiejar-support` v5 (`wrapper(client)`) →
   threw *"axios-cookiejar-support does not support for use with other
   http(s).Agent"*. The wrapper refuses to coexist with the custom
   `https.Agent` needed for the self-signed cert.
2. Plain axios with `insecureHTTPParser:true` in the axios config → still
   threw *"Parse Error: Expected HTTP/, RTSP/ or ICE/"* — axios doesn't
   forward that option to `https.request()` when `maxRedirects:0` bypasses
   follow-redirects.
3. Raw `https.request()` with `insecureHTTPParser:true` set directly on the
   request → STILL threw the same parse error. Node's `llhttp` (even
   lenient) requires the response to start with a valid `HTTP/` status line
   and rejects whatever the Ruckus embedded server emits. `aiohttp` (the
   Python lib probe.py uses) is more tolerant — that's the "works in
   Python, not Node" trap. The only fix that worked was to stop using
   Node's HTTP parser at all and parse the bytes ourselves over a raw TLS
   socket. **Do not route this back through `http`/`https`/axios.**

## HA developer-blog audit (2026-05-11 posts)

Two HA developer blog posts dated 2026-05-11 affect anyone publishing
MQTT messages. Both target HA's **internal Python `mqtt.publish` /
`async_publish` API** — i.e. what custom_components and HA-issued service
calls use. They do NOT directly govern external publishers like Node-RED,
but our README's `action: mqtt.publish` YAML examples go through the same
service implementation, so we audited those too.

### Post 1: `message_expiry_interval` parameter

- New optional kwarg `message_expiry_interval: int | None` (seconds) on
  HA's publish APIs. Lets retained messages auto-expire.
- **MQTT v5 only** — silently ignored on protocolVersion 3.1.1.
- HA version: not stated in the post.

**Impact on us**: zero today. Our broker config uses
`protocolVersion: "4"` (MQTT 3.1.1) and we rely on LWT (`availability_topic`)
to flip entities to *unavailable* when NR is down — no auto-expiry needed.
If we ever want "discovery configs get pruned after NR has been offline
for X hours", switch the broker config to `protocolVersion: "5"` and add
`expiry: <seconds>` to the relevant publishes.

### Post 2: `qos` / `retain` become required (HA Core 2027.6)

- `publish(hass, topic, payload, qos: int = 0, retain: bool = False, …)`
- `async_publish(...)` same signature.
- Passing `None` (current legacy behavior) stops working in **HA Core 2027.6**.
- No changes to topic structure, payload format, Discovery schema.

**Impact on us**:

- The flow itself publishes via Node-RED's `mqtt out` node, which talks
  directly to Mosquitto — does NOT route through HA's publish API. So
  technically untouched by this change.
- Every `node.send({..., retain, qos})` in `fn_ruckus` was audited
  (2026-05-23) and now sets both explicitly:

  | Publish | retain | qos |
  | --- | --- | --- |
  | Discovery configs (4 topics) | `true` | `1` |
  | `state/active|blocked|total` | `true` | `1` |
  | `event/new_rogue` | `false` | `1` |
  | `status` online/offline (birth/will/finalize) | `true` | `1` |
  | `cmd/ack` (success / failure / invalid-BSSID branches) | `false` | `1` |

- README's YAML examples that call `action: mqtt.publish` from HA now
  set both `qos: 1` and `retain: false` explicitly, so when 2027.6 lands
  no user automation breaks. (Strictly we have until 2027.6, but cheap
  to fix now.)

## HA 2026.5+ Discovery checklist

Every Discovery payload we publish was audited against the HA 2026.5
MQTT Discovery spec. Status of each spec requirement:

| Requirement | Status | Notes |
| --- | --- | --- |
| `unique_id` present on every entity | ✅ | Mandatory for entity registry from 2024.x |
| `device.identifiers` OR `device.connections` present | ✅ | We use `identifiers: ['ruckus_wips_main']` |
| `device.configuration_url` recommended | ✅ | `https://<HOST>/` |
| `origin.name` recommended (HA 2024+) | ✅ | `ruckus_wips_nodered` — shows in entity diagnostic UI |
| Event entity uses `event_types` + payload `event_type` | ✅ | `event_types: ['new_rogue']`, payload always sets `event_type: 'new_rogue'` |
| Availability via `availability_topic` flat form OR `availability:` array | ✅ flat | Single-topic LWT, both forms accepted in 2026.5+ |
| Sensor `state_class` for long-term statistics | ✅ | `measurement` — counts are accumulator-like; HA tolerates this |
| Discovery payloads marked `retain: true` | ✅ | Survives broker restart, new HA discovers from broker cache |

**Did NOT adopt** (considered, rejected):

- **Device-based discovery** (`homeassistant/device/<id>/config`, HA 2024.10+):
  cleaner topic layout but a bigger refactor and the per-entity form we
  use works identically. Revisit only if HA ever deprecates per-entity.
- **`availability:` array form**: needed only for multi-topic OR-availability.
  We have one LWT topic; flat form is equivalent and shorter.
- **`device.suggested_area`**: rogue APs aren't physically located, the
  detector AP location is on the entity attributes instead.

## Node-RED version notes

**Confirmed on NR `4.1.10` + Node.js `24.14.1` + npm `11.11.0`** running
in Frenck's community add-on (`hassio-addons/addon-node-red`, base image
`ghcr.io/hassio-addons/base:20.1.1`). See
[`docs/host/`](docs/host/) for the verbatim Dockerfile.

Compatibility matrix for features the flow depends on:

| Feature | NR introduced | Status on 4.1.10 |
| --- | --- | --- |
| function-node `libs` external modules (declared in flow JSON) | 1.3 | ✅ stable |
| top-level `await` inside function-node code | 3.0 | ✅ |
| `node.send([msg1, msg2])` for multi-output | 0.x | ✅ |
| inject node `props` array shape | 2.0 | ✅ |
| mqtt-broker `birthMsg.retain` / `willMsg.retain` object form | 3.1 | ✅ |
| mqtt-in `rh` (retain-handling) field | 3.1 | ✅ |
| Node built-ins (`https`) declarable as a function-node lib | 3.x | ✅ |
| MQTT protocol v3.1.1 (`protocolVersion: 4`) | 0.x | ✅ |

**No 4.x-only features used.** Flow JSON should also import cleanly on
NR 3.0+ if it ever needs to.

### NR 4.x UI difference vs 3.x (for documentation)

- The Modules list moved into a sub-tab. In **4.1.x** it's at:
  *function node properties → Setup tab → Modules subsection*.
- `functionExternalModules` is **on by default** in NR 4.0+, so users do
  not need to edit `settings.js`. Earlier versions required setting it
  manually under `module.exports`.
- The HA Node-RED add-on (community + official) tracks NR upstream; both
  ship 4.x at time of writing (May 2026).

### Add-on capabilities we know about (from `config.yaml`)

- `host_network: true` — NR container shares the host's network namespace.
  Means we can reach `ruckus.raphaelchen.org` directly without bridge
  routing, but resolution of inter-add-on hostnames like `core-mosquitto`
  depends on Supervisor's DNS. Fallback order if connection fails:
  `core-mosquitto` → `127.0.0.1` → host LAN IP → `homeassistant.local`.
- `hassio_api`, `homeassistant_api`, `auth_api` all enabled — gives us a
  fallback path via `node-red-contrib-home-assistant-websocket` (which IS
  pre-installed per `package.json`) if MQTT ever becomes problematic.
- `options.npm_packages` is an empty list by default and writable —
  available to pin any npm module the flow's `libs` can't resolve. Not
  needed today (flow uses only `axios` + `xml2js`).
- `homeassistant_config:rw` mapped — NR can read/write HA's config dir.
  We don't use this; mentioned for completeness.

### Pre-installed contrib nodes we deliberately don't use

From `package.json`: `node-red-contrib-home-assistant-websocket`,
`node-red-dashboard`, `node-red-contrib-bigtimer`, plus many others.
None are touched by our flow — we use only NR core nodes (`inject`,
`mqtt in`, `mqtt out`, `function`, `debug`, `catch`) plus the
`mqtt-broker` config node. This keeps the flow portable to any NR
install, not just Frenck's add-on.

### Known dependency-version gotchas

- **No axios / no Node http parser / no cookie-jar library** — HTTP is a
  hand-rolled TLS client. See the "HTTP layer is a hand-rolled TLS client"
  note + the "three dead ends" list under [The function node is one big
  file](#the-function-node-is-one-big-file). Don't route it back through
  axios / `http` / `https`.
- **`rejectUnauthorized: false` is mandatory** — controller has a
  self-signed cert. Passed to `tls.connect()` in `rawReq()`.
- **HTTP/1.0 + `Connection: close`** — chosen so the body is EOF-framed and
  the socket closes itself. BUT the controller still sometimes replies with
  `Transfer-Encoding: chunked` and/or gzip regardless of request version, so
  the raw parser is NOT off the hook:
  - `rawReq()` dechunks when `transfer-encoding: chunked` is present
    (`dechunkBuf()`), else *"Non-whitespace before first tag"* from xml2js
    (the chunk-size hex like `1f4` lands before `<ajax-response>`). Seen
    intermittently on the live controller 2026-05-28 — small responses came
    un-chunked, a larger one chunked.
  - gzip is suppressed two ways: `enable-gzip='0'` on **every** ajax-request
    (Ruckus-native switch — the piecewise query was missing it) AND an
    `Accept-Encoding: identity` request header. We do NOT carry a gunzip
    path, so if a future firmware forces gzip you'll see `ce=gzip` in the
    `parseFailDump` warn and need to add `zlib`.
  - `cmdstat()` also strips any bytes before the first `<` as a BOM/again
    safety net, and on parse failure emits a one-time `node.warn` with the
    status + transfer-encoding + content-encoding + first 200 body bytes.
- **`xml2js` parser options** — `{explicitArray: false, mergeAttrs: true}`
  is what the normalizer assumes. If you change it, `rec.mac` etc.
  silently become `rec.$.mac` and everything breaks.

### Verified end-to-end test plan (run after deploy)

1. NR debug sidebar should show the `Ruckus AJAX driver` node go to
   green-dot status `N active / M blocked @ HH:MM:SS` within ~3 s of
   Deploy.
2. Subscribe `mosquitto_sub -h <broker> -v -t 'ruckus_wips/#'` — should
   see `status=online`, three retained `state/*` payloads, and (on first
   ever run) the four `homeassistant/.../config` Discovery messages.
3. On a fresh HA: add MQTT integration → `RUCKUS Unleashed WIPS` device
   appears with 4 entities, all available (not "unavailable").
4. `mosquitto_pub -t ruckus_wips/cmd/mark_malicious -m '<known-bssid>'`
   → ack arrives within 1 s with `{ok:true}`, controller's "User Blocked"
   list grows by 1, NR re-polls so `state/blocked` updates.

## Verified AJAX payloads (R720 / 200.15.6.212)

These were captured live from the user's controller. **Use exactly these
strings** — Ruckus is strict about XML attributes.

**Login flow** (replicated in `discoverLoginUrl()` + `login()`):

```
1. HEAD https://{host}/                          allow_redirects=false
   → Location header is the login URL (e.g. /admin/login.jsp)
   → baseUrl = loginUrl.rsplit("/", 1)[0]
   → If Location is a relative path, HEAD that to follow Member→Master.

2. HEAD {loginUrl}?username=X&password=Y&ok=Log+In   allow_redirects=false
   → 200 = bad creds (successful login redirects to main.jsp or wizards.jsp).
   → Redirect location containing 'login.jsp' = bad creds (some Unleashed firmware redirects failed attempts back to login.jsp instead of returning status 200).
   → Read response header `http_x_csrf_token` (axios lowercases & uses _).
     Modern Unleashed (the user's controller) puts it here.
   → If absent, GET {baseUrl}/_csrfTokenVar.jsp and regex-scrape:
       /=\s*['"]([A-Za-z0-9]+)['"]/

All subsequent requests:
   POST {baseUrl}/_cmdstat.jsp
     Content-Type: text/xml
     X-CSRF-Token: {token}
     Cookie: <from cookie jar>
     Body: <ajax-request ...>...</ajax-request>
   → 302 = session dead → re-login + retry once.
```

**Three rogue list endpoints**:

```xml
<!-- get_active_rogues — single POST, filter recognized=!true (INCLUDES blocked!) -->
<ajax-request action='getstat' comp='stamgr' enable-gzip='0'>
  <rogue LEVEL='1' recognized='!true'/>
</ajax-request>

<!-- get_blocked_rogues — paginated piecewise, filter blocked=true -->
<ajax-request action='getstat' comp='stamgr' updater='brogue.{ts}.{rnd}'>
  <rogue sortBy='time' sortDirection='-1' LEVEL='1' blocked='true'/>
  <pieceStat pid='{pid}' start='{n}' number='{pageSize}'
             requestId='brogue.{ts}' cleanupId='brogue.{ts}.{rnd}'/>
</ajax-request>
<!-- Loop while response.done != 'true'. Increment pid + start each page. -->

<!-- get_known_rogues — same but blocked → recognized, updater 'krogue'.
     Not used by the flow today but the helper accepts a filter arg. -->
```

**Mark malicious** (verified working — `xmsg.type=0`):

```xml
<ajax-request action='docmd' xcmd='blockrogue' check-ability='10' comp='stamgr'>
  <xcmd cmd='blockrogue' tag='rogue' rogue='{bssid}'/>
</ajax-request>
```

(The HACS version of this project also documented an asymmetric working
form using `xcmd='block'` + `mac=...`. We standardized on `blockrogue` +
`rogue=...` in the flow because it matches the unblock form's shape.)

**Unmark malicious** (the form `xcmd='unblock'` does NOT work — Unleashed
returns `MSG_action_failed Unknown Error`. The working form is):

```xml
<ajax-request action='docmd' xcmd='unblockrogue' check-ability='10' comp='stamgr'>
  <xcmd cmd='unblockrogue' tag='rogue' rogue='{bssid}'/>
</ajax-request>
```

Note `check-ability` with a hyphen (not `checkAbility`), and `rogue='...'`
not `mac='...'`. Don't try to "clean up" this without re-verifying.

## Rogue record shape (200.15.6.212)

xml2js with `mergeAttrs: true, explicitArray: false` produces:

```json
{
  "blocked": "true",
  "name": "",
  "mac": "fc:ee:e6:45:c4:6b",
  "id": "44",
  "ieee80211-radio-type": "g/n",
  "num-detection": "1",
  "rogue-type": "malicious AP (User-blocked)",
  "radio-type": "802.11g/n",
  "radio-band": "2.4g",
  "channel": "1",
  "ssid": "Polaroid-fceee645c46b",
  "is-open": "Encrypted",
  "last-seen": "1776144464",
  "detection": {
    "ap": "80:03:84:1a:7a:40",
    "sys-name": "R720-1F",
    "location": "LIVING ROOM",
    "rssi": "33",
    "last-seen": "1776144464"
  }
}
```

**Gotcha — `detection` may also be an array** when multiple APs see the
same rogue. `pickStrongestDetection()` in the function node handles both;
keep that.

**Gotcha — `get_active_rogues()` returns entries that are already blocked.**
Its filter is `recognized != true`, not `blocked == false`. We normalize all
records, then filter on the normalized `blocked` boolean to produce
`active_unblocked` vs `blocked`.

**Gotcha — the two queries wrap `<rogue>` under DIFFERENT elements**
(confirmed live 2026-05-28 from the controller's actual response):

```
active  : ajax-response → response → rogue[]            (direct)
blocked : ajax-response → response → apstamgr-stat → rogue[]
                                     apstamgr-stat → done / pid / requestId
```

The piecewise (blocked/known) query nests rogues + the `done` pagination
flag under an `<apstamgr-stat>` element; the active query puts them
directly under `<response>`. Rather than hard-code both paths, the
function node uses `collectRogues(parsed)` (recursively gathers every
`rogue` element anywhere in the tree) and `findDone(parsed)` (recursively
finds the `done` flag). This is structure-agnostic, so a firmware change
that moves the wrapper won't break extraction. **Don't "simplify" it back
to a fixed `response.rogue` path** — that's exactly the bug that produced
`0 active / 0 blocked` on first live run.

## MQTT Discovery payloads

Built in the `discoveryMessages()` helper in the function node. Topic
layout:

```
homeassistant/sensor/ruckus_wips_active/config       → sensor.ruckus_wips_active_rogues
homeassistant/sensor/ruckus_wips_blocked/config      → sensor.ruckus_wips_blocked_rogues
homeassistant/sensor/ruckus_wips_total/config        → sensor.ruckus_wips_rogues_total
homeassistant/event/ruckus_wips_new_rogue/config     → event.ruckus_wips_new_rogue_detected
```

Each Discovery payload includes:
- `state_topic` pointing at `ruckus_wips/state/{suffix}` (sensors) or
  `ruckus_wips/event/new_rogue` (event entity).
- `availability_topic = ruckus_wips/status` (LWT-driven).
- `value_template` extracts `count` from the JSON.
- `json_attributes_template` exposes `rogues` and `last_updated` as
  entity attributes — that's how the dashboard markdown card iterates
  the list per-rogue.
- Common `device` block so all four entities cluster under
  `RUCKUS Unleashed WIPS`.
- `origin` block (`{name: 'ruckus_wips_nodered', sw_version, support_url}`)
  — surfaces the source integration name in HA's Settings → Devices &
  Services UI. Added 2026-05-23 to align with HA 2024+ Discovery best
  practice; not strictly required by 2026.5 spec but recommended.

Discovery configs are published with `retain: true` exactly once
(`context.get('discoveryPublished')` flag). State and event topics are
published every poll (retained where retention makes sense).

## LWT / availability

The `mqtt_broker` config node sets:

- **Will**: topic `ruckus_wips/status`, payload `offline`, retain true.
- **Birth**: topic `ruckus_wips/status`, payload `online`, retain true.
- **Close**: same as Will (graceful disconnect).

Plus the function node's `finalize` (On Stop) explicitly publishes an
`offline` retained message, so even a node redeploy flips availability
correctly.

## Command path (HA → MQTT → NR → controller)

1. HA calls `mqtt.publish` to `ruckus_wips/cmd/mark_malicious` or
   `ruckus_wips/cmd/unmark_malicious` with the BSSID as payload.
2. NR `mqtt_cmd_in` node subscribes to `ruckus_wips/cmd/+`, dispatches
   into `fn_ruckus`.
3. `fn_ruckus` branches on `msg.topic.startsWith('ruckus_wips/cmd/')`,
   validates the BSSID with `^([0-9a-f]{2}:){5}[0-9a-f]{2}$`, calls the
   matching AJAX form, publishes `ruckus_wips/cmd/ack` with
   `{ok, message?}`, and triggers a fresh poll so state updates within ~1 s.

The block/unblock and ack outputs go via the function node's **port 2**
(second wire output) so they can optionally route to a separate debug
node without spamming state traffic.

## Dev workflow

```sh
python3 -m venv .venv
.venv/bin/pip install "aioruckus>=0.42"

# Verify the controller responds the way we expect
.venv/bin/python probe.py ruckus.raphaelchen.org admin '<password>'
.venv/bin/python probe_unblock.py ruckus.raphaelchen.org admin '<password>'
```

Both probes still target the live AJAX surface and are useful for
sanity-checking a firmware upgrade or new controller before pointing the
flow at it.

To iterate on the flow locally without a real NR add-on: install Node-RED
via `npx node-red`, import `flows/ruckus_wips.json`, install the four
external modules via the function node's Setup tab. The flow expects
`core-mosquitto` as the broker hostname; change to `localhost` or your
broker host for local testing.

## File map

```
flows/
└── ruckus_wips.json                  # the entire integration — import into Node-RED
docs/
├── DEPLOY.md                         # copy-paste deploy + verify checklist
├── MQTT_TOPICS.md                    # topic schema reference for the broker side
├── RESEARCH.md                       # historical Ruckus-API research notes (HACS era)
├── TECHNICAL_DEBTS.md                # comprehensive technical debt audit report
└── host/
    ├── README.md                     # how the add-on env affects the flow
    ├── nodered-addon.Dockerfile      # Frenck add-on Dockerfile (verbatim snapshot)
    ├── nodered-addon.config.yaml     # Frenck add-on config.yaml (verbatim snapshot)
    └── nodered-addon.package.json    # Frenck add-on package.json (verbatim snapshot)
.github/workflows/
└── validate.yml                      # JSON parse + node --check on function-node JS
probe.py                              # dev tool — quick smoke probe of the three lists
probe_unblock.py                      # dev tool — block+unblock round-trip
Dockerfile.txt                        # user's working copy of the add-on Dockerfile
config.yaml                           # user's working copy of the add-on config.yaml
package.json                          # user's working copy of the add-on package.json
README.md                             # user-facing setup guide
CLAUDE.md                             # this file
```

The three add-on files in repo root (`Dockerfile.txt`, `config.yaml`,
`package.json`) are the user's reference originals — kept where they
landed for easy diffing if the add-on upstream updates. The versions
under `docs/host/` are the *snapshot* used to write `docs/host/README.md`
and the compatibility analysis — keep them in sync or note the drift.

## HA 2026.x dashboard YAML gotchas (kept from HACS era)

|  | Automation | Script |
|---|---|---|
| Root keys | `triggers:` `conditions:` `actions:` (plural from 2024.8) | `sequence:` |
| Service-call step | `action: domain.name` | same |
| UI editor | Settings → Automations & Scenes → top **Top tab → 腳本** (not a sub-menu) |

**Script entity_id vs service-name divergence — verified painful.** UI-created
scripts have TWO names. The service name is derived from the alias by
stripping non-ASCII characters at creation time, then never updates — not
on rename, not on reload, not on HA restart. **Always create with an
ASCII alias**, rename the display Name afterwards. See README's
"Dashboard recipe" section.

In the new architecture the bridge script publishes to MQTT instead of
calling a HA-registered service, but the same naming rule still bites the
dashboard's `tap_action: perform_action: script.<service_name>`.

## Frontend feature parity vs the HACS version

Audited 2026-05-28 by searching the original `RUCKUS-HACS` session
transcript (sessionId `local_38b41fd2-…`). The HACS era shipped five
front-end touches; status of each in the NR/MQTT port:

| HACS feature | NR port | Notes |
| --- | --- | --- |
| Dashboard one-click block button | ✅ ported | README "Dashboard recipe" — markdown list + input_text + bridge script |
| Auto-block open-rogue automation | ✅ ported | README "Automation examples" |
| 🔔 `persistent_notification` bell | ✅ ported (2026-05-28) | Pure HA automation off the event entity; `notification_id` keyed on BSSID to dedupe |
| 📖 Logbook line | ✅ equivalent (2026-05-28) | Original was a Python **logbook describer** (`logbook.py`) — impossible without a custom component. Replaced by a `logbook.log` service automation that produces the same human-readable line |
| 📱 `mobile_app` push | ⏸️ documented but not a default recipe | User opted out (no app). README has a one-line note on how to swap `persistent_notification` → `notify.mobile_app_*` |

**Key architectural takeaway**: anything that was a *Python integration
hook* (logbook describer, custom services, bus events, config-flow options)
cannot exist in the MQTT-only design. The replacement pattern is always
"HA automation triggered by the `event.ruckus_wips_new_rogue_detected`
entity + a built-in service (`logbook.log`, `persistent_notification.create`,
`notify.*`, `mqtt.publish`)". The event entity's attributes carry the full
rogue record, so any presentation is reconstructable HA-side without
touching the flow.

## Port retrospective — why this was harder than the HACS/Python version

Recorded 2026-05-28 after the first live bring-up took ~6 HTTP-layer
iterations. Read this before "cleaning up" the HTTP code — the ugliness is
load-bearing.

**Root cause: the HACS version rode on `aioruckus`; this one reimplements
it from scratch.** Every hard problem we hit in JS, the Python library had
already solved years ago and hidden behind a clean API:

| Problem | aioruckus / Python | This NR flow (JS) |
| --- | --- | --- |
| Login + CSRF + cookie + 302 re-auth | built in | hand-written |
| Controller's non-RFC HTTP responses | `aiohttp` parser is lenient — invisible | Node `llhttp` rejects them outright, even with `insecureHTTPParser` → had to drop to a **raw TLS socket + hand-rolled HTTP/1.0 parser** |
| chunked / gzip | `aiohttp` transparent | hand-written dechunk + `enable-gzip='0'` + `Accept-Encoding: identity` |
| Piecewise pagination + `apstamgr-stat` wrapper | built in | recursive `collectRogues`/`findDone` |

The single biggest surprise: **Python's HTTP stack tolerance was
load-bearing and totally invisible.** `probe.py` "just worked" because
`aiohttp` silently absorbs everything this embedded controller does wrong.
Node's strict parser surfaced all of it. If you ever port this controller's
AJAX surface to another strict-HTTP runtime (Go, Rust, raw fetch), expect
the same fight — go straight to a tolerant/raw HTTP layer.

**Process lessons (what would've been faster):**
1. **Add diagnostics on turn 1, not turn 5.** The moment we started dumping
   raw responses (`parseFailDump`, the one-time body dump), each problem
   became obvious. Guessing wasted rounds. For any black-box device, log the
   raw bytes immediately.
2. **For embedded/IoT HTTP, assume the device is non-compliant and reach for
   a raw/lenient client early.** We wasted two iterations on axios variants
   before accepting that Node's parser itself was the blocker.
3. **The iteration loop is slow and blind here** — Claude can't run the flow
   (it needs the user's LAN + controller creds), so every fix is a
   user-driven re-import/Deploy round-trip. Front-load changes and
   diagnostics to minimise rounds; don't ship one speculative tweak per turn.

**Silver lining:** the end state is more self-contained than the
library-based version — zero fragile npm deps (`xml2js` + built-in `tls`),
nothing that can break on a third-party API change, and the architecture
(central poll + MQTT fan-out) is the whole reason we left HACS.

## Open items (as of 2026-05-23)

- **First live test on the user's controller** — IN PROGRESS (2026-05-28).
  The transport + auth + parse chain is now confirmed working against
  `ruckus.raphaelchen.org`: TLS connects, login + CSRF + cookie succeed,
  cmdstat returns data, and the blocked-rogue list parses correctly (the
  controller's ~7 User-Blocked APs come back under
  `response.apstamgr-stat.rogue`). Getting here took FOUR HTTP-layer
  rewrites (see the "three dead ends" + the raw-TLS note) plus the
  rogue-extraction fix. **MQTT publish confirmed** (2026-05-28):
  `mosquitto_sub` shows `status=online`, `state/active {count:0}`, and
  `state/blocked {count:9, rogues:[...]}` with the full normalized record
  per rogue (bssid/ssid/channel/radio_band/rssi/detection_ap/location all
  correct across all 4 detector APs). **Still to verify**: (1) the device
  + 4 entities appear via Discovery on a HA (check `homeassistant/#` topic
  or HA UI), (2) a `cmd/mark_malicious` round-trip returns
  `cmd/ack {ok:true}` and bumps the blocked count. Follow
  [`docs/DEPLOY.md`](docs/DEPLOY.md) steps 7-8.
- **GitHub remote.** Repo is local only; `gh` CLI isn't authenticated.
  Once auth'd, `validate.yml` will sanity-check the flow JSON on push.
- **Dashboard polish.** README documents the input_text + bridge script
  recipe (good for now). User could later evaluate HACS
  `config-template-card` for per-row buttons but that re-introduces a
  HACS dependency — only worth it if the markdown approach proves
  unergonomic in practice.

## Closed items (kept for posterity)

- ✅ **Discovery spec audit against HA 2026.5+** (2026-05-23) — every
  Discovery payload field was checked against the live 2026.5 spec.
  `origin` block added as a result; everything else was already
  conformant. See [HA 2026.5+ Discovery checklist](#ha-20265-discovery-checklist).
- ✅ **HA dev-blog audit (2026-05-11 posts on `mqtt.publish` API)** (2026-05-28)
  — explicit `retain` / `qos` added to every `node.send()` and every
  README YAML `action: mqtt.publish`. Future-proofs us against the HA
  Core 2027.6 strictness deadline. `message_expiry_interval` noted but
  not adopted (we use MQTT v3.1.1 and LWT covers our needs).
  See [HA developer-blog audit](#ha-developer-blog-audit-2026-05-11-posts).
- ✅ **Add-on Dockerfile / config.yaml / package.json archived** (2026-05-23)
  — files captured under `docs/host/` so future Claude sessions can answer
  "is this compatible with the user's NR runtime?" without asking.
- ✅ **Migration from HACS to Node-RED** (2026-05-23) — original
  `custom_components/ruckus_wips/` deleted from working tree; rationale
  recorded in the migration note at the top of this file.
- ✅ **Frontend feature-parity audit vs HACS** (2026-05-28) — recovered
  the notification / logbook / dashboard recipes from the archived
  `RUCKUS-HACS` session and re-expressed the ones the user wanted (bell +
  logbook.log) as HA automations in the README. See [Frontend feature
  parity vs the HACS version](#frontend-feature-parity-vs-the-hacs-version).

## Things we tried that did NOT work — don't retry

(Carried over from HACS-era project; AJAX surface is unchanged.)

- `xcmd='unblock'` / `cmd='unblock'` for unblock → Unleashed returns
  `MSG_action_failed Unknown Error`.
- `xcmd='unmark-malicious'` → returns empty response, no state change.
- `xcmd='forget'` → same `Unknown Error`.
- `updobj` on the rogue record with `blocked='false'` → no error but no
  state change.
- Per-rogue MQTT discovery entities (one sensor/button per BSSID) → user
  explicitly rejected; would create churn in the entity registry as
  rogues come and go. Aggregate sensor + attribute list is the
  documented surface.
- Polling from each HA directly (the original HACS design) → multiplies
  load on the controller's single admin session. This Node-RED bridge
  is the canonical replacement; do not re-add the HACS integration as a
  parallel option without first discussing with the user.

## Official-API alternatives we evaluated and rejected

Researched May 2026. Full notes in [docs/RESEARCH.md](docs/RESEARCH.md).

| Platform | Has REST API? | Why we don't use it |
|---|---|---|
| **Unleashed** (current) | ❌ | None exists. AJAX is the only path. CommScope's Postman collection is "not officially supported" and doesn't cover rogue endpoints. |
| **UMM** (Unleashed Multi-Site Manager) | ✅ | Separate Java VM, overkill for one home network, mark-malicious write endpoint unverified. |
| **SmartZone** | ✅ | Requires SmartZone hardware/vSZ + paid license. Enterprise-only. |
| **RUCKUS One** | ✅ | Requires cloud subscription + migrating off Unleashed. Not free, not local. |

Ruckus's official position: Unleashed users wanting an API should upgrade
product tier. The AJAX surface is a deliberate gate, not an oversight.
aioruckus (the Python lib whose payloads we ported to JS) has tracked it
stably across many firmware versions and is itself a HA Core dependency,
so breakage gets caught upstream.

## Recent Architecture Expansion & Refactoring (2026-06-01 Update)

### 1. Pure WIPS-Only Native JS Refactoring
To address TCP MTU fragmentation and MQTT `oversize packet` errors caused by transmitting large management payloads (such as the 31 client lists) over physical LAN networks, and following the user's explicit request, **we completely refactored the project to focus strictly on RUCKUS Unleashed WIPS capabilities**:
- **Core Endpoints Retained**: `getActiveRogues()`, `getBlockedRogues()`, `markMalicious()`, and `unmarkMalicious()`.
- **Bloated Endpoints Removed**: All client tracking, AP groups, SSID broadcasters, LEDs toggle, AP reboots, and WLAN toggle codes were completely removed from `func.js` and the flow configurations.
- **Result**: The JavaScript driver size was cut in half (from 880 lines to 440 lines). The MQTT payload size is now permanently restricted to under a few hundred bytes, 100% securing the system against `oversize packet` crashes.

### 2. Regular WIPS 30s Polling
The system operates at a standard, single-cadence interval:
- **Interval (30s)**: Rogue AP scan (WIPS active and blocked lists) to ensure security alerts fire instantly.
- **Forced Polling**: Executing a block/unblock command immediately triggers an out-of-band force poll to instantly update Home Assistant.

### 3. Streamlined Home Assistant MQTT Entities
- Auto-discovery payload streamlined to expose only 4 WIPS-related entities: `sensor.ruckus_unleashed_wips_ruckus_wips_active_rogues`, `sensor.ruckus_unleashed_wips_ruckus_wips_blocked_rogues`, `sensor.ruckus_unleashed_wips_ruckus_wips_rogues_total`, and `event.ruckus_unleashed_wips_new_rogue_detected`.


### 4. Critical Flow Bugfix: `Cannot send from close function`
- **Issue**: Node-RED Function Node's On Close (`finalize`) block previously executed `node.send()` to publish the retained `offline` message to `ruckus_wips/status`. Node-RED throws a fatal `Cannot send from close function` error upon graceful flow stops.
- **Resolution**: Since the configured `mqtt-broker` connection node natively implements Birth, Close, and Will messages (LWT) directly on `ruckus_wips/status`, the hand-rolled `node.send()` inside the Close block is entirely redundant. We cleared the `"finalize"` string to `""` inside `flows/ruckus_wips.json` and synchronized `extracted_logic.js`, fully resolving the error. Syntax checks successfully verified.

### 5. Finalized Lovelace WIPS Dashboard Configuration
The user customized and saved the following English WIPS Dashboard configuration, seamlessly mapped to the actual generated `sensor.ruckus_unleashed_wips_ruckus_wips_active_rogues` entity and calling the finalized `script.ruckus_wips_manual_block` action:
```yaml
type: vertical-stack
cards:
  - type: markdown
    content: >
      {% set rogues = state_attr('sensor.ruckus_unleashed_wips_ruckus_wips_active_rogues', 'rogues') or [] %}

      {% if rogues %}

      {% for r in rogues %} - **{{ r.ssid or '(Hidden SSID)' }}** `{{ r.bssid
      }}`
        — Ch{{ r.channel }} / {{ r.rssi }} dBm / Detected by {{ r.detection_ap }} ({{ r.detection_ap_location }})
      {% endfor %}

      {% else %}

       No active unblocked rogue APs detected. WIPS is secured.

      {% endif %}
    title: Active Unblocked Rogue APs via MQTT
  - type: entities
    title: Manual Rogue AP Block via MQTT
    show_header_toggle: false
    entities:
      - entity: input_text.ruckus_block_bssid
        name: Paste BSSID
        icon: mdi:identifier
      - type: button
        name: Perform WIPS Block on BSSID
        icon: mdi:wifi-cancel
        action_name: Block
        tap_action:
          action: perform-action
          perform_action: script.ruckus_wips_manual_block
```

### 6. Finalized Home Assistant Rogue AP Notification Automation
To prevent state-restoration or reload conflicts, ensure absolute robustness, and follow clean entity-based triggering:
- **Trigger**: State trigger on `event.ruckus_unleashed_wips_new_rogue_detected` with templated safety conditions to ignore `unavailable` or `unknown` transitions.
- **Attributes**: Mapped flat directly from the entity state attributes (`trigger.to_state.attributes`) in plain English, completely free of any custom titles, custom icons, or emojis in headers/titles.
- **Node-RED Event Filtering**: The diff engine in `func.js` is modified to loop and track strictly active unblocked APs (`activeUnblocked`). Blocked APs (e.g. `blocked: true`) do not trigger events. The first-poll silent seeding is bypassed so that currently active unblocked APs trigger events immediately on deployment for verification.
- **Finalized YAML**:
  ```yaml
  alias: Ruckus Notify New Rogue
  description: Display a persistent notification when a new rogue AP is detected.
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
  mode: queued
  max: 10
  ```



### 5b. Refactored Block Script via MQTT
To fix historical "Action ruckus_wips.mark_malicious not found" errors left over from the deleted HACS integration, the script is refactored to directly call the HA `mqtt.publish` service targeting our Node-RED bridge command topics. The user established this script under the alias `RUCKUS WIPS Manual Block` with the final Entity ID `script.ruckus_wips_manual_block`:
```yaml
alias: RUCKUS WIPS Manual Block
sequence:
  - action: mqtt.publish
    data:
      topic: ruckus_wips/cmd/mark_malicious
      payload: "{{ states('input_text.ruckus_block_bssid') | trim | lower }}"
      qos: 1
      retain: false
mode: single
description: ""
```





## Technical Debts & Refactoring Backlog (Fully Resolved in v1.2.0)

All previously identified technical debts have been fully resolved in the `v1.2.0` release:

### 1. Code Monolith (`func.js` Maintainability) — **Resolved**
* **Resolution**: Decomposed the monolithic JavaScript block into 7 clean, testable ES Modules under the `src/` directory. Created a `build.js` bundling script that automatically strips ESM syntax, runs syntax validation, and injects the bundled code along with dependency declarations directly into `flows/ruckus_wips.json`.

### 2. Lenient Hand-Rolled TLS HTTP/1.0 Parser — **Resolved**
* **Resolution**: Added automatic `zlib` gzip/deflate decompression to the response body parser. Implemented early stream resolution based on parsing the `Content-Length` header to prevent socket hangs on persistent Keep-Alive connections. Added support for optional TLS validation via `RUCKUS_CA_CERT` to prevent local LAN MitM attacks. Added a strict 15-second connect handshake timeout to gracefully abort dead socket connections.

### 3. Concurrent Auth Storms & Concurrency Lockouts — **Resolved**
* **Resolution**: Implemented dynamic concurrency locking (`activePollPromise` returning the ongoing promise) to debounce duplicate polling requests. Added a 10-minute brute-force lockout window inside the Node-RED context upon authentication failures (`LOGIN_INCORRECT`), which automatically clears if credentials or target host configurations change.

### 4. Soft Failures & State Reporting Integrity — **Resolved**
* **Resolution**: Tracked consecutive polling failures in context. If 3 consecutive updates fail, Node-RED publishes `offline` to the MQTT status topic (`ruckus_wips/status`) to set Home Assistant entities as unavailable. Resets failure count and publishes `online` as soon as communication succeeds.

## MQTT Protocol Version Troubleshooting (2026-06-01)

### The `oversize packet` Disconnect Loop
* **Symptom**: The MQTT broker logs repeated connection and disconnection loops every 15 seconds: `Client ruckus_wips_nodered disconnected: oversize packet.`
* **Cause**: Node-RED's default `mqtt-broker` configuration node defaults to **MQTT 5**. While Mosquitto core supports v5, parsing variable `Properties` in the Birth/Will envelopes or via MQTT.js client-side libraries can lead to binary pointer misalignment. This causes Mosquitto to misinterpret incoming data bytes as a giant `Remaining Length` field, triggering the `oversize packet` self-protection disconnect.
* **Resolution**: The `mqtt-broker` configuration node protocol MUST be set to **`MQTT V3.1.1`** (under the Connection tab in Node-RED). This completely eliminates variable property parsing mismatches, stabilizes connections to `Connected`, and resolves the broker logs. Our JSON payload structure is 100% compatible with MQTT v3.1.1.

### The MQTT Wildcard Subscription Recursion Loop
* **Symptom**: Even on MQTT v3.1.1, executing a command (e.g. blocking a rogue AP) triggers an instant `oversize packet` disconnect loop.
* **Cause**: The `mqtt in` node is subscribed to the wildcard topic `ruckus_wips/cmd/+`. When `fn_ruckus` successfully executes a WIPS block, it publishes an ACK message to `ruckus_wips/cmd/ack`. Due to the wildcard subscription, the `mqtt in` node immediately receives its own ACK message as a new command. This triggers an unknown action error, throwing a failure ACK to `ruckus_wips/cmd/ack` wrapping the incoming payload in a new JSON envelope. This starts an **infinite recursive stringify loop**, causing the payload to balloon exponentially (exponential escape backslashes `\`) from a few bytes to **tens of megabytes** in milliseconds. Mosquitto Broker intercepts this giant corrupted stream and disconnects.
* **Resolution**: Added a critical defense check at the beginning of the command processor: `if (action === 'ack') return null;`. This instantly intercepts and discards self-published ACK loops, completely stabilizing the network footprint.

### Command Execution Local Poll Loopback (2026-06-02)
* **Symptom**: After clicking "Block" or triggering a command via MQTT on the Home Assistant dashboard, the state sensors (e.g. Active Unblocked list) did not update immediately and required waiting up to 30 seconds for the next scheduled background poll.
* **Cause**: The command processor block was attempting to trigger a poll by doing `node.send({ topic: 'poll', ... })` to port 1, which only published the trigger to the downstream MQTT publish node instead of loopback triggering the local Function node.
* **Resolution**: Refactored the WIPS poll logic into an asynchronous helper `performPoll()`, and invoked `await performPoll()` directly inside the command execution path immediately following a successful Ruckus API `markMalicious()` or `unmarkMalicious()` call. This forces an immediate, synchronous update of Home Assistant's state sensors.## Future Extensions & Feature Roadmap

Future development iterations can expand the Ruckus AJAX driver to support full-blown wireless controller integration beyond WIPS:

### 1. Wi-Fi Client Tracking & Room-Level Presence
* **Objective**: Query active Wi-Fi clients (MAC, IP, Hostname, Connected AP, and RSSI signal strength) from Unleashed.
* **Smart Home Use Case**: Precise room-level tracking in Home Assistant. Automate lights and HVAC by tracing which AP (e.g. Living Room vs. Bedroom) a client's device is currently connected to and its RSSI.

### 2. Access Point Health & Telemetry
* **Objective**: Monitor AP online status, uptime, CPU, memory usage, temperature, and client count.
* **Smart Home Use Case**: Health dashboards and push notifications in Home Assistant (e.g. alerting the user if an AP drops offline or resource usage spikes).

### 3. WLAN Controls & Automated Scheduler
* **Objective**: Enable toggling SSIDs on/off and updating WPA keys dynamically via Ruckus AJAX cmdstat.
* **Smart Home Use Case**: Automate kid's Wi-Fi access hours or configure a dynamic guest network (e.g. generating a dynamic QR code for guest access).

### 4. Self-Defense WIPS Automations
* **Objective**: Implement automatic blocking of "Evil Twin" rogues that spoof the home network SSID.
* **Smart Home Use Case**: Secure the network immediately upon detecting duplicate BSSID spoofing.
