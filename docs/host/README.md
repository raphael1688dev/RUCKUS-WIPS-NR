# Host environment reference

Snapshots of the actual Node-RED add-on Raphael runs. Kept here so a future
Claude session can answer "is my flow compatible with the user's runtime?"
without having to ask.

## Files

| File | Source |
| --- | --- |
| [`nodered-addon.Dockerfile`](nodered-addon.Dockerfile) | Frenck's `hassio-addons/addon-node-red` Dockerfile |
| [`nodered-addon.config.yaml`](nodered-addon.config.yaml) | The add-on's `config.yaml` (capabilities, options schema) |
| [`nodered-addon.package.json`](nodered-addon.package.json) | The add-on's `package.json` (pre-installed Node-RED bundle) |

## Key facts derived from the Dockerfile

| Property | Value | Source |
| --- | --- | --- |
| Base image | `ghcr.io/hassio-addons/base:20.1.1` (Alpine) | Dockerfile L1 |
| Node.js | `24.14.1-r0` | Dockerfile L27 |
| npm | `11.11.0-r0` | Dockerfile L28 |
| NR core | `4.1.10` (via npm install from package.json) | package.json L15 |
| Health-check port | `46836` (Frenck's choice; non-standard) | Dockerfile L60 |
| Patches | `node-red-dashboard-show-dashboard.patch` to `node-red-dashboard` | Dockerfile L44 |

## Key facts from `config.yaml`

| Property | Value | Implication for the flow |
| --- | --- | --- |
| `ingress: true`, `ingress_port: 0`, `ingress_stream: true` | enabled | NR UI accessed via HA's sidebar, no direct port |
| `host_network: true` | enabled | NR shares the host's network namespace. Means: ✅ direct access to Ruckus by `ruckus.raphaelchen.org`; ⚠️ resolving other add-ons by short name (`core-mosquitto`) depends on supervisor's DNS injection |
| `hassio_api: true`, `homeassistant_api: true`, `auth_api: true` | all on | NR can call HA APIs directly (we don't use this — we use MQTT — but it's there as a fallback) |
| Mapped volumes | `addon_config:rw`, `homeassistant_config:rw`, `media:rw`, `share:rw`, `ssl` | NR can read/write HA config dir if ever needed |
| `ssl: true`, `certfile: fullchain.pem`, `keyfile: privkey.pem` | default | NR UI uses HA's SSL by default |
| `options.npm_packages: []` | empty by default | Available to pin any npm module the flow's `libs` can't resolve; not needed today (flow uses only `xml2js` + the built-in `tls`) |
| `options.init_commands: []` | empty by default | Available for arbitrary boot-time shell commands |
| `homeassistant: 2023.3.0` | add-on's declared min HA version | Comfortably below the 2026.5+ our flow targets |

## Key facts from `package.json`

NR core version and pre-installed contrib packages (May 2026):

```
node-red                                       4.1.10
node-red-contrib-home-assistant-websocket      0.80.3   ← could be a fallback path
node-red-dashboard                             3.6.6
node-red-contrib-bigtimer                      2.8.6
node-red-contrib-cast                          0.2.17
node-red-contrib-counter                       0.1.6
node-red-contrib-influxdb                      0.7.0
node-red-contrib-interval-length               0.0.6
node-red-contrib-modbus                        5.45.2
node-red-contrib-moment                        5.0.0
node-red-contrib-persistent-fsm                1.2.1
node-red-contrib-sunevents                     3.1.1
node-red-contrib-time-range-switch             1.2.0
node-red-node-base64                           1.0.0
node-red-node-email                            5.2.3
node-red-node-feedparser                       1.0.7
node-red-node-ping                             0.3.3
node-red-node-random                           0.4.1
node-red-node-serialport                       2.0.3
node-red-node-smooth                           0.1.2
node-red-node-suncalc                          1.2.0
node-red-node-twitter                          1.2.0
@node-red-contrib-themes/theme-collection      4.1.1
bcryptjs / js-yaml / line-by-line / source-map-support
```

### What's NOT in the bundle — needed by our flow

Our function node's `libs` block pulls these from npm on first Deploy into
the **persistent** `/data/node_modules` directory (not the image-baked
`/opt/node_modules`):

- `xml2js`
- `tls` (Node built-in, no install — just declared so it's import-able)

(The flow opens a raw `tls` socket and speaks HTTP/1.0 by hand rather than
using axios or Node's `http`/`https`: the controller emits HTTP responses
Node's parser rejects even with `insecureHTTPParser` — Python's `aiohttp`
tolerates them, Node doesn't. Parsing the bytes ourselves is the only thing
that worked. `rejectUnauthorized:false` covers the self-signed cert; the
session cookie is hand-managed. See `docs/DEPLOY.md` / CLAUDE.md for the
full story.)

If you ever need to force-refresh a dependency, delete the relevant
directory under `/data/node_modules` (NOT `/opt/node_modules`) from the
add-on Terminal & SSH, then Deploy in the NR UI.

### Fallback we have but don't currently use

`node-red-contrib-home-assistant-websocket` is pre-installed. If MQTT ever
proves problematic (broker outage, multi-tenant ACL pain, whatever) we
have the option to switch to direct HA websocket calls — push state into
HA via the `events: state` node, drive commands via `call service` node.
Not the current architecture, just noted as a known viable Plan B.

## Verifying broker hostname resolution

Because `host_network: true`, the NR container is on the host's network
namespace. `core-mosquitto` MAY or MAY NOT resolve via DNS depending on
how Supervisor sets `/etc/resolv.conf`. Test order:

1. **Try `core-mosquitto` first** in the `mqtt_broker` config node — this
   is what Mosquitto's Configuration docs document and usually Just Works.
2. **If it fails to connect**, fall back to one of:
   - `127.0.0.1` (loopback works with `host_network`)
   - HA host's LAN IP (`192.168.88.x` for Raphael)
   - `homeassistant.local` (mDNS)

The flow's `mqtt_broker` config node currently uses `core-mosquitto`.
Change it in Node-RED → Configuration nodes if Try 1 fails.
