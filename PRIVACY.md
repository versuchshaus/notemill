# Notemill and your data

Short version: Notemill works on your computer. It sends an article to Notion only when you
press *Send to Notion*, and nowhere else, ever. It has no analytics, no tracking and no account.

## What leaves your computer, and when

| When | What is sent | To whom |
| --- | --- | --- |
| You open the reading view | Nothing. The page is cleaned up inside your browser. | Nobody |
| You press **Save .md** | Nothing about you. Notemill downloads the article's pictures from the website you are reading, so it can save them next to the text. | The website you are reading |
| You press **Connect to Notion** | Notion's one-time sign-in code, and the address Notion should return to. | The Notemill sign-in service (see below), which forwards them to Notion |
| You use **Send to Notion** | The article's title, text, headings, picture addresses, the source link and your tags. Notemill also asks Notion for your destinations and existing tag names. | Notion (`api.notion.com`), directly from your browser |
| You press **Copy Markdown** or **Print** | Nothing. | Nobody |

Pictures in a Notion page are linked from the website they came from, not uploaded by
Notemill. Notion and your browser load them from there when you view the page.

## The sign-in service

Notion only hands out access after a server-side step that needs the app's secret. That
secret must not be inside an extension anyone can download, so it sits in a tiny service
running on Cloudflare Workers, and its complete source is in [`server/`](server/).

It is used **once per sign-in**: it receives Notion's sign-in code, adds the secret, asks
Notion for your access token and passes Notion's answer straight back to your browser. It
has no database, keeps nothing and logs nothing. It never sees an article. Cloudflare, which
runs it, keeps its own technical request logs under
[its privacy policy](https://www.cloudflare.com/privacypolicy/).

## What is stored, and where

Everything stays in your browser's extension storage on your computer.

| What | Where |
| --- | --- |
| Your Notion access token, workspace name, your list of destinations, the last destination and the tags you typed per destination | `chrome.storage.local`, on this computer only |
| Theme and custom CSS | `chrome.storage.sync`, which your browser may sync to your other computers if you use browser sync |
| The folder you chose for *Save .md* | The extension's own browser storage (IndexedDB), on this computer only |

Removing Notemill deletes all of it. To also withdraw Notemill's access on Notion's side,
open *Settings → Connections* in Notion and disconnect Notemill.

## Permissions, and why each is needed

| Permission | What Notemill does with it |
| --- | --- |
| `activeTab`, `scripting` | Turn **the tab you clicked the button in** into the reading view. Notemill has no access to any other tab or site, and nothing runs until you click. |
| `storage` | Remember the settings listed above. |
| `downloads` | Write the `.md` file and its pictures into your Downloads folder. |
| `identity` | Get the address Notion returns to after signing in. |
| `api.notion.com` *(asked when you press Connect)* | Talk to Notion. Declined, everything except Notion keeps working. |
| `*.chromiumapp.org` *(asked together with the above)* | The browser's own return address after the Notion sign-in window. |

## Questions

Open an [issue](https://github.com/versuchshaus/notemill/issues). Security problems: please
report them privately through the repository's **Security** tab → *Report a vulnerability*.
