// Options page: custom CSS (chrome.storage.sync) and the Notion connection
// (chrome.storage.local via LRNotion - tokens should not sync across devices).

function $(id) { return document.getElementById(id); }

function flash(el, text, cls, ms) {
  el.textContent = text;
  el.className = cls || "";
  if (ms) { setTimeout(function () { if (el.textContent === text) { el.textContent = ""; } }, ms); }
}

/* ---- Custom CSS ---- */

function saveCSS() {
  chrome.storage.sync.set({cssReadability: $("css_readability").value}, function () {
    flash($("css_state"), "CSS saved.", "ok", 1500);
  });
}

function restoreCSS() {
  chrome.storage.sync.get({cssReadability: ""}, function (items) {
    $("css_readability").value = items.cssReadability;
  });
}

/* ---- the remembered save folder ----

   showDirectoryPicker() only exists in an extension page, which is why the
   choosing happens here; the handle then lives in IndexedDB and the service
   worker writes through it. See folder.js.
------------------------------------------------------------------------- */

function renderFolder(name) {
  var el = $("save_folder");
  if (name) {
    el.textContent = "Saving to “" + name + "”.";
    el.className = "ok";
  } else {
    el.textContent = "Downloads folder.";
    el.className = "hint";
  }
  $("clear_folder").disabled = !name;
}

function restoreFolder() {
  LRFolder.usable().then(function (dir) {
    if (dir) { renderFolder(dir.name); return; }
    // A handle can survive while its permission does not.
    LRFolder.load().then(function (stale) {
      if (stale) {
        flash($("save_folder"), "Access to “" + stale.name + "” expired - choose it again.", "err");
        $("clear_folder").disabled = false;
      } else {
        renderFolder(null);
      }
    });
  });
}

function pickFolder() {
  if (typeof window.showDirectoryPicker !== "function") {
    flash($("save_folder"), "This browser cannot pick a folder; saving to Downloads instead.", "err");
    return;
  }
  window.showDirectoryPicker({mode: "readwrite", startIn: "downloads"}).then(function (dir) {
    return dir.requestPermission({mode: "readwrite"}).then(function (state) {
      if (state !== "granted") { throw new Error("permission not granted"); }
      return LRFolder.save(dir).then(function () {
        renderFolder(dir.name);
        flash($("save_folder"), "Saving to “" + dir.name + "”.", "ok", 2500);
      });
    });
  }).catch(function (err) {
    if (err && err.name === "AbortError") { return; }   // the user closed the dialog
    flash($("save_folder"), "Could not use that folder: " + (err && err.message), "err");
  });
}

function clearFolder() {
  LRFolder.clear().then(function () {
    renderFolder(null);
    flash($("save_folder"), "Saving to the Downloads folder again.", "ok", 2000);
  });
}

/* ---- Theme ---- */

function restoreTheme() {
  chrome.storage.sync.get({lrTheme: "auto"}, function (items) {
    LRUITheme.apply((items && items.lrTheme) || "auto");
  });
}

function saveTheme() {
  LRUITheme.apply($("lr_theme").value);
  chrome.storage.sync.set({lrTheme: $("lr_theme").value}, function () {
    flash($("theme_state"), "Saved. Open Notemill pages follow immediately.", "ok", 2000);
  });
}

/* ---- Notion ---- */

/* The settings as last rendered, so typing can be told apart from what is saved. */
var storedNotion = {};

/**
 * Say which Notion app signs in, whenever that is not simply the built-in one.
 *
 * Notemill uses either the user's own app or the built-in connection, never a
 * mix (see LRNotion.credentials). When own credentials are saved although a
 * built-in connection exists, that is said out loud, with one click back to
 * the built-in connection: forgotten credentials from an earlier test are
 * otherwise invisible, and Notion's refusal of them looks like a broken sign-in.
 * This describes what is saved; renderTyped() describes what is being typed.
 */
