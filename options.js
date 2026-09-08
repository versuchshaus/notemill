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
    $("lr_theme").value = (items && items.lrTheme) || "auto";
  });
}

function saveTheme() {
  chrome.storage.sync.set({lrTheme: $("lr_theme").value}, function () {
    flash($("theme_state"), "Saved. Open reader pages follow immediately.", "ok", 2000);
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
  var ready = !!(cred.clientId && cred.clientSecret);
  $("notion_app").open = !ready && !settings.accessToken;
  $("notion_connect").disabled = !ready;
  if (!ready) {
    flash($("notion_target_state"),
          cred.clientId ? "Add the client secret below to enable Connect."
                        : "Add an app below, or ship one in notion-config.js, to enable Connect.", "hint");
  }

  var connected = !!settings.accessToken;
  $("notion_disconnect").hidden = !connected;
  if (connected) {
    flash($("notion_state"), "Connected to " + (settings.workspaceName || "your workspace") + ".", "ok");
  } else {
    flash($("notion_state"), "Not connected.", "");
  }

  var select = $("notion_target");
  select.innerHTML = "";
  var targets = settings.targets || [];
  if (!connected) {
    select.appendChild(new Option("— connect first —", ""));
  } else if (!targets.length) {
    select.appendChild(new Option("— nothing shared yet; press Refresh —", ""));
  } else {
    select.appendChild(new Option("— choose —", ""));
    targets.forEach(function (t) {
      var label = (t.icon ? t.icon + " " : "") + t.title +
                  (t.type === "database" ? "  (database)" : "");
      var opt = new Option(label, t.id);
      opt.dataset.type = t.type;
      select.appendChild(opt);
    });
  }
  if (settings.target) { select.value = settings.target.id; }
  select.disabled = !connected;
  $("notion_refresh").disabled = !connected;
}

function refreshTargets(settings) {
  flash($("notion_target_state"), "Loading…", "hint");
  return LRNotion.listTargets(settings.accessToken).then(function (targets) {
    flash($("notion_target_state"), targets.length + " destination(s) available.", "hint");
    return LRNotion.load();
  }).then(renderNotion).catch(function (err) {
    flash($("notion_target_state"), err.message, "err");
  });
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
  if (!cred.clientSecret) { flash($("notion_state"), "The app has no client secret yet.", "err"); return; }
  flash($("notion_state"), "Waiting for Notion…", "");

  var clientId     = cred.clientId;
  var clientSecret = cred.clientSecret;

  // Persist only what was typed, so a shipped app is not copied into storage.
  LRNotion.save({clientId: typedId, clientSecret: typedSecret})
    .then(function () { return LRNotion.requestHostPermission(); })
    .then(function (granted) {
      if (!granted) { throw new Error("Access to api.notion.com was not granted."); }
      return LRNotion.connect(clientId, clientSecret);
    })
    .then(function (settings) {
      renderNotion(settings);
      return refreshTargets(settings);
    })
    .catch(function (err) { flash($("notion_state"), err.message, "err"); });
}

function disconnectNotion() {
  LRNotion.disconnect().then(renderNotion);
}

function chooseTarget() {
  var select = $("notion_target");
  var opt    = select.options[select.selectedIndex];
  if (!opt || !opt.value) { LRNotion.save({target: null}); return; }
  LRNotion.save({target: {id: opt.value, type: opt.dataset.type, title: opt.textContent}})
    .then(function () { flash($("notion_target_state"), "Saved.", "ok", 1500); });
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

document.addEventListener("DOMContentLoaded", function () {
  healStaleWorker();
  restoreFolder();
  restoreTheme();
  restoreCSS();
  $("notion_redirect").textContent = LRNotion.redirectURL();
  LRNotion.load().then(renderNotion);
});

$("pick_folder").addEventListener("click", pickFolder);
$("clear_folder").addEventListener("click", clearFolder);
$("lr_theme").addEventListener("change", saveTheme);
$("save").addEventListener("click", saveCSS);
$("notion_connect").addEventListener("click", connectNotion);
$("notion_disconnect").addEventListener("click", disconnectNotion);
$("notion_refresh").addEventListener("click", function () { LRNotion.load().then(refreshTargets); });
$("notion_target").addEventListener("change", chooseTarget);
