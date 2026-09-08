#!/usr/bin/env python3
"""Build manifest.json from manifest.base.json plus the local signing key.

Why this exists
---------------
An unpacked extension's id is derived from its folder path, so moving the
directory mints a new id and orphans everything keyed to the old one: stored
OAuth tokens, the redirect URI registered at Notion, the keyboard shortcut.
A `key` in the manifest fixes the id instead.

That key is derived here from notemill-key.pem, which is gitignored, so the
identity never enters the repository. It also keeps the committed manifest
store-ready: the Chrome Web Store assigns its own id and rejects nothing, but
a `key` left in a submitted manifest is at best pointless.

The key is looked up outside the repository: $NOTEMILL_KEY, then
~/Library/Application Support/Notemill/notemill-key.pem, then
~/.config/notemill/notemill-key.pem. Without one the id falls back to being
derived from the folder path.

Targets
-------
Chromium runs the background as a service worker and warns about anything
else; Firefox has no service workers under MV3 and wants an event page's
`background.scripts`. Carrying both in one manifest means a permanent warning
in whichever browser is not in use, so manifest.base.json holds Chrome's form
plus `__firefox_background`, and this script emits one or the other.

Usage: tools/manifest.py [--target chrome|firefox] [--out FILE] [--no-key] [--quiet]

`--no-key` omits the pinned id, which is what a Chrome Web Store submission
wants: the store assigns the id itself.
"""

import base64
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = ROOT / "manifest.base.json"
OUT = ROOT / "manifest.json"

# The key lives OUTSIDE the extension directory. Chromium loads an unpacked
# extension from the folder as-is and warns "This extension includes the key
# file ... You probably don't want to do that" - a private key inside a
# loadable, zippable directory is one careless `make` away from being shipped.
KEY_ENV = os.environ.get("NOTEMILL_KEY")
KEY_CANDIDATES = [
    Path(KEY_ENV).expanduser() if KEY_ENV else None,
    Path.home() / "Library/Application Support/Notemill/notemill-key.pem",
    Path.home() / ".config/notemill/notemill-key.pem",
]
KEY = next((p for p in KEY_CANDIDATES if p and p.exists()), None)


def public_key_b64(pem: Path) -> str:
    """The DER SubjectPublicKeyInfo of the private key, base64 as Chromium wants it."""
    der = subprocess.run(
        ["openssl", "rsa", "-in", str(pem), "-pubout", "-outform", "DER"],
        check=True, capture_output=True,
    ).stdout
    return base64.b64encode(der).decode("ascii")


def extension_id(key_b64: str) -> str:
    """Chromium's id: first 128 bits of the key's SHA-256, hex mapped onto a-p."""
    digest = hashlib.sha256(base64.b64decode(key_b64)).hexdigest()[:32]
    return "".join(chr(ord("a") + int(ch, 16)) for ch in digest)


def argument(name: str, default: str) -> str:
    """A tiny flag reader: --name value."""
    if name in sys.argv:
        index = sys.argv.index(name)
        if index + 1 < len(sys.argv):
            return sys.argv[index + 1]
    return default


def main() -> int:
    quiet = "--quiet" in sys.argv
    target = argument("--target", "chrome")
    if target not in ("chrome", "firefox"):
        print("unknown target %r; expected chrome or firefox" % target)
        return 2

    out_path = Path(argument("--out", str(OUT)))
    manifest = json.loads(BASE.read_text())
    firefox_background = manifest.pop("__firefox_background", None)

    if target == "firefox":
        if firefox_background:
            manifest["background"] = firefox_background
        # Firefox identifies the extension by its Gecko id and has no use for
        # a Chromium signing key.
        manifest.pop("key", None)

    if KEY is not None and target == "chrome" and "--no-key" not in sys.argv:
        key_b64 = public_key_b64(KEY)
        # Insert after "version" so the file reads the way it always has.
        rebuilt = {}
        for name, value in manifest.items():
            rebuilt[name] = value
            if name == "version":
                rebuilt["key"] = key_b64
        manifest = rebuilt
        if not quiet:
            print("id pinned to %s" % extension_id(key_b64))
    elif target == "chrome" and not quiet:
        print("no signing key found, so the id will follow the folder path.")
        print("  looked in: NOTEMILL_KEY, ~/Library/Application Support/Notemill/, ~/.config/notemill/")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(manifest, indent=4) + "\n")
    if not quiet:
        print("%s written for %s (background: %s)"
              % (out_path.name, target, ", ".join(manifest["background"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
