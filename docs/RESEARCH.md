# Research log — RUCKUS WIPS for Home Assistant

Captures the references and findings that informed this integration's
design. Pin this to memory; do not delete the URLs.

## RUCKUS R720 and management options

The R720 (Wave 2 802.11ac, 4×4, dual-band) can be managed under any of:

- **Unleashed** — controller-less, master AP runs the management plane.
  Reverse-engineered AJAX/JSON API; no public spec. **This is our target.**
- ZoneDirector — legacy hardware/virtual controller, same AJAX surface.
- SmartZone (SZ100 / vSZ) — enterprise; has a documented public REST API.
- RUCKUS One — cloud SaaS; OAuth2 + REST.

Sources:
- [R720 Unleashed firmware 200.15 GA](https://support.ruckuswireless.com/software/3937-ruckus-unleashed-ap-200-15-ga-software-for-r720)
- [Unleashed Rogue AP detection overview](https://docs.commscope.com/bundle/unleashed-200.9-onlinehelp/page/GUID-93201ABA-0628-497F-9A96-6C6FF9E9982E.html)
- [Unleashed Intrusion Detection and Prevention](https://docs.ruckuswireless.com/unleashed/200.6/GUID-C145C267-9752-4F2B-9AE7-CE2BACDF7DB0.html)
- [SmartZone Public API Reference (5.2.1)](https://docs.ruckuswireless.com/smartzone/5.2.1/vszh-public-api-reference-guide-521.html) — for if we ever extend to SmartZone

## WIPS rogue model on Ruckus (3 categories)

- **Currently Active Rogue Devices** — `LEVEL=1, recognized != true`. Note:
  this list INCLUDES entries that have already been marked malicious.
- **Known / Recognized Rogue Devices** — whitelist neighbors. `recognized=true`.
- **User Blocked Rogue Devices** — marked malicious. `blocked=true`. AP
  broadcasts deauth on these BSSIDs continuously.

The "block" action is deauth-broadcast spoofing — Ruckus AP sends
disassociation/deauthentication frames using the rogue's BSSID. Clients
think the rogue dropped them and won't re-associate.

## aioruckus library

- Source: https://github.com/ms264556/aioruckus
- PyPI: https://pypi.org/project/aioruckus/
- Latest at session: `0.42`
- Supports Unleashed (all) and ZoneDirector (9.10+); does NOT cover SmartZone
- Already a HA Core dependency (used by the official `ruckus` integration
  which only does device_tracker)

### Relevant methods (verified by reading `ruckusajaxapi.py`)

| Method | Purpose | Underlying XML |
|---|---|---|
| `get_active_rogues()` | Active list | `<rogue LEVEL='1' recognized='!true'/>` |
| `get_known_rogues(limit=300)` | Known list (paged) | `recognized=true` filter |
| `get_blocked_rogues(limit=300)` | Blocked list (paged) | `blocked=true` filter |
| `do_block_client(mac)` | Block a CLIENT (not rogue AP) | `xcmd='block' tag='client'` |
| `do_unblock_client(mac)` | Unblock client | `updobj` on acl-list |
| `get_system_info()` | Master AP identity | — |

No method exists for marking rogues malicious. We send raw AJAX via
`session.api.cmdstat(payload)`.

## Verified AJAX payloads against user's R720

### Block (probe-1 winner, verified `xmsg.type=0`)

```xml
<ajax-request action='docmd' xcmd='block' checkAbility='10' comp='stamgr'>
  <xcmd check-ability='10' tag='rogue' cmd='block' mac='{bssid}'/>
</ajax-request>
```

### Unblock (captured from Unleashed UI DevTools; symmetric guesses failed)

```xml
<ajax-request action='docmd' xcmd='unblockrogue' check-ability='10' comp='stamgr'>
  <xcmd cmd='unblockrogue' tag='rogue' rogue='{bssid}'/>
</ajax-request>
```

Asymmetry: block uses `mac=`, unblock uses `rogue=`. Block uses `cmd='block'`,
unblock uses `cmd='unblockrogue'`. Do not "normalize" without retesting.

### Failed unblock guesses (record so we don't repeat)

- `xcmd='unblock'` → `Unknown Error`
- `xcmd='block' cmd='unblock'` → `Unknown Error`
- `xcmd='unmark-malicious'` → silent no-op
- `xcmd='forget'` → `Unknown Error`

## Live snapshot of user's controller (anonymize before redistributing)

- 3 R720 APs: `R720-1F`, `R720-2F`, `R720-3F` (LIVING / MASTER / BOOTS' ROOM)
- 8 active rogues at probe time, 7 already blocked from prior manual marking
- Master serial `402003001468`, firmware `200.15.6.212 build 27`

## Home Assistant 2026.5.0

- [Release notes](https://www.home-assistant.io/blog/2026/05/06/release-20265/)
- [Full changelog](https://www.home-assistant.io/changelogs/core-2026.5/)
- Relevant deprecations:
  - Legacy `device_tracker` platform API
  - Entity IDs with mismatched domains (warn)
  - `OptionsFlowWithConfigEntry` (deprecated 2024.11, gone soon)

### HACS distribution

- [Integration in HACS](https://www.hacs.xyz/docs/use/repositories/type/integration/)
- `hacs.json` at repo root, integration sources under `custom_components/<domain>/`
- Brand assets go to https://github.com/home-assistant/brands under
  `custom_integrations/<domain>/` (PR-only flow)

### HA developer references

- [Config Flow handler](https://developers.home-assistant.io/docs/config_entries_config_flow_handler/)
- [Modern integration blueprint (2026.4+ patterns)](https://github.com/jpawlowski/hacs.integration_blueprint)

## Ruckus official API landscape (researched May 2026)

Definitive answer to "is there an official API I can use instead of scraping AJAX?": **for standalone Unleashed, no.** The only platforms with documented public REST APIs are:

| Platform | API doc | Caveat |
|---|---|---|
| Unleashed (this user's) | none | only AJAX, unsupported |
| ZoneDirector | none | same |
| [UMM v2.9](https://support.ruckuswireless.com/documents/4793-ruckus-unleashed-multi-site-manager-umm-v2-9-ga-api-reference-guide) | ✅ | extra Java server running above Unleashed; R720 + Unleashed 200.5+ supported; reporting endpoints include rogue, but **mark-malicious write capability is unverified** |
| [SmartZone 7.1](https://support.ruckuswireless.com/documents/4934-smartzone-7-1-0-lt-ga-public-api-reference-guide-vsz-e) | ✅ | requires enterprise controller hardware/vSZ VM with paid license |
| [RUCKUS One](https://docs.ruckus.cloud/api) | ✅ | cloud only, OAuth2/JWT, paid subscription |
| [Ruckus IoT Controller](https://docs.ruckuswireless.com/iot/iot-restapiguide.html) | ✅ | for BLE/Zigbee not Wi-Fi |
| [RUCKUS AI](https://support.ruckuswireless.com/documents/4993-ruckus-ai-rest-api) | ✅ | AIOps overlay above SmartZone/RUCKUS One |

### UMM specifics (the only realistic alternative for this user)

- **Architecture:** UMM is a Java application that sits *above* one or more Unleashed networks. The Unleashed master AP still controls the radios; UMM talks to it via SNMP + TR-069 to aggregate and report. **Not** a replacement for the master AP.
- **Compatibility:** R720 supported since UMM v2.0 (current GA: v2.9). Unleashed 200.5+ required; Raphael's 200.15.6.212 is fine.
- **Deployment:** `.ova` for VMware, `.iso` for bare-metal/other hypervisors, `.tar` for upgrade. No official Docker image. ~4 vCPU / 4 GB RAM / 60 GB disk. Needs network reachability to the Unleashed master.
- **API:** confirmed rogue *reporting* endpoints exist ("Reports are categorized to AP, WLAN, Client and Rogue"). Mark-malicious write endpoint not confirmed without deploying.
- **Cost/benefit for a single-home network:** poor. UMM is built for multi-site aggregation; ~70% of features are unused here. Extra VM to maintain, and we'd still need AJAX for any action UMM doesn't proxy.

### Ruckus's official position

From [RUCKUS Forums - Unleashed API thread](https://community.ruckuswireless.com/t5/Unleashed/Unleashed-API/m-p/76), Ruckus employees consistently state:
- No published REST API for Unleashed itself.
- AJAX exists but is not supported.
- "If you need programmatic access, use SmartZone or RUCKUS One."

This is a deliberate product-tier gate. We're outside their intended use case but mitigated by aioruckus's status as a HA Core dependency.

## Existing HA integration we deliberately don't replace

- [Built-in `ruckus` integration](https://www.home-assistant.io/integrations/ruckus_unleashed/)
- Supports Unleashed/ZD/SmartZone/RUCKUS One
- Only exposes `device_tracker` (presence). No WIPS, no rogue surface.
- Coexists with this integration — they operate on different feature
  surfaces, don't conflict.
