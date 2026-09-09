# Notemill: your first article in five minutes

Notemill turns a busy web article into a clean reading page. You can save it
on your computer, copy it into another app, print it, or send it to Notion.

**You do not need a Notion account to read or save articles.** Start with a
local save; connect Notion later if you want it.

## 1. Install and pin Notemill

Already installed? Skip to step 2.

These instructions are for **Google Chrome** and a downloaded or supplied
extension folder—not a Chrome Web Store installation.

1. If you received a ZIP file, unzip it first. Keep the extracted folder
   somewhere permanent; Chrome needs it to keep loading the extension.
2. Type `chrome://extensions` into Chrome's address bar and press Enter.
3. Turn on **Developer mode** in the top-right corner.
4. Click **Load unpacked**.
5. Select the extension folder—the one containing `manifest.json`.
6. Click Chrome's puzzle-piece **Extensions** button, then pin **Notemill**.

Notemill's options may open automatically. You can leave Notion unconnected
and go straight to your first article.

> Updating an existing installation? Click Notemill's reload button on
> `chrome://extensions`, then reload any article tabs before using the reader.

## 2. Open your first article

1. Visit an individual article, such as a blog post or news story.
2. Let the page finish loading.
3. Click the pinned **Notemill** button.

The article changes into a clean reader page with a toolbar at the top.

**Try it:** scroll down. The toolbar stays within reach while you read.

Notemill works best on pages with a substantial article. Search results, home
pages, browser settings and PDF viewers are not suitable starting points.
It does not unlock paywalled content.

## 3. Save a copy on your computer

1. In the reader toolbar, click **Save .md**.
2. Look at the row below it: **Save · to: · Downloads folder**.
3. Click the **Save** button in that row.
4. Wait for the saved message, then open your computer's **Downloads** folder.

You should find a folder named after the article. For an article with a
successfully saved image, it looks roughly like this:

```text
my-article/
  my-article.md
  images/
    01-photo.jpg
```

### What is a `.md` file?

It is a **Markdown** file: ordinary text with simple markers for headings,
links and formatting. You can open it in a text editor, or use a Markdown app
such as Obsidian to see it formatted.

**Keep the article folder together.** Moving only the `.md` file away from its
`images` folder can break the image links. Articles without pictures may have
no `images` folder.

### Prefer a different save folder?

1. Click **Save .md**, then **choose folder…**.
2. A small Notemill window opens. Click **Choose folder…** there too—this
   second click is needed to open the browser's native folder dialog.
3. Select a folder and allow write access if the browser asks.
4. Back in the reader, check the folder name and click **Save**.

Notemill remembers the folder for later saves. Use **change folder…** to choose
another one. To return to Downloads, open options and choose
**Save .md to → Use Downloads**.

## 4. Make reading comfortable

Click the **gear** in the reader toolbar to open options. You can also
right-click Notemill's pinned extension button and choose **Options**.

Under **Appearance → Theme**, choose:

- **Day** — light background.
- **Night** — dark background.
- **Follow the system** — use your computer's light/dark preference.

The setting applies to the **reader, options and folder picker**. Open
Notemill pages update automatically.

Leave **Custom CSS** empty unless you want to write your own reader stylesheet.
You do not need to change it for normal use.

## 5. Try the other toolbar buttons

| Button | What it does |
| --- | --- |
| **Copy Markdown** | Copies the article as Markdown. Paste it into a notes app or text editor. It does not save image files beside it. |
| **Print** | Opens the browser's print dialog. You can usually choose **Save as PDF** there. |
| **Exit Reader** | Reloads the original web page. Save anything you need before leaving. |
| **Gear** | Opens Notemill's options. |

A spinner means work is in progress. Orange success text reports completion.
An error stays visible so you have time to read it and try the suggested fix.

## 6. Optional: connect Notion

Want your articles in Notion rather than only on disk? Set this up once.

### Connect your workspace

1. Open Notemill's **Options**. The **Notion** section is first.
2. Click **Connect to Notion**.
3. If Chrome asks, allow Notemill's requested Notion access.
4. Sign in to Notion and choose the pages or databases you want to make
   available to the integration. Grant only the access you need.
5. Return to options and check that your workspace is shown as connected.
6. Under **Destinations offered in the reader**, tick the destinations you
   actually use. This keeps the reader's list short.

With nothing ticked, **all available destinations** are offered; it does not
turn off Notion access. Click **Refresh list** if an expected destination is
missing after you change its sharing permissions.

> **Connect is disabled?** Your copy may not have a Notion app configured.
> Reading, copying, printing and local saving still work. Ask whoever supplied
> the extension for a configured copy. If you manage your own installation,
> see [Signing in to Notion](README.md#signing-in-to-notion) for the advanced setup.
> Never share a client secret or access token in screenshots or messages.

### Send an article

1. Open an article in Notemill's reader.
2. Click **Send to Notion**.
3. Choose the destination in the row below the toolbar.
4. If that destination supports tags, choose suggestions or enter tag names
   separated by commas.
5. Click **Save**.
6. When the saved message appears, click **open it** to view the new Notion page.

Notemill remembers your last destination. **Each send creates a new page**, so
check Notion before retrying an uncertain or partially completed save.

## Handy keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| **⌘⇧U** on Mac / **Ctrl+Shift+U** on Windows or Linux | Activate Notemill on the current article, if the shortcut is assigned. |
| **Tab** / **Shift+Tab** | Move forward/backward between controls. |
| **Enter** | Activate the focused button or link. |
| **Escape** | Close a tag suggestion list or an open toolbar row. With no row open, leave the reader. |

If the activation shortcut does nothing, check `chrome://extensions/shortcuts`.

**Dismissing feedback is not the same as cancelling a save.** A save already
started can finish after you close its status row.

## If something goes wrong

| Problem | Try this |
| --- | --- |
| Clicking Notemill does nothing | Use an ordinary article page, not browser settings or a PDF. Reload the page and try again. |
| The reader misses some content | Return to the original page, let the article fully load, then retry. Some layouts cannot be extracted cleanly. |
| You cannot find the saved article | Check the destination shown below **Save .md**. It may be a remembered folder rather than Downloads. |
| The save reports missing images | Some sites block image downloads. Check the article folder; the text may still be saved. Return to the original page for missing pictures. |
| Folder access expired | Choose that folder again and allow write access. |
| Copy is blocked | Use **Save .md** instead. |
| A Notion destination is missing | Check that it was shared with the integration, then refresh the list in options. Also check the selected destinations. |
| Notion reports an error | Read the message and use its **open options** link if offered. Check whether a page was created before sending again. |
| Things look outdated after an update | Reload Notemill at `chrome://extensions`, then reload the article. |

## A quick privacy note

Article extraction happens **in your browser**, not on a remote processing
service. Saving locally does not upload the article to Notion. Images may be
fetched from their source websites; Notion connection and destination lookup
also make network requests. Sending an article to Notion is an explicit action.

---

**Your everyday routine:** open an article → click Notemill → read → save it
locally or send it to Notion.
