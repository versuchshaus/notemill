#!/usr/bin/env python3
"""Render the reader tools bar in every state, light and dark, from the live
stylesheet - so a CSS change can be judged as pixels before the extension is
reloaded. Writes build/preview/bar-{light,dark}.png (and the .html it rendered).

    python3 tools/barpreview.py            # renders with Google Chrome, headless
    python3 tools/barpreview.py --html     # only writes the pages, no Chrome

The pages inline css/readability.css and reuse the icon paths from
readability.js, so what you see is the real stylesheet; the dark page gets it
by rewriting the ':root[data-lr-theme="dark"]' selectors to ':root'."""
import io, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "build", "preview")
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

def read(p): return io.open(os.path.join(ROOT, p), encoding="utf-8").read()

def icons():
    block = read("readability.js").split("ICONS: {", 1)[1].split("\n    },", 1)[0]
    return dict(re.findall(r"^\s*(\w+):\s*'(.*)',?$", block, re.M))

ICONS = icons()
BUTTONS = [("send-notion", "Send to Notion", "send"), ("save-markdown", "Save .md", "download"),
           ("copy-markdown", "Copy Markdown", "copy"), ("print-page", "Print", "printer"),
           ("reload-page", "Exit Reader", "rotate")]

def btn(id_, label, icon, cls=""):
    svg = "<svg class='lr-icon' viewBox='0 0 24 24' aria-hidden='true'>%s</svg>" % ICONS[icon]
    if not label: cls = (cls + " icon-only").strip()
    text = "<span class='lr-text'>%s</span>" % label if label else ""
    return "<a href='#' role='button' id='%s' class='%s'>%s%s</a>" % (id_, cls, svg, text)

def row1(open_=None, armed=None):
    out = [btn(i, l, ic, " ".join(c for c, on in (("open", l == open_), ("armed", l == armed)) if on))
           for i, l, ic in BUTTONS]
    out.append(btn("open-settings", "", "settings", "apart"))
    return "<span class='lr-row'>" + "".join(out) + "</span>"

def status(inner, cls=""):
    return "<span id='readMarkdownStatus' class='lr-row %s'>%s</span>" % (cls, inner)

A = lambda t, cls="": "<a href='#' role='button' class='%s'>%s</a>" % (cls, t)
L = lambda t: "<span class='lr-label'>%s</span>" % t

CASES = [
  ("rest, Send to Notion armed", row1(armed="Send to Notion") + status("")),
  ("Save .md open", row1(open_="Save .md") + status(
      A("Save", "primary armed") + L("to:") + "<span class='lr-value'>Downloads folder</span>" + A("choose folder…") + A("cancel"))),
  ("Send to Notion open", row1(open_="Send to Notion") + status(
      A("Save", "primary armed") + L("to:") + "<select><option>Reading list (db)</option></select>" + L("Tag:") +
      "<span class='lr-tagbox'><input type='text' value='Research'></span>" + A("refresh list") + A("cancel"))),
  ("Copy Markdown done", row1(open_="Copy Markdown") + status(" copied 18432 chars", "is-done")),
  ("Print (native dialog supplies feedback)", row1() + status("")),
  ("Notion saved", row1(open_="Send to Notion") + status(" Saved to Notion (tags → Tags) " + A("open it"), "is-done")),
  ("error", row1() + status(" Connect Notion in the extension options first. " + A("open options"))),
]

def page(theme):
    css = read("css/readability.css")
    if theme == "dark": css = css.replace(':root[data-lr-theme="dark"]', ":root")
    body = "".join("<p class='cap'>%s</p><div id='readTools'>%s</div>" % (c, h) for c, h in CASES)
    # Astra: reuse the production alignment routine; static CSS alone cannot
    # position feedback beneath the owning button. Each preview bar is scoped.
    align = read("readability.js").split("    alignRow: function (bar) {", 1)[1].split("\n    },", 1)[0]
    script = ("<script>function alignRow(bar) {" + align + "\n}\n"
              "function alignAll() { document.querySelectorAll('#readTools').forEach(function(bar) {"
              "var row = bar.querySelector('#readMarkdownStatus'), owner = bar.querySelector('a.open');"
              "row._owner = owner ? owner.id : null; alignRow(bar); }); }"
              "window.addEventListener('load', alignAll); window.addEventListener('resize', alignAll);"
              "if (document.fonts) document.fonts.ready.then(alignAll);</script>")
    return ("<!doctype html><html lang='en'><head><meta charset='utf-8'><style>%s</style>"
            "<style>body{padding:1rem 1.25rem 2rem;font-size:16px}"
            ".cap{font-family:system-ui,sans-serif;font-size:12px;color:var(--lr-muted);margin:1.4rem 0 .15rem;text-align:right}"
            "#readTools{position:static;margin:0 0 0 auto}</style></head><body>%s%s</body></html>" % (css, body, script))

def main():
    os.makedirs(OUT, exist_ok=True)
    for theme in ("light", "dark"):
        html = os.path.join(OUT, "bar-%s.html" % theme)
        io.open(html, "w", encoding="utf-8").write(page(theme))
        if "--html" in sys.argv: continue
        if not os.path.exists(CHROME): sys.exit("Google Chrome not found at %s - use --html" % CHROME)
        png = os.path.join(OUT, "bar-%s.png" % theme)
        subprocess.run([CHROME, "--headless", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=2",
                        "--window-size=760,1100", "--screenshot=" + png, "file://" + html],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        print(png)

if __name__ == "__main__": main()
