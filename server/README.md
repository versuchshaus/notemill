# Notemill token exchange

One endpoint, so that signing in to Notion takes a single click without
shipping an OAuth client secret inside the extension.

## Why it exists

Notion's `/v1/oauth/token` requires HTTP Basic auth with
`client_id:client_secret` and supports no PKCE. A secret placed in a
distributed extension can be read by anyone who installs it, so the exchange
has to happen somewhere the secret is not published. That is all this does.

It is called **once per sign-in**. Afterwards the extension talks to Notion
directly with the token it received, and nothing passes through here again — no
articles, ever.

## Deploy

    npm install -g wrangler          # once
    cd server
    wrangler login
    wrangler secret put NOTION_CLIENT_ID       # from your Notion integration
    wrangler secret put NOTION_CLIENT_SECRET   # from your Notion integration
    wrangler deploy

`wrangler deploy` prints the URL, something like
`https://notemill-token-exchange.<subdomain>.workers.dev`. Put that in
`notion-config.js` as `exchangeUrl`, and leave `clientSecret` empty there:

```js
var LR_NOTION_APP = {
  clientId:     "your-client-id",
  clientSecret: "",                                   // stays on the server
  exchangeUrl:  "https://notemill-token-exchange.example.workers.dev"
};
```

Register the redirect URI the extension's options page prints, at
notion.so/profile/integrations.

## Locking it down

Once the extension has a stable id (a Web Store listing, or the pinned key in
this repo), restrict who may call the endpoint:

    wrangler secret put ALLOWED_ORIGINS      # chrome-extension://<id>

Unset, the worker accepts extension origins only. Treat that as hygiene rather
than security: `Origin` is trivially forged outside a browser. The real
protection is that an exchange is useless without a valid consent code issued
for this Notion app.

## What it must never do

Log the code or the access token. Both pass through in memory and the response
is streamed straight back to the extension. If you add logging, log the status
code and nothing else — and say so in your privacy policy.

## Cost

One request per user per sign-in. Cloudflare's free tier covers 100,000 a day.
