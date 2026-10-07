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

function renderNotion(settings) {
  $("notion_client_id").value     = settings.clientId     || "";
  $("notion_client_secret").value = settings.clientSecret || "";

  /* With an app shipped in notion-config.js there is nothing to fill in, so
     the credentials stay folded away; without one, they are the first thing
     that needs doing and the section opens itself. */
  var cred = LRNotion.credentials(settings);
  $("notion_app").open = !cred.ready && !settings.accessToken;
  $("notion_connect").disabled = !cred.ready;
  if (!cred.ready) {
    flash($("notion_target_state"),
          cred.clientId ? "Add a client secret, or a token exchange URL, to enable Connect."
                        : "Add an app below, or ship one in notion-config.js, to enable Connect.", "hint");
  }

  var connected = !!settings.accessToken;
  $("notion_disconnect").hidden = !connected;
  if (connected) {
    flash($("notion_state"), "Connected to " + (settings.workspaceName || "your workspace") + ".", "ok");
  } else {
    flash($("notion_state"), "Not connected.", "");
  }

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

function connectNotion() {
  var typedId     = $("notion_client_id").value.trim();
  var typedSecret = $("notion_client_secret").value.trim();
  var cred        = LRNotion.credentials({clientId: typedId, clientSecret: typedSecret});

  // Notion's OAuth client ID is a UUID; the integration's *name* is not it.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cred.clientId)) {
    flash($("notion_state"), "That is not an OAuth client ID. Open your integration's Configuration " +
      "tab and copy \"OAuth client ID\" (a UUID like 1a2b3c4d-…), not the integration name.", "err");
    return;
  }
  if (!cred.ready) {
    flash($("notion_state"), "This build has neither a client secret nor a token exchange.", "err");
    return;
  }
  flash($("notion_state"), "Waiting for Notion…", "");

  var clientId     = cred.clientId;
  var clientSecret = cred.clientSecret;
  var exchangeUrl  = cred.exchangeUrl;

  // Persist only what was typed, so a shipped app is not copied into storage.
  LRNotion.save({clientId: typedId, clientSecret: typedSecret})
    .then(function () { return LRNotion.requestHostPermission(); })
    .then(function (granted) {
      if (!granted) { throw new Error("Access to api.notion.com was not granted."); }
      return LRNotion.connect(clientId, clientSecret, exchangeUrl);
    })
    .then(function (settings) {
      renderNotion(settings);
      return refreshTargets();
    })
    .catch(function (err) { flash($("notion_state"), err.message, "err"); });
}

function disconnectNotion() {
  LRNotion.disconnect().then(renderNotion);
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

function updateConnectAvailability() {
  var cred = LRNotion.credentials({clientId: $("notion_client_id").value.trim(),
                                   clientSecret: $("notion_client_secret").value.trim()});
  $("notion_connect").disabled = !cred.ready;
}

window.addEventListener("hashchange", focusSettingsSection);
$("notion_client_id").addEventListener("input", updateConnectAvailability);
$("notion_client_secret").addEventListener("input", updateConnectAvailability);

document.addEventListener("DOMContentLoaded", function () {
  healStaleWorker();
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
$("notion_refresh").addEventListener("click", refreshTargets);
$("notion_targets_none").addEventListener("click", clearChosenTargets);
$("notion_include_pages").addEventListener("change", saveIncludePages);
