#!/usr/bin/env python3
"""Emit a notion-config.js fit for distribution.

`notion-config.js` is gitignored and may hold an OAuth client secret for local
use. A published build must not: a secret inside an extension is readable by
anyone who installs it. But it *should* keep the two public values - the client
id and the token exchange URL - because without them a store build has no
working sign-in at all, which is the single likeliest reason for a review to
fail.

So this reads the local file, keeps `clientId` and `exchangeUrl`, and writes the
secret out as empty. It also refuses to write a file that still contains the
secret, rather than trusting its own regex.

Usage: tools/appconfig.py --strip-secret --out PATH
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "notion-config.js"

TEMPLATE = '''// Generated for distribution by tools/appconfig.py - do not edit.
//
// The client id and the exchange URL are public. The client secret is not, and
// is deliberately absent: it lives on the endpoint in server/, which performs
// the token exchange. See server/README.md.
var LR_NOTION_APP = {
  clientId:     %s,
  clientSecret: "",
  exchangeUrl:  %s
};

if (typeof module !== "undefined" && module.exports) { module.exports = LR_NOTION_APP; }
'''


def field(text, name):
    """Read one string field out of the config, without executing it."""
    match = re.search(name + r'\s*:\s*"([^"]*)"', text)
    return match.group(1) if match else ""


def main():
    if "--out" not in sys.argv:
        print("usage: tools/appconfig.py --strip-secret --out PATH")
        return 2
    out = Path(sys.argv[sys.argv.index("--out") + 1])

    text = SOURCE.read_text() if SOURCE.exists() else ""
    client_id = field(text, "clientId")
    exchange = field(text, "exchangeUrl")
    secret = field(text, "clientSecret")

    body = TEMPLATE % ('"%s"' % client_id, '"%s"' % exchange)

    # Belt and braces: never ship a file containing the secret, whatever the
    # regexes above did or did not match.
    if secret and secret in body:
        print("refusing to write: the client secret is still present")
        return 1

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(body)
    print("%s written: clientId %s, exchangeUrl %s, secret omitted"
          % (out.name,
             "set" if client_id else "empty",
             "set" if exchange else "empty"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