function renderSource(cred, settings) {
  var text = "", cls = "hint";
  if (cred.conflict && cred.ready) {
    text = "Your own Notion app is saved under Notion app credentials, so Notemill signs in with it " +
           "instead of its built-in connection.";
    cls = "warn";
  } else if (cred.conflict) {
    text = "Part of your own Notion app is saved under Notion app credentials: " +
           (cred.ownClientId ? "a client ID without its secret" : "a client secret without its client ID") +
           ". Notemill uses either your own app or its built-in connection, so it cannot sign in. " +
           "Fill in the missing field, or use the built-in connection.";
    cls = "warn";
  } else if (cred.problem === "own-incomplete") {
    text = cred.ownClientId ? "Add your Notion app's client secret below to enable Connect."
                            : "Add your Notion app's OAuth client ID below to enable Connect.";
  } else if (cred.problem === "none") {
    text = "Add your own Notion app below, or ship one in notion-config.js, to enable Connect.";
  } else if (cred.problem === "config-incomplete") {
    text = "notion-config.js has a client ID but neither a client secret nor a token exchange, " +
           "so Connect cannot work.";
    cls = "err";
  } else if (cred.problem === "config-both") {
    text = "notion-config.js sets both a client secret and a token exchange. Notemill signs in with " +
           "the secret and ignores the exchange. Remove one of them.";
    cls = "warn";
  } else if (settings && settings.accessToken && settings.connectedWith === "own" && cred.source === "builtin") {
    /* The own app is gone from the settings, but the token in use is still
       its token: saving keeps working only while that app exists in Notion. */
    text = "Notemill is still connected through your own Notion app. Sign in again with the button " +
           "above to switch to the built-in connection.";
    cls = "warn";
  }
  flash($("notion_source"), text, text ? cls : "");
  $("notion_source_actions").hidden = !cred.conflict;
  $("notion_builtin_hint").hidden = !cred.builtIn;
}

/**
 * While typing: what pressing Connect would do with the fields as they are.
 * Nothing is saved before Connect, so this never says "saved", and it sits
 * under the fields so that the fields themselves do not move.
 */
function renderTyped(typed, saved) {
  var text = "", cls = "hint";
  var changed = typed.ownClientId !== saved.ownClientId || typed.ownClientSecret !== saved.ownClientSecret;
  if (changed && typed.source === "own" && typed.ready && typed.builtIn) {
    text = "When you press Connect, Notemill signs in with this Notion app instead of its built-in connection.";
    cls = "warn";
  } else if (changed && typed.source === "own" && !typed.ready) {
    text = typed.ownClientId
      ? "Enter the client secret as well" +
        (typed.builtIn ? ", or clear the client ID to keep the built-in connection." : " to enable Connect.")
      : "Enter the OAuth client ID as well" +
        (typed.builtIn ? ", or clear the secret to keep the built-in connection." : " to enable Connect.");
  } else if (changed && typed.source === "builtin") {
    text = "When you press Connect, Notemill uses its built-in connection.";
  }
  flash($("notion_typed"), text, text ? cls : "");
}

/* Connected is a state, so the button says so instead of asking to connect
   again. Pressing it still signs in again, which is how more pages are
   shared or another workspace is chosen - when signing in is possible. */
function renderConnectButton(connected, workspaceName, ready) {
  var button = $("notion_connect");
  button.textContent = connected ? "Connected to " + (workspaceName || "Notion") : "Connect to Notion";
  button.classList.toggle("primary", !connected);
  button.classList.toggle("connected", connected);
  button.title = connected && ready ? "Sign in again to share more pages or to switch workspace" : "";
  if (connected) {
    flash($("notion_state"),
          ready ? "To share more pages or switch workspace, sign in again with the button above." : "", "hint");
  } else {
    flash($("notion_state"), "Not connected.", "");
  }
}

function renderNotion(settings) {
  storedNotion = settings || {};
  var cred = LRNotion.credentials(settings);
  $("notion_client_id").value     = cred.ownClientId;
  $("notion_client_secret").value = cred.ownClientSecret;

  /* With an app shipped in notion-config.js there is nothing to fill in, so
     the credentials stay folded away; when something there needs doing, the
     section opens itself. */
  $("notion_app").open = cred.conflict || !cred.ready;
  $("notion_connect").disabled = !cred.ready;
  renderSource(cred, settings);
  flash($("notion_typed"), "", "");

  var connected = !!settings.accessToken;
  renderConnectButton(connected, settings.workspaceName, cred.ready);
  $("notion_disconnect").hidden = !connected;

  $("notion_include_pages").checked  = !!settings.includePages;
  $("notion_include_pages").disabled = !connected;
  renderTargets(LRNotion.visible(settings.targets, settings.includePages), settings.chosenTargets, connected);
  $("notion_refresh").disabled = !connected;
  $("notion_targets_none").disabled = !connected;
}

