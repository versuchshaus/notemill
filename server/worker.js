/**
 * Notemill's token exchange.
 *
 * Notion's token endpoint requires HTTP Basic auth with client_id:client_secret
 * and offers no PKCE, so a distributed extension cannot complete a sign-in by
 * itself: a secret inside an extension is readable by anyone who installs it.
 * This worker holds the secret and performs that one exchange.
 *
 * It is deliberately the smallest thing that can work:
 *
 *   - one route, one method, one job
 *   - no database, no accounts, no sessions
 *   - it never sees an article. Once the extension has a token it talks to
 *     Notion directly, and this worker is not called again until someone
 *     signs in
 *   - it must never log the code or the token. They pass through in memory and
 *     the response is streamed straight back
 *
 * Deploy: see README.md in this directory. The secret is set with
 * `wrangler secret put`, so it lives only in Cloudflare.
 */

const NOTION_TOKEN_URL = "https://api.notion.com/v1/oauth/token";
const NOTION_VERSION = "2022-06-28";

/** Which extension origins may call this. Set ALLOWED_ORIGINS to lock it down. */
function allowedOrigin(request, env) {
  const origin = request.headers.get("Origin") || "";
  const configured = (env.ALLOWED_ORIGINS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);

  if (configured.length) {
    return configured.includes(origin) ? origin : null;
  }
  // Unconfigured: allow extension origins only. This is hygiene, not security -
  // Origin is trivially forged outside a browser. The real protection is that
  // the exchange is useless without a valid consent code for this Notion app.
  return /^(chrome|moz|safari-web)-extension:\/\//.test(origin) ? origin : null;
}

function cors(origin) {
  const headers = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
  if (origin) { headers["Access-Control-Allow-Origin"] = origin; }
  return headers;
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({"Content-Type": "application/json"}, cors(origin))
  });
}

export default {
  async fetch(request, env) {
    const origin = allowedOrigin(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, {status: origin ? 204 : 403, headers: cors(origin)});
    }
    if (request.method !== "POST") {
      return json({error: "Send a POST."}, 405, origin);
    }
    if (!origin) {
      return json({error: "This endpoint only serves the Notemill extension."}, 403, null);
    }
    if (!env.NOTION_CLIENT_ID || !env.NOTION_CLIENT_SECRET) {
      return json({error: "The exchange is not configured."}, 500, origin);
    }

    let body;
    try { body = await request.json(); } catch (e) { body = null; }
    const code = body && body.code;
    const redirectUri = body && body.redirect_uri;
    if (typeof code !== "string" || typeof redirectUri !== "string") {
      return json({error: "Expected a JSON body with code and redirect_uri."}, 400, origin);
    }

    // Notion checks that redirect_uri matches the one used to get the code, so
    // it is passed through rather than configured here.
    let upstream;
    try {
      upstream = await fetch(NOTION_TOKEN_URL, {
        method: "POST",
        headers: {
          "Authorization": "Basic " + btoa(env.NOTION_CLIENT_ID + ":" + env.NOTION_CLIENT_SECRET),
          "Content-Type": "application/json",
          "Notion-Version": NOTION_VERSION
        },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code: code,
          redirect_uri: redirectUri
        })
      });
    } catch (e) {
      return json({error: "Could not reach Notion."}, 502, origin);
    }

    // Straight back to the extension, including Notion's own error bodies:
    // the extension shows them, which is more use than anything invented here.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: Object.assign(
        {"Content-Type": upstream.headers.get("Content-Type") || "application/json"},
        cors(origin)
      )
    });
  }
};
