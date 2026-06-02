"""
Phase-2 probe: discover the unblock payload.

Safety: picks the FIRST currently-blocked rogue, tries to unblock it, verifies,
then IMMEDIATELY RE-BLOCKS it so your environment ends in the same state it started.

    .venv/bin/python probe_unblock.py <host> <username> <password>
"""

import asyncio
import json
import sys

from aioruckus import AjaxSession


async def main(host: str, user: str, password: str) -> None:
    print(f"# Connecting to {host} as {user}")
    async with AjaxSession.async_create(host, user, password) as session:
        api = session.api

        blocked = await api.get_blocked_rogues()
        if not blocked:
            print("# No blocked rogues to test against. Block one in the UI first, then re-run.")
            return

        target = blocked[0]
        mac = target["mac"]
        print(f"\n## test target = {mac} ({target.get('ssid')})")

        guesses = [
            (
                "guess-A xcmd=unblock (mirror of block)",
                f"<ajax-request action='docmd' xcmd='unblock' checkAbility='10' comp='stamgr'>"
                f"<xcmd check-ability='10' tag='rogue' cmd='unblock' mac='{mac}'/></ajax-request>",
            ),
            (
                "guess-B xcmd=block cmd=unblock",
                f"<ajax-request action='docmd' xcmd='block' checkAbility='10' comp='stamgr'>"
                f"<xcmd check-ability='10' tag='rogue' cmd='unblock' mac='{mac}'/></ajax-request>",
            ),
            (
                "guess-C xcmd=unmark-malicious",
                f"<ajax-request action='docmd' xcmd='unmark-malicious' comp='stamgr'>"
                f"<xcmd cmd='unmark-malicious' mac='{mac}'/></ajax-request>",
            ),
            (
                "guess-D xcmd=forget",
                f"<ajax-request action='docmd' xcmd='forget' checkAbility='10' comp='stamgr'>"
                f"<xcmd check-ability='10' tag='rogue' cmd='forget' mac='{mac}'/></ajax-request>",
            ),
        ]

        winner = None
        for label, payload in guesses:
            print(f"\n### {label}")
            print(payload)
            try:
                resp = await api.cmdstat(payload)
                print(f"response: {json.dumps(resp, default=str)[:300]}")
            except Exception as exc:
                print(f"raised: {type(exc).__name__}: {exc}")
                continue

            await asyncio.sleep(2)
            still_blocked_macs = {r["mac"] for r in await api.get_blocked_rogues()}
            unblocked = mac not in still_blocked_macs
            print(f"removed from blocked list? {unblocked}")
            if unblocked:
                winner = (label, payload)
                break

        # restore prior state — re-block, no matter what happened
        print("\n## restoring original state (re-block)")
        try:
            await api.cmdstat(
                f"<ajax-request action='docmd' xcmd='block' checkAbility='10' comp='stamgr'>"
                f"<xcmd check-ability='10' tag='rogue' cmd='block' mac='{mac}'/></ajax-request>"
            )
            await asyncio.sleep(2)
            blocked_macs_after = {r["mac"] for r in await api.get_blocked_rogues()}
            print(f"re-blocked OK? {mac in blocked_macs_after}")
        except Exception as exc:
            print(
                f"!! WARNING re-block raised {type(exc).__name__}: {exc}\n"
                f"!! Manually re-mark {mac} as Malicious in the Unleashed UI if it is gone."
            )

        if winner:
            print(f"\n# WINNER: {winner[0]}")
        else:
            print(
                "\n# No guess unblocked the rogue."
                "\n# Sniff DevTools Network when clicking 'Unmark' / 'Remove' in the Unleashed UI"
                "\n# and paste the <ajax-request> XML back."
            )


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print("usage: python probe_unblock.py <host> <username> <password>")
        sys.exit(2)
    asyncio.run(main(sys.argv[1], sys.argv[2], sys.argv[3]))