/**
 * The destinations, as tick boxes.
 *
 * Notion's /search returns everything the integration can see, and after a few
 * saves most of that is the articles it created - those are filtered out in
 * notion.js. This is where the reader's list is narrowed to what is actually
 * used, because "everything shared" is not a menu anyone wants to read.
 */
function renderTargets(targets, chosen, connected) {
  var host = $("notion_targets");
  host.textContent = "";

  if (!connected || !targets.length) {
    var note = document.createElement("p");
    note.className = "none";
    note.textContent = connected
      ? "Nothing found yet - press Refresh list."
      : "Connect to Notion first.";
    host.appendChild(note);
    flash($("notion_target_state"), "", "hint");
    return;
  }

  var ticked = {};
  (chosen || []).forEach(function (id) { ticked[id] = true; });
  /* "database" / "page" only tells the two apart; with databases alone it is noise. */
  var mixed = targets.some(function (t) { return t.type !== "database"; }) &&
              targets.some(function (t) { return t.type === "database"; });

  targets.forEach(function (t) {
    var row = document.createElement("label");
    var box = document.createElement("input");
    box.type    = "checkbox";
    box.value   = t.id;
    box.checked = !!ticked[t.id];
    box.dataset.type  = t.type;
    box.dataset.title = (t.icon ? t.icon + " " : "") + t.title +
                        (t.type === "database" ? " (db)" : "");
    box.addEventListener("change", saveChosenTargets);

    var name = document.createElement("span");
    name.textContent = (t.icon ? t.icon + " " : "") + t.title;

    var kind = document.createElement("span");
    kind.className   = "kind";
    kind.textContent = t.type === "database" ? "database" : "page";

    row.appendChild(box);
    row.appendChild(name);
    if (mixed) { row.appendChild(kind); }
    host.appendChild(row);
  });

  describeChosen(chosen, targets.length);
}

function describeChosen(chosen, total) {
  var n = (chosen || []).length;
  flash($("notion_target_state"),
        n ? n + " of " + total + " offered in the reader."
          : "Nothing ticked, so all " + total + " are offered.",
        "hint");
}

function saveChosenTargets() {
  var boxes  = $("notion_targets").querySelectorAll("input");
  var chosen = [].filter.call(boxes, function (b) { return b.checked; })
                 .map(function (b) { return b.value; });
  LRNotion.save({chosenTargets: chosen}).then(function () {
    describeChosen(chosen, boxes.length);
  });
}

function clearChosenTargets() {
  [].forEach.call($("notion_targets").querySelectorAll("input"), function (b) { b.checked = false; });
  saveChosenTargets();
}

/** Ask the worker for every destination, not only the ticked ones. */
function refreshTargets() {
  flash($("notion_target_state"), "Asking Notion…", "hint");
  chrome.runtime.sendMessage({type: "notion-targets", refresh: true, all: true}, function (resp) {
    if (chrome.runtime.lastError || !resp) {
      flash($("notion_target_state"),
            "The extension's background script did not answer - reload the extension.", "err");
      return;
    }
    if (!resp.ok) { flash($("notion_target_state"), resp.error, "err"); return; }
    renderTargets(LRNotion.visible(resp.targets, $("notion_include_pages").checked), resp.chosen, true);
  });
}

/* Databases only by default; ordinary pages are an opt-in. The full list is
   already stored, so switching only changes what is shown and offered. */
function saveIncludePages() {
  LRNotion.save({includePages: $("notion_include_pages").checked})
    .then(function () { return LRNotion.load(); })
    .then(renderNotion);
}

function typedCredentials() {
  return LRNotion.credentials({clientId: $("notion_client_id").value.trim(),
                               clientSecret: $("notion_client_secret").value.trim()});
}

