# Notemill token exchange

One small endpoint, so that signing in to Notion takes a single click without shipping an
OAuth client secret inside the extension.

## Why it exists

Notion's `/v1/oauth/token` requires HTTP Basic auth with `client_id:client_secret` and
supports no PKCE. A secret inside a distributed extension can be read by anyone who installs
it, so the exchange has to happen somewhere the secret is not published. That is all this does.

It is called **once per sign-in**. Afterwards the extension talks to Notion directly with the
token it received, and nothing passes through here again: no articles, ever.

## Deploy (about ten minutes, once)

You need a free Cloudflare account and the Notion integration's client id and secret
(*notion.so/profile/integrations → your integration → Configuration*). `npx` fetches
Cloudflare's `wrangler` tool on first use; nothing has to be installed globally.

```sh
cd server
npx wrangler login                          # opens Cloudflare in the browser
npx wrangler secret put NOTION_CLIENT_ID     # paste the client id; answer y to create the Worker
npx wrangler secret put NOTION_CLIENT_SECRET # paste the client secret
npx wrangler secret put ALLOWED_ORIGINS      # chrome-extension://<extension-id>
npx wrangler deploy
```

For the published extension, `<extension-id>` is `hdaplchhooppaflbbkaglbponlbeikld`.

`wrangler deploy` prints the endpoint, `https://notemill-token-exchange.<subdomain>.workers.dev`.
The subdomain is your Cloudflare account's and becomes visible inside every build, so pick a
neutral one under *Workers & Pages* before deploying. Put the URL into `notion-config.js` as
`exchangeUrl`, leave `clientSecret` empty there, and build with `make release`:

```js
var LR_NOTION_APP = {
  clientId:     "your-client-id",
  clientSecret: "",                                   // stays on the server
  exchangeUrl:  "https://notemill-token-exchange.example.workers.dev"
};
```

## The Notion side

At *notion.so/profile/integrations → your integration*:

- The integration must be **public** (OAuth), so people can connect their own workspaces.
- Under *Redirect URIs*, register `https://<extension-id>.chromiumapp.org/notion`. The
  extension's settings page prints the exact string.
- Everything under *Basic information* (name, website, support email, privacy and terms
  links) is shown to everyone who connects. Check it is what you want public.

## Locking it down

`ALLOWED_ORIGINS` restricts the endpoint to the extension's origin. Unset, the worker accepts
any extension origin. Treat it as hygiene rather than security: `Origin` is easily forged
outside a browser. The real protection is that an exchange is useless without a valid consent
code issued for this Notion app.

For local testing with `npx wrangler dev`, put the same values in `server/.dev.vars`
(gitignored), one `NAME=value` per line. Never commit that file.

## What it must never do

Log the code or the access token. Both pass through in memory and the response is streamed
straight back to the extension. If you add logging, log the status code and nothing else, and
say so in [`PRIVACY.md`](../PRIVACY.md).

## Cost

One request per user per sign-in. Cloudflare's free tier covers 100,000 a day.
