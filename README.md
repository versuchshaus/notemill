# Notemill

**New here? [Start with the beginner quickstart →](QUICKSTART.md)**

Reads an article cleanly, saves it as Markdown with its images, and files it in
your Notion. Nothing leaves the browser unless you send it.

A Chrome/Chromium extension. Click the toolbar button (or press the shortcut)
and the page is reformatted for reading, using Arc90's Readability parser.

**Extraction is entirely local.** No page content is sent to a remote service
for processing. Images may be fetched from their source websites; Notion
sign-in and destination lookup also require network requests. An article is
uploaded to Notion only when you explicitly send it. Local Markdown export and
printing do not upload the article to Notion.

The reader's stylesheet is fully customisable in the options.

## Provenance

The article parser, `readability.js`, is Arc90's Readability 1.7.1, used under
the **Apache License 2.0**. Its header lists every change made to it.

Notemill began as a fork of LReadability by luxcem, which is GPLv3. **No code
from it remains.** The stylesheet, options page, injection script, build
scripts and icons were rewritten from scratch, and the icons in particular are
original work drawn by `tools/icons.py`, replacing an image that came from
Wikimedia under CC BY-SA. What survives from that lineage is the idea and a
handful of selector names the parser itself dictates.

The rename matters too: *Readability* is a trademark of Arc90 Inc, and the
header of `readability.js` says it "may not be used without explicit
permission", so a product name derived from it was never safe to publish.

### What this fork added

- Manifest V3, with the parser injected on click rather than on every page
  load, so no host permissions are needed to read a page.
- Parser fixes: article images are no longer deleted, and articles whose body
  is split across wrapper elements are no longer truncated.
- Markdown export, to the clipboard or as a folder holding the document and
  its images.
- Export to Notion through Notion's official API, including tags resolved
  against a related tags database.
- Day/night theme, a sticky tools bar, full keyboard operation.

## Licencing

**Notemill is MIT licensed** (`LICENCE`). Use it as you like, including in
closed-source or commercial work. Two obligations come with the third-party
material it carries, both satisfied by files that ship inside the extension:

- **Apache 2.0** for `readability.js`: keep the notices, ship the licence
  (`LICENCE-APACHE`), and state the modifications.
- **SIL Open Font License** for the bundled Linux Libertine faces: ship the
  licence (`FONT-LICENCE.txt`) and do not rename or modify the fonts.

Notion is a trademark of Notion Labs, Inc. Notemill is an independent project,
not affiliated with or endorsed by Notion Labs.

## Signing in to Notion

Notion's token endpoint requires HTTP Basic auth with `client_id:client_secret`
and supports no PKCE, so a sign-in needs a confidential client. Two ways to
have one:

- **Your own integration.** Create one at notion.so/profile/integrations, put
  its id and secret in `notion-config.js` (gitignored), and register the
  redirect URI the options page prints. Fine for a personal copy.
- **A token exchange** (`server/`). A small Cloudflare Worker holds the secret
  and performs that one exchange, so the extension ships only the public client
  id and the endpoint URL. This is what a distributed build must do, because a
  secret inside an extension is readable by anyone who installs it. It is
  called once per sign-in and never sees an article. See `server/README.md`.

## Building

    make          # notemill-<version>.zip, for loading unpacked
    make store    # a store submission: no signing key, no notion-config.js
    make icons    # redraw img/icon-*.png
    make clean

`manifest.json` is generated from `manifest.base.json`. The extension id is
pinned by a key kept outside the repository, so moving the folder no longer
changes the id; see `tools/manifest.py`.