function connectNotion() {
  var cred = typedCredentials();

  // Notion's OAuth client ID is a UUID; the integration's *name* is not it.
  if (cred.source === "own" && cred.ownClientId &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cred.ownClientId)) {
    flash($("notion_state"), "That is not an OAuth client ID. Open your integration's Configuration " +
      "tab and copy \"OAuth client ID\" (a UUID like 1a2b3c4d-…), not the integration name.", "err");
    return;
  }
  if (!cred.ready) {
    renderTyped(cred, LRNotion.credentials(storedNotion));
    flash($("notion_state"), "Notemill cannot sign in yet: see the note below.", "err");
    return;
  }
  flash($("notion_state"), "Waiting for Notion…", "");

  /* Persist only what was typed, so the built-in app is never copied into
     the fields for an own app (the normalised values also clear a copy an
     earlier version left there). */
  LRNotion.save({clientId: cred.ownClientId, clientSecret: cred.ownClientSecret})
    .then(function () { return LRNotion.requestHostPermission(); })
    .then(function (granted) {
      if (!granted) { throw new Error("Access to api.notion.com was not granted."); }
      return LRNotion.connect(cred);
    })
    .then(function (settings) {
      renderNotion(settings);
      /* The workspace name now sits on the button, which a screen reader
         does not announce; the status line says it once, right after. */
      flash($("notion_state"), "Connected to " + (settings.workspaceName || "Notion") + ". To share more " +
            "pages or switch workspace, sign in again with the button above.", "ok");
      return refreshTargets();
    })
    .catch(function (err) { flash($("notion_state"), err.message, "err"); });
}

function disconnectNotion() {
  LRNotion.disconnect().then(renderNotion);
}

/* One click out of a conflict: forget the own app, keep any connection the
   user already has, and leave the keyboard on the button that signs in. */
function useBuiltinConnection() {
  LRNotion.save({clientId: "", clientSecret: ""}).then(function (settings) {
    renderNotion(settings);
    $("notion_connect").focus();
  });
}

/**
 * Repair a stale service worker.
 *
 * Chromium can keep running an old copy of the worker script while every
 * extension *page* loads fresh from disk - the worker then rejects message
 * types it has never heard of and the reader page fails for no visible reason.
 * This page can see the mismatch, and chrome.runtime.reload() is the only way
 * to force a fresh worker from inside the extension. Guarded per session so a
 * worker that cannot be healed does not put the page in a reload loop.
 */
function healStaleWorker() {
  var want = chrome.runtime.getManifest().version;
  chrome.runtime.sendMessage({type: "ping"}, function (resp) {
    var got = (!chrome.runtime.lastError && resp && resp.version) || null;
    if (got === want) { return; }

    var tried = null;
    try { tried = sessionStorage.getItem("lrHealed"); } catch (e) { /* private mode */ }
    if (tried === want) {
      flash($("css_state"), "The extension's background script is out of date (" + (got || "not answering") +
        " instead of " + want + ") and reloading did not fix it. Remove the extension and load it " +
        "unpacked again from its folder.", "err");
      return;
    }
    try { sessionStorage.setItem("lrHealed", want); } catch (e) { /* ignore */ }
    flash($("css_state"), "Updating the extension's background script…", "");
    chrome.runtime.reload();
  });
}

/* Astra: recovery links land on a usable control, not merely at the top. */
function focusSettingsSection() {
  var section = window.location.hash.slice(1);
  var targets = {folder: "pick_folder", appearance: "lr_theme", "custom-css": "css_readability",
                 guide: "shortcut_change",
                 destinations: $("notion_refresh").disabled ? "destinations" : "notion_refresh"};
  if (section === "notion") {
    if (!$("notion_connect").disabled) { targets.notion = "notion_connect"; }
    else {
      $("notion_app").open = true;
      targets.notion = $("notion_client_id").value.trim() ? "notion_client_secret" : "notion_client_id";
    }
  }
  var target = targets[section] && $(targets[section]);
  if (!target) { return; }
  target.focus({preventScroll: true});
  target.scrollIntoView({block: "center"});
}

/* ---- the keyboard shortcut ----

   The browser owns the shortcut and people can change it, so it is always
   asked for, never assumed to be ⇧⌘U. The same answer goes into the guide and
   into the toolbar button's tooltip, so whoever forgets it finds it by
   hovering over the icon. */

function readShortcut(done) {
  if (!chrome.commands || !chrome.commands.getAll) { done(null); return; }
  chrome.commands.getAll(function (commands) {
    var mine = (commands || []).filter(function (c) { return c.name === "open-reader"; })[0];
    done(mine && mine.shortcut ? mine.shortcut : "");
  });
}

