"""
Ruckus Unleashed WIPS probe — gathers the data we need to design the HACS integration.

Run on a machine that can reach your Unleashed master AP.

    pip install "aioruckus>=0.42"
    python probe.py <host> <username> <password>

It prints:
  1. Connection + system info (firmware confirmation)
  2. Active / known / blocked rogues (so we know real field names on YOUR firmware)
  3. A best-effort guess at the mark-as-malicious AJAX payload, executed against
     the first active rogue, then verified by re-reading the blocked list.
     If the guess is wrong, the actual payload still needs to be sniffed from
     the Unleashed Web UI (DevTools → Network → click "Mark as Malicious").

Nothing is sent anywhere. Sensitive fields (MAC, SSID) are NOT redacted in the
output — review before pasting back.
"""

import asyncio
import json
import sys
from contextlib import suppress

from aioruckus import AjaxSession
from aioruckus.exceptions import AuthenticationError


async def main(host: str, user: str, password: str) -> None:
    print(f"# Connecting to {host} as {user}")
    async with AjaxSession.async_create(host, user, password) as session:
        api = session.api

        print("\n## system info")
        with suppress(Exception):
            sysinfo = await api.get_system_info()
            print(json.dumps(sysinfo, indent=2, default=str)[:1500])

        print("\n## active rogues")
        active = await api.get_active_rogues()
        print(f"count = {len(active)}")
        print(json.dumps(active[:3], indent=2, default=str))

        print("\n## known rogues")
        known = await api.get_known_rogues()
        print(f"count = {len(known)}")
        print(json.dumps(known[:3], indent=2, default=str))

        print("\n## blocked rogues (already marked malicious)")
        blocked_before = await api.get_blocked_rogues()
        print(f"count = {len(blocked_before)}")
        print(json.dumps(blocked_before[:3], indent=2, default=str))

        if not active:
            print(
                "\n# No active rogues right now — cannot probe mark-malicious payload."
                "\n# Re-run when at least one rogue is visible in the Unleashed UI."
            )
            return

        target = active[0]
        mac = target.get("mac") or target.get("bssid") or target.get("MAC")
        if not mac:
            print(f"\n# Unexpected rogue record shape, no mac field: keys={list(target.keys())}")
            return

        print(f"\n## probing mark-malicious payload against rogue {mac}")
        print("# This is a *guess* derived from how do_block_client() is structured.")
        print("# It may fail harmlessly. If it succeeds, the rogue will appear in")
        print("# blocked_rogues and Unleashed will start de-authing clients of it.")

        guesses = [
            # Guess 1 — mirror of do_block_client but with tag='rogue'
            (
                "guess-1 tag=rogue cmd=block",
                f"<ajax-request action='docmd' xcmd='block' checkAbility='10' comp='stamgr'>"
                f"<xcmd check-ability='10' tag='rogue' cmd='block' mac='{mac}'/></ajax-request>",
            ),
            # Guess 2 — explicit mark-malicious xcmd
            (
                "guess-2 xcmd=mark-malicious",
                f"<ajax-request action='docmd' xcmd='mark-malicious' comp='stamgr'>"
                f"<xcmd cmd='mark-malicious' mac='{mac}'/></ajax-request>",
            ),
            # Guess 3 — set blocked attribute via updobj on rogue record
            (
                "guess-3 updobj rogue blocked=true",
                f"<ajax-request action='updobj' comp='stamgr'>"
                f"<rogue mac='{mac}' blocked='true'/></ajax-request>",
            ),
        ]

        succeeded = None
        for label, payload in guesses:
            print(f"\n### {label}")
            print(payload)
            try:
                resp = await api.cmdstat(payload)
                print(f"response: {json.dumps(resp, default=str)[:400]}")
            except Exception as exc:
                print(f"raised: {type(exc).__name__}: {exc}")
                continue

            # Verify by re-reading blocked list
            await asyncio.sleep(2)
            blocked_after = await api.get_blocked_rogues()
            now_blocked = any(
                (r.get("mac") or r.get("bssid") or r.get("MAC")) == mac
                for r in blocked_after
            )
            print(f"verified in blocked list? {now_blocked}")
            if now_blocked:
                succeeded = label
                break

        if succeeded:
            print(f"\n# WINNER: {succeeded}")
            print("# Tell me which one worked and I will wire it into the integration.")
        else:
            print(
                "\n# None of the guesses produced a blocked entry."
                "\n# Next step: open Unleashed UI → Admin & Services → Services → WIPS,"
                "\n# open browser DevTools → Network tab → filter XHR,"
                "\n# click 'Mark as Malicious' on a rogue,"
                "\n# copy the request body (the <ajax-request>...</ajax-request> XML) and paste it back to me."
            )


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print("usage: python probe.py <host> <username> <password>")
        sys.exit(2)
    asyncio.run(main(sys.argv[1], sys.argv[2], sys.argv[3]))
