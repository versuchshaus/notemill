// notion.js - Notion API client shared by the service worker and the options
// page. Plain script, no DOM access, so it can be importScripts()'d.
//
// Everything here goes through the official public API with an OAuth token
// the user obtained by signing in; nothing touches Notion's internal
// endpoints or session cookies. Only the article the user explicitly sends
// ever leaves the browser.
var LRNotion = (function () {
  var API      = "https://api.notion.com/v1";
  var VERSION  = "2022-06-28";
  var ORIGIN   = "https://api.notion.com/*";
  // Where Notion sends the browser back. Only a host permission for it lets us
  // see the redirect land in a window we opened ourselves (tabs.onUpdated hides
  // URLs otherwise), so it is requested together with the API origin.
  var REDIRECT_ORIGIN = "https://*.chromiumapp.org/*";
  var KEY      = "notion";
  var CHUNK    = 100;   // Notion accepts at most 100 children per request

  function storage() { return chrome.storage.local; }

  /**
   * Credentials shipped with this copy of the extension, if any
   * (notion-config.js). Their presence is what turns setup into one click:
   * without them the user has to create an integration themselves, because
   * Notion's token exchange requires a client secret and supports no PKCE.
   */
  function appDefaults() {
    var app = (typeof LR_NOTION_APP !== "undefined") ? LR_NOTION_APP
            : (typeof self !== "undefined" && self.LR_NOTION_APP) ? self.LR_NOTION_APP
            : null;
    return {
      clientId:     (app && app.clientId)     || "",
      clientSecret: (app && app.clientSecret) || "",
      exchangeUrl:  (app && app.exchangeUrl)  || ""
    };
  }

  /**
   * Stored values win, so a user can still point this at their own app.
   *
   * A sign-in needs the client id (public, it goes in the consent URL) plus
   * *either* a client secret here or an `exchangeUrl` - a small endpoint that
   * holds the secret and performs the token exchange. The second is what a
   * published build uses, because a secret shipped inside an extension can be
   * read by anyone who installs it.
   */
  function credentials(settings) {
    var d = appDefaults();
    var clientId     = (settings && settings.clientId)     || d.clientId;
    var clientSecret = (settings && settings.clientSecret) || d.clientSecret;
    var exchangeUrl  = (settings && settings.exchangeUrl)  || d.exchangeUrl;
    return {
      clientId:     clientId,
      clientSecret: clientSecret,
      exchangeUrl:  exchangeUrl,
      ready:        !!(clientId && (clientSecret || exchangeUrl)),
      viaExchange:  !!(exchangeUrl && !clientSecret),
      fromApp:      !(settings && settings.clientId) && !!d.clientId
    };
  }

  function load() {
    return new Promise(function (resolve) {
      storage().get(KEY, function (items) { resolve((items && items[KEY]) || {}); });
    });
  }

  function save(patch) {
    return load().then(function (current) {
      var next = Object.assign({}, current, patch);
      var obj  = {}; obj[KEY] = next;
      return new Promise(function (resolve) { storage().set(obj, function () { resolve(next); }); });
    });
  }

  function disconnect() {
    return save({accessToken: null, workspaceName: null, workspaceId: null,
                 botId: null, target: null, targets: []});
  }

  function redirectURL() { return chrome.identity.getRedirectURL("notion"); }

  function hasHostPermission() {
    return new Promise(function (resolve) {
      chrome.permissions.contains({origins: [ORIGIN]}, function (ok) { resolve(!!ok); });
    });
  }

  // Must be called from a user gesture (a click in the options page).
  function requestHostPermission() {
    return new Promise(function (resolve) {
      chrome.permissions.request({origins: [ORIGIN, REDIRECT_ORIGIN]}, function (ok) { resolve(!!ok); });
    });
  }

  function canWatchRedirect() {
    return new Promise(function (resolve) {
      chrome.permissions.contains({origins: [REDIRECT_ORIGIN]}, function (ok) { resolve(!!ok); });
    });
  }

  /** The browser's own auth window: fixed, smallish size, no options. Fallback. */
  function launchIdentity(authURL) {
    return new Promise(function (resolve, reject) {
      chrome.identity.launchWebAuthFlow({url: authURL, interactive: true}, function (responseURL) {
        if (chrome.runtime.lastError || !responseURL) {
          reject(fail((chrome.runtime.lastError && chrome.runtime.lastError.message) ||
                      "Sign-in was cancelled.", "cancelled"));
          return;
        }
        resolve(responseURL);
      });
    });
  }

  /**
   * Open Notion's consent page in a large popup window of our own and resolve
   * with the redirect URL once the window navigates to it. Notion's "Select
   * pages" dialog needs the room; identity.launchWebAuthFlow cannot be sized.
   */
  function authorize(authURL, redirect) {
    if (!(chrome.windows && chrome.tabs && chrome.windows.create)) { return launchIdentity(authURL); }
    return canWatchRedirect().then(function (ok) {
      if (!ok) { return launchIdentity(authURL); }
      return new Promise(function (resolve, reject) {
        chrome.windows.getCurrent(function (cur) {
          void chrome.runtime.lastError;
          var w = Math.min(1280, Math.max(900, ((cur && cur.width)  || 1280) - 80));
          var h = Math.min(1100, Math.max(820, ((cur && cur.height) || 1100) - 60));
          chrome.windows.create({url: authURL, type: "popup", width: w, height: h, focused: true}, function (win) {
            if (chrome.runtime.lastError || !win) { launchIdentity(authURL).then(resolve, reject); return; }
            var done = false;
            function finish(err, url) {
              if (done) { return; }
              done = true;
              chrome.tabs.onUpdated.removeListener(onUpdated);
              chrome.windows.onRemoved.removeListener(onRemoved);
              clearTimeout(timer);
              chrome.windows.remove(win.id, function () { void chrome.runtime.lastError; });
              if (err) { reject(err); } else { resolve(url); }
            }
            function onUpdated(tabId, info, tab) {
              var url = info.url || (tab && tab.url) || "";
              if (tab && tab.windowId === win.id && url.indexOf(redirect) === 0) { finish(null, url); }
            }
            function onRemoved(id) { if (id === win.id) { finish(fail("Sign-in window was closed.", "cancelled")); } }
            var timer = setTimeout(function () { finish(fail("Sign-in timed out.", "timeout")); }, 5 * 60 * 1000);
            chrome.tabs.onUpdated.addListener(onUpdated);
            chrome.windows.onRemoved.addListener(onRemoved);
          });
        });
      });
    });
  }

  function fail(message, code, status) {
    var e = new Error(message); e.code = code || "notion"; e.status = status || 0; return e;
  }

  function request(path, method, body, token, extraHeaders) {
    var headers = Object.assign({
      "Content-Type":  "application/json",
      "Notion-Version": VERSION
    }, extraHeaders || {});
    if (token) { headers.Authorization = "Bearer " + token; }

    return fetch(API + path, {
      method:  method || "GET",
      headers: headers,
      body:    body ? JSON.stringify(body) : undefined
    }).then(function (res) {
      return res.text().then(function (text) {
        var json = null;
        try { json = text ? JSON.parse(text) : null; } catch (e) { /* non-JSON error page */ }
        if (!res.ok) {
          var msg = (json && (json.message || json.error_description || json.error)) ||
                    ("HTTP " + res.status);
          throw fail("Notion: " + msg, (json && json.code) || "http", res.status);
        }
        return json;
      });
    });
  }

  function randomState() {
    var a = new Uint8Array(16); crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
  }

  /**
   * OAuth: open Notion's consent page, exchange the code for a token, and
   * remember the workspace. The client secret is the user's own (their
   * integration), stored locally so the exchange can run from the browser.
   */
  /**
   * @param String clientId
   * @param String clientSecret  may be empty when exchangeUrl is given
   * @param String exchangeUrl   endpoint that swaps the code for a token
   */
  function connect(clientId, clientSecret, exchangeUrl) {
    if (!clientId) {
      return Promise.reject(fail("Enter the integration's OAuth client ID first.", "config"));
    }
    if (!clientSecret && !exchangeUrl) {
      return Promise.reject(fail("Enter the client secret, or configure a token exchange.", "config"));
    }
    var redirect = redirectURL();
    var state    = randomState();
    var authURL  = API + "/oauth/authorize" +
      "?client_id="    + encodeURIComponent(clientId) +
      "&response_type=code&owner=user" +
      "&redirect_uri=" + encodeURIComponent(redirect) +
      "&state="        + state;

    return authorize(authURL, redirect).then(function (responseURL) {
      var params = new URL(responseURL).searchParams;
      if (params.get("error")) { throw fail("Notion refused: " + params.get("error"), "denied"); }
      if (params.get("state") !== state) { throw fail("OAuth state mismatch - try again.", "state"); }
      var code = params.get("code");
      if (!code) { throw fail("Notion returned no authorization code.", "nocode"); }

      /* With an exchange configured the secret is not here to use, so the
         code goes to that endpoint instead. It is called once, only ever
         with a consent code, and never again after this. */
      if (!clientSecret) { return exchangeCode(exchangeUrl, code, redirect); }

      return request("/oauth/token", "POST", {
        grant_type:   "authorization_code",
        code:         code,
        redirect_uri: redirect
      }, null, {Authorization: "Basic " + btoa(clientId + ":" + clientSecret)});
    }).then(function (tok) {
      if (!tok || !tok.access_token) {
        throw fail("The token exchange returned no access token.", "notoken");
      }
      return save({
        clientId:      clientId,
        /* Deliberately not stored when the exchange holds it. */
        clientSecret:  clientSecret || "",
        accessToken:   tok.access_token,
        workspaceName: tok.workspace_name || "",
        workspaceId:   tok.workspace_id   || "",
        botId:         tok.bot_id         || ""
      });
    });
  }

  function plain(richText) {
    return (richText || []).map(function (t) { return t.plain_text || ""; }).join("").trim();
  }

  function titleOf(result) {
    if (result.object === "database") { return plain(result.title) || "Untitled database"; }
    var props = result.properties || {};
    for (var k in props) {
      if (props[k] && props[k].type === "title") { return plain(props[k].title) || "Untitled"; }
    }
    return "Untitled";
  }

  function iconOf(result) {
    return (result.icon && result.icon.type === "emoji") ? result.icon.emoji : "";
  }

  /** Pages and databases the integration was granted access to. */
  /**
   * Somewhere worth saving an article, or not?
   *
   * Notion's /search returns everything the integration can see, which after
   * a few saves is mostly the articles it created itself. Two rules clear that
   * out: a page that lives *inside* a database is a row, and you would target
   * the database rather than one of its rows; and a page this integration
   * created is our own output, not a destination.
   *
   * @param Object search result
   * @param String botId of this integration, from the OAuth response
   * @return Boolean
   */
  function isDestination(result, botId) {
    if (result.object === "database") { return true; }
    var parent = result.parent || {};
    if (parent.type === "database_id") { return false; }
    if (botId && result.created_by && result.created_by.id === botId) { return false; }
    return true;
  }

  /* Notion's /search pages its results, and a filtered page often comes back
     with fewer than page_size entries while has_more is still true. Reading
     only the first page is why some shared databases never showed up, so
     follow next_cursor - up to SEARCH_PAGES pages per kind, so a huge
     workspace cannot keep the list loading forever. */
  var SEARCH_PAGES = 10;

  function listTargets(token, botId) {
    function search(kind) {
      var found = [];
      function page(cursor, n) {
        var body = {
          filter:    {property: "object", value: kind},
          sort:      {direction: "descending", timestamp: "last_edited_time"},
          page_size: 100
        };
        if (cursor) { body.start_cursor = cursor; }
        return request("/search", "POST", body, token).then(function (res) {
          found = found.concat(res.results || []);
          if (res.has_more && res.next_cursor && n + 1 < SEARCH_PAGES) {
            return page(res.next_cursor, n + 1);
          }
          return found;
        });
      }
      return page(null, 0).then(function (results) {
        return results.filter(function (r) {
          return isDestination(r, botId);
        }).map(function (r) {
          return {id: r.id, type: r.object, title: titleOf(r), icon: iconOf(r)};
        });
      });
    }
    return Promise.all([search("database"), search("page")]).then(function (both) {
      var targets = both[0].concat(both[1]);
      return save({targets: targets}).then(function () { return targets; });
    });
  }

  /**
   * Databases only, unless the user asked for ordinary pages too. Databases
   * are where a saved article gets properties and tags; a plain page is a
   * deliberate choice, made in the options.
   *
   * @param Array targets
   * @param Boolean includePages
   * @return Array
   */
  function visible(targets, includePages) {
    return (targets || []).filter(function (t) {
      return includePages || t.type === "database";
    });
  }

  /**
   * The destinations to offer in the reader: the subset ticked in the options,
   * or everything while nothing has been ticked.
   *
   * @param Array targets
   * @param Array|null chosen ids
   * @param Boolean includePages  also offer ordinary pages
   * @return Array
   */
  function offered(targets, chosen, includePages) {
    var list = visible(targets, includePages);
    if (!chosen || !chosen.length) { return list; }
    var wanted = {};
    chosen.forEach(function (id) { wanted[id] = true; });
    var picked = list.filter(function (t) { return wanted[t.id]; });
    /* If every chosen destination has since disappeared, showing nothing would
       be a dead end - fall back to the full list. */
    return picked.length ? picked : list;
  }

  /**
   * Which database property should receive the tags.
   *
   * A name that reads like a tag field wins; otherwise a single unambiguous
   * multi_select. Never guess among several selects - writing "Draft" into a
   * Status column would be worse than doing nothing.
   *
   * @param Object database (GET /v1/databases/{id})
   * @return Object|null {name, type}
   */
  function tagProperty(db) {
    if (!db || !db.properties) { return null; }
    var named = null, multi = [];
    for (var name in db.properties) {
      var prop = db.properties[name];
      var type = prop.type;
      if (type !== "multi_select" && type !== "select" && type !== "relation") { continue; }
      if (type === "multi_select") { multi.push(name); }
      if (!named && looksLikeTagName(name)) {
        named = {name: name, type: type};
        /* A "Tag" relation points at a tags database - the tags are pages
           there, not option strings. Only ever chosen by name: a relation
           picked by guesswork would write into the wrong table entirely. */
        if (type === "relation" && prop.relation) { named.databaseId = prop.relation.database_id; }
      }
    }
    if (named && (named.type !== "relation" || named.databaseId)) { return named; }
    return multi.length === 1 ? {name: multi[0], type: "multi_select"} : null;
  }

  /* Whole words only: a substring test matches "tag" inside "Stage". */
  function looksLikeTagName(name) {
    var words = String(name).replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase()
                  .split(/[^a-z\u00e0-\u00ff]+/);
    for (var i = 0; i < words.length; i += 1) {
      if (!words[i]) { continue; }
      if (/^(tag|tags|label|labels|topic|topics|keyword|keywords|thema|themen)$/.test(words[i])) { return true; }
      if (/^(categor|kategor|schlagwort|schlagworte|stichwort|stichworte)/.test(words[i])) { return true; }
    }
    return false;
  }

  /**
   * The tag names that already exist in a destination database.
   *
   * They come from the schema of the database the user already granted, so this
   * needs no further access. Returns null when the database has no tag-ish
   * property at all.
   *
   * @return Promise<{property, type, options: [String]}|null>
   */
  function tagOptions(token, databaseId) {
    return request("/databases/" + databaseId, "GET", null, token).then(function (db) {
      var tp = tagProperty(db);
      if (!tp) { return null; }
      if (tp.type === "relation") { return relationTags(token, tp); }
      var def  = db.properties[tp.name][tp.type] || {};
      var opts = (def.options || []).map(function (o) { return o.name; })
                   .filter(function (x) { return !!x; });
      opts.sort(byName);
      return {property: tp.name, type: tp.type, options: opts};
    });
  }

  function byName(a, b) { return a.toLowerCase() < b.toLowerCase() ? -1 : 1; }

  /** Every page in the related tags database, by title. Follows pagination. */
  function relationTags(token, tp) {
    var ids = {}, names = [];

    function page(cursor, left) {
      var body = {page_size: 100};
      if (cursor) { body.start_cursor = cursor; }
      return request("/databases/" + tp.databaseId + "/query", "POST", body, token).then(function (res) {
        (res.results || []).forEach(function (pg) {
          var title = titleOf(pg);
          if (!title || title === "Untitled") { return; }
          if (!ids[title.toLowerCase()]) { names.push(title); }
          ids[title.toLowerCase()] = pg.id;
        });
        if (res.has_more && res.next_cursor && left > 0) { return page(res.next_cursor, left - 1); }
        return null;
      });
    }

    return page(null, 4).then(function () {
      names.sort(byName);
      return {property: tp.name, type: "relation", options: names,
              ids: ids, databaseId: tp.databaseId};
    });
  }

  /**
   * Turn tag names into related page ids, creating the ones that do not exist
   * yet - a tag you type but have never used before should still stick.
   *
   * @return Promise<{ids: [String], created: [String]}>
   */
  function resolveRelationTags(token, tp, tags) {
    return relationTags(token, tp).then(function (info) {
      var ids = [], missing = [];
      tags.forEach(function (t) {
        var hit = info.ids[t.toLowerCase()];
        if (hit) { ids.push(hit); } else { missing.push(t); }
      });
      if (!missing.length) { return {ids: ids, created: []}; }
      var seq = Promise.resolve();
      missing.forEach(function (name) {
        seq = seq.then(function () {
          return request("/pages", "POST", {
            parent: {database_id: tp.databaseId},
            properties: {title: {title: [{type: "text", text: {content: name}}]}}
          }, token).then(function (pg) { ids.push(pg.id); });
        });
      });
      return seq.then(function () { return {ids: ids, created: missing}; });
    });
  }

  /* Notion forbids commas inside select option names and caps them at 100. */
  function cleanTags(tags) {
    var seen = {}, out = [];
    (tags || []).forEach(function (t) {
      var v = String(t).replace(/,/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
      if (v && !seen[v.toLowerCase()]) { seen[v.toLowerCase()] = true; out.push(v); }
    });
    return out.slice(0, 100);
  }

  /**
   * Swap an authorization code for a token through our own endpoint.
   *
   * A plain cross-origin POST: the endpoint returns CORS headers for extension
   * origins, so this needs no host permission. Notion's own error bodies come
   * back verbatim, which is more useful than anything invented here.
   *
   * @return Promise<Object> the token response
   */
  function exchangeCode(exchangeUrl, code, redirect) {
    return fetch(exchangeUrl, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({code: code, redirect_uri: redirect})
    }).then(function (response) {
      return response.text().then(function (text) {
        var data;
        try { data = text ? JSON.parse(text) : {}; } catch (e) { data = {}; }
        if (!response.ok) {
          throw fail(data.error_description || data.error ||
                     ("The token exchange failed (HTTP " + response.status + ")."),
                     "exchange");
        }
        return data;
      });
    }, function () {
      throw fail("Could not reach the token exchange at " + exchangeUrl + ".", "exchange");
    });
  }

  /** Notion rejects some external image URLs; turn them into links and retry. */
  function demoteImages(blocks) {
    return blocks.map(function (b) {
      if (b.type !== "image") { return b; }
      var url = b.image.external.url;
      return {object: "block", type: "paragraph", paragraph: {rich_text: [
        {type: "text", text: {content: "Image: "}, annotations: {italic: true}},
        {type: "text", text: {content: url, link: {url: url}}}
      ]}};
    });
  }

  function looksLikeImageError(err) {
    return err.status === 400 && /image|url/i.test(err.message || "");
  }

  /**
   * Create the page and append the remaining children in chunks of 100.
   *
   * @param Object settings  from load(): accessToken, target {id, type}
   * @param Object article   {title, url, blocks}
   * @return Promise<{id, url}>
   */
  function createPage(settings, article) {
    var token  = settings.accessToken;
    var target = settings.target;
    if (!token)  { return Promise.reject(fail("Not connected to Notion.", "not-connected")); }
    if (!target) { return Promise.reject(fail("No destination chosen in the options.", "no-target")); }

    var title  = (article.title || "Untitled").slice(0, 2000);
    var blocks = article.blocks || [];
    var props  = {title: {title: [{type: "text", text: {content: title}}]}};
    var parent = target.type === "database" ? {database_id: target.id} : {page_id: target.id};

    // For a database, fill its first URL property with the source if it has one.
    var schema = target.type === "database"
      ? request("/databases/" + target.id, "GET", null, token).catch(function () { return null; })
      : Promise.resolve(null);

    var usedTagProperty = null;
    var createdTags     = [];

    return schema.then(function (db) {
      if (db && db.properties && article.url) {
        for (var name in db.properties) {
          if (db.properties[name].type === "url") { props[name] = {url: article.url}; break; }
        }
      }

      var tags = cleanTags(article.tags);
      var tp   = tags.length ? tagProperty(db) : null;
      if (!tp) { return null; }

      usedTagProperty = tp.name;
      if (tp.type === "multi_select") {
        props[tp.name] = {multi_select: tags.map(function (t) { return {name: t}; })};
      } else if (tp.type === "select") {
        props[tp.name] = {select: {name: tags[0]}};
      } else {
        /* relation: resolve the names to pages in the tags database first */
        return resolveRelationTags(token, tp, tags).then(function (res) {
          props[tp.name] = {relation: res.ids.map(function (i) { return {id: i}; })};
          createdTags = res.created;
        });
      }
      return null;
    }).then(function () {

      function create(children) {
        return request("/pages", "POST", {parent: parent, properties: props, children: children}, token);
      }

      var first = blocks.slice(0, CHUNK);
      return create(first).catch(function (err) {
        if (!looksLikeImageError(err)) { throw err; }
        blocks = demoteImages(blocks);
        return create(blocks.slice(0, CHUNK));
      });
    }).then(function (page) {
      var rest = blocks.slice(CHUNK);
      var seq  = Promise.resolve();
      function append(chunk) {
        return request("/blocks/" + page.id + "/children", "PATCH", {children: chunk}, token)
          .catch(function (err) {
            if (!looksLikeImageError(err)) { throw err; }
            return request("/blocks/" + page.id + "/children", "PATCH",
                           {children: demoteImages(chunk)}, token);
          });
      }
      for (var i = 0; i < rest.length; i += CHUNK) {
        (function (chunk) { seq = seq.then(function () { return append(chunk); }); }(rest.slice(i, i + CHUNK)));
      }
      return seq.then(function () {
        return {id: page.id, url: page.url, tagProperty: usedTagProperty, createdTags: createdTags};
      });
    });
  }

  return {
    ORIGIN: ORIGIN,
    load: load, save: save, disconnect: disconnect,
    redirectURL: redirectURL,
    hasHostPermission: hasHostPermission, requestHostPermission: requestHostPermission,
    connect: connect, listTargets: listTargets, createPage: createPage,
    appDefaults: appDefaults, credentials: credentials,
    tagOptions: tagOptions, offered: offered, visible: visible, _isDestination: isDestination,
    // exposed for tests
    _demoteImages: demoteImages, _titleOf: titleOf, _authorize: authorize,
    _tagProperty: tagProperty, _cleanTags: cleanTags, _looksLikeTagName: looksLikeTagName,
    _resolveRelationTags: resolveRelationTags
  };
}());

if (typeof module !== "undefined" && module.exports) { module.exports = LRNotion; }