function actionTitle(shortcut) {
  var base = ((chrome.runtime.getManifest() || {}).action || {}).default_title || "Make this page readable";
  return shortcut ? base + " (" + shortcut + ")" : base;
}

/* What is on screen, so returning to the page does not rewrite the live
   region and make a screen reader read the same line again. */
var shownShortcut;

function renderShortcut() {
  readShortcut(function (shortcut) {
    if (shortcut === shownShortcut) { return; }
    shownShortcut = shortcut;
    var caps = document.querySelectorAll(".js-shortcut");
    for (var i = 0; i < caps.length; i += 1) { caps[i].textContent = shortcut || ""; }
    $("guide_press").hidden = !shortcut;

    var state = $("shortcut_state");
    state.textContent = "";
    if (shortcut === null) {
      state.textContent = "This browser does not offer shortcuts for extensions.";
    } else if (shortcut) {
      state.appendChild(document.createTextNode("Opens the reading view: "));
      var key = document.createElement("kbd");
      key.className = "js-shortcut";
      key.textContent = shortcut;
      state.appendChild(key);
    } else {
      state.textContent = "No shortcut is set. Set one to open the reading view from the keyboard.";
    }
    $("shortcut_change").hidden = shortcut === null;
    $("shortcut_change").textContent = shortcut ? "Change shortcut…" : "Set a shortcut…";

    /* Also after a change made a moment ago on the browser's page. */
    if (shortcut !== null && chrome.action && chrome.action.setTitle) {
      chrome.action.setTitle({title: actionTitle(shortcut)});
    }
  });
}

/* Browsers keep their shortcuts on a page of their own; Firefox can open it
   directly, Chromium browsers by its address. */
function changeShortcut() {
  if (chrome.commands && chrome.commands.openShortcutSettings) {
    chrome.commands.openShortcutSettings();
    return;
  }
  chrome.tabs.create({url: "chrome://extensions/shortcuts"});
}

/* While typing, Connect and the note follow the fields, so starting to fill in
   an own app says at once that it will replace the built-in connection. */
function updateConnectAvailability() {
  var typed = typedCredentials();
  $("notion_connect").disabled = !typed.ready;
  renderTyped(typed, LRNotion.credentials(storedNotion));
  renderConnectButton(!!storedNotion.accessToken, storedNotion.workspaceName, typed.ready);
}

window.addEventListener("hashchange", focusSettingsSection);
$("notion_client_id").addEventListener("input", updateConnectAvailability);
$("notion_client_secret").addEventListener("input", updateConnectAvailability);

document.addEventListener("DOMContentLoaded", function () {
  healStaleWorker();
  renderShortcut();
  restoreFolder();
  restoreTheme();
  restoreCSS();
  $("notion_redirect").textContent = LRNotion.redirectURL();
  LRNotion.load().then(function (settings) {
    renderNotion(settings);
    // Initial fragment navigation can reset focus after DOMContentLoaded.
    // Wait until load/anchor positioning finishes before focusing recovery.
    function focusAfterLoad() { window.requestAnimationFrame(focusSettingsSection); }
    if (document.readyState === "complete") { focusAfterLoad(); }
    else { window.addEventListener("load", focusAfterLoad, {once: true}); }
  });
});

$("pick_folder").addEventListener("click", pickFolder);
$("clear_folder").addEventListener("click", clearFolder);
$("lr_theme").addEventListener("change", saveTheme);
$("save").addEventListener("click", saveCSS);
$("notion_connect").addEventListener("click", connectNotion);
$("notion_disconnect").addEventListener("click", disconnectNotion);
$("notion_use_builtin").addEventListener("click", useBuiltinConnection);
$("shortcut_change").addEventListener("click", changeShortcut);
/* Coming back from the browser's shortcut page shows the new shortcut. */
window.addEventListener("focus", renderShortcut);
document.addEventListener("visibilitychange", function () {
  if (document.visibilityState === "visible") { renderShortcut(); }
});
$("notion_refresh").addEventListener("click", refreshTargets);
$("notion_targets_none").addEventListener("click", clearChosenTargets);
$("notion_include_pages").addEventListener("change", saveIncludePages);
