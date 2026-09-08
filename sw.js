// Service worker. Injects Readability on click and owns the Notion token.
//
// The file is deliberately named sw.js rather than background.js: Chromium
// keys a service worker registration by script URL, and Dia would not pick up
// a changed background.js even across restarts and version bumps - it kept
// running a months-old copy that knew nothing of newer message types. A new
// filename forces a new registration. If this ever recurs, rename again.
//
// Nothing is injected until the user asks for it: activeTab grants access only
// to the tab that was clicked, so the extension never runs on pages you haven't
// explicitly pointed it at.

// Chrome runs this as a service worker (importScripts available); Firefox runs
// it as an event page, where the manifest lists notion.js ahead of this file.
if (typeof importScripts === "function") {
  // Optional: local app credentials, so nobody has to create an integration.
  // Missing is normal - importScripts throws on a 404 and would kill the worker.
  try { importScripts("notion-config.js"); } catch (e) { /* no local app configured */ }
  importScripts("folder.js");
  importScripts("notion.js");
}

// Tag options per database, for the lifetime of this worker. Cheap to rebuild.
var tagOptionCache = {};

// First run: show the options page once, so the Notion connection can be made
// before anyone hits a reader page and wonders why saving fails.
chrome.runtime.onInstalled.addListener(function (details) {
  if (details.reason !== "install") { return; }
  chrome.runtime.openOptionsPage();
});

chrome.action.onClicked.addListener(function(tab) {
  chrome.scripting.executeScript({
    target: {tabId: tab.id},
    // Order matters: readability.js defines the parser, content.js runs it.
    files: ["readability.js", "content.js"]
  }).catch(function(err) {
    // Browsers refuse injection on privileged pages (chrome://, the extension
    // gallery, PDF viewer). Nothing we can do, so fail quietly.
    console.warn("Notemill: cannot run on this page - " + err.message);
  });
});

// The reader page's "Send to Notion" button lives in the content script, which
// cannot reach api.notion.com itself (CORS, and no host permission). It hands
// the converted article here; the service worker holds the token and posts it.
chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (!msg || !msg.type || !sender || sender.id !== chrome.runtime.id) { return; }

  // Lets any extension page prove which build of this file is actually running.
  if (msg.type === "ping") {
    sendResponse({ok: true, version: chrome.runtime.getManifest().version});
    return;
  }

  if (msg.type === "open-options") {
    chrome.runtime.openOptionsPage();
    return;
  }

  // Destinations for the reader page's chooser. Cached from sign-in; refreshed on demand.
  if (msg.type === "notion-targets") {
    LRNotion.load().then(function (settings) {
      if (!settings.accessToken) { throw errorWithCode("Connect Notion in the extension options first.", "not-connected"); }
      var cached = settings.targets || [];
      if (!msg.refresh && cached.length) { return {targets: cached, settings: settings}; }

      return LRNotion.hasHostPermission().then(function (ok) {
        if (!ok) { throw errorWithCode("Notion access was not granted - reconnect in the options.", "no-permission"); }
        return LRNotion.listTargets(settings.accessToken, settings.botId).then(function (targets) {
          return {targets: targets, settings: settings};
        });
      });
    }).then(function (r) {
      /* The options page asks for everything, so it can offer the choice;
         the reader gets only what was ticked there. */
      var targets = msg.all ? r.targets : LRNotion.offered(r.targets, r.settings.chosenTargets);
      sendResponse({ok: true, targets: targets, total: (r.targets || []).length,
                    chosen: r.settings.chosenTargets || [],
                    defaultId: r.settings.target ? r.settings.target.id : null,
                    tagsByTarget: r.settings.tagsByTarget || {}});
    }, function (err) {
      sendResponse({ok: false, error: err.message, code: err.code || "notion"});
    });
    return true;
  }

  // Existing tag names from the destination database's schema, for the picker.
  if (msg.type === "notion-tag-options") {
    LRNotion.load().then(function (settings) {
      if (!settings.accessToken) { throw errorWithCode("Connect Notion in the extension options first.", "not-connected"); }
      if (!msg.targetId) { throw errorWithCode("No database given.", "no-target"); }
      if (tagOptionCache[msg.targetId] && !msg.refresh) { return tagOptionCache[msg.targetId]; }
      return LRNotion.tagOptions(settings.accessToken, msg.targetId).then(function (info) {
        tagOptionCache[msg.targetId] = info;
        return info;
      });
    }).then(function (info) {
      sendResponse({ok: true, property: info && info.property, options: (info && info.options) || []});
    }, function (err) {
      sendResponse({ok: false, error: err.message, code: err.code || "notion"});
    });
    return true;
  }

  // Open the folder picker in a window of its own and report what was chosen.
  // The reader page cannot do this itself: showDirectoryPicker exists only in
  // an extension page, and a handle cannot be passed through a message.
  if (msg.type === "pick-folder") {
    openFolderPicker(sendResponse);
    return true;
  }

  // Sent by pick.html when the user finishes or gives up.
  if (msg.type === "folder-picked" || msg.type === "folder-cancelled") {
    settleFolderPicker(msg.type === "folder-picked" ? msg.name : null);
    sendResponse({ok: true});
    return;
  }

  // Where "Save .md" will write: a folder the user chose, or Downloads.
  if (msg.type === "save-target") {
    LRFolder.usable().then(function (dir) {
      sendResponse({ok: true, folder: dir ? dir.name : null});
    }, function () {
      sendResponse({ok: true, folder: null});
    });
    return true;
  }

  // Save the article as a folder: the document plus every picture in it.
  if (msg.type === "save-bundle") {
    saveBundle(msg).then(sendResponse, function (err) {
      sendResponse({ok: false, error: err.message});
    });
    return true;
  }

  if (msg.type === "notion-send") {
    LRNotion.load().then(function (settings) {
      if (!settings.accessToken) { throw errorWithCode("Connect Notion in the extension options first.", "not-connected"); }
      // The reader page passes the destination chosen for this send; it becomes the
      // preselection next time. Without one, fall back to the options-page default.
      if (msg.target && msg.target.id) {
        settings = Object.assign({}, settings, {target: msg.target});
        // Remember the destination and the tags typed for it, for next time.
        var byTarget = Object.assign({}, settings.tagsByTarget || {});
        byTarget[msg.target.id] = msg.tagText || "";
        LRNotion.save({target: msg.target, tagsByTarget: byTarget});
      }
      if (!settings.target)      { throw errorWithCode("Choose where to save in the extension options.", "no-target"); }
      return LRNotion.hasHostPermission().then(function (ok) {
        if (!ok) { throw errorWithCode("Notion access was not granted - reconnect in the options.", "no-permission"); }
        return LRNotion.createPage(settings, msg.article || {});
      });
    }).then(function (page) {
      if (msg.target && msg.target.id) { delete tagOptionCache[msg.target.id]; }
      sendResponse({ok: true, url: page.url, id: page.id, tagProperty: page.tagProperty});
    }, function (err) {
      console.warn("Notemill: Notion send failed - " + err.message);
      sendResponse({ok: false, error: err.message, code: err.code || "notion"});
    });
    return true; // keep the channel open for the async response
  }
});

// Anything else: answer instead of letting the port close silently. A stale
// worker (browser kept the old script after a reload) would otherwise produce
// "The message port closed before a response was received" in the page.
chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (!msg || !msg.type || !sender || sender.id !== chrome.runtime.id) { return; }
  if (msg.type === "ping" || msg.type === "open-options" || msg.type === "notion-targets" ||
      msg.type === "notion-tag-options" || msg.type === "notion-send" ||
      msg.type === "save-bundle" || msg.type === "save-target" ||
      msg.type === "pick-folder" || msg.type === "folder-picked" ||
      msg.type === "folder-cancelled") { return; }
  sendResponse({ok: false, code: "unknown",
    error: "The extension's background script does not understand '" + msg.type +
           "' - it is out of date. Reload the extension on the extensions page, then reload this page."});
});

/* The picker window, and the reader waiting on it. One at a time. */
var folderPicker = null;

function openFolderPicker(reply) {
  settleFolderPicker(null);          // whatever was open is stale now

  chrome.windows.create({
    url: chrome.runtime.getURL("pick.html"),
    type: "popup", width: 460, height: 300, focused: true
  }, function (win) {
    if (chrome.runtime.lastError || !win) {
      reply({ok: false, error: "could not open the folder chooser"});
      return;
    }
    folderPicker = {windowId: win.id, reply: reply};
    // Closing the window without choosing must release the reader too; the
    // unload handler in pick.js usually gets there first.
    chrome.windows.onRemoved.addListener(function closed(id) {
      if (!folderPicker || folderPicker.windowId !== id) { return; }
      chrome.windows.onRemoved.removeListener(closed);
      settleFolderPicker(null);
    });
  });
}

function settleFolderPicker(name) {
  if (!folderPicker) { return; }
  var pending = folderPicker;
  folderPicker = null;
  try { pending.reply({ok: true, folder: name || null, cancelled: !name}); } catch (e) { /* gone */ }
  chrome.windows.remove(pending.windowId, function () { void chrome.runtime.lastError; });
}

/**
 * One download per file, into a folder named after the article. Chromium
 * creates the directories from the relative path; ".." and absolute paths are
 * rejected by the API, so the names are cleaned first.
 */
function saveBundle(msg) {
  var folder = safePathPart(msg.folder) || "article";
  var md     = String(msg.markdown || "");
  var images = Array.isArray(msg.images) ? msg.images.slice(0, 100) : [];

  // A folder the user picked wins; otherwise the browser's Downloads folder.
  return LRFolder.usable().then(function (dir) {
    return dir ? saveIntoFolder(dir, folder, md, images) : saveViaDownloads(folder, md, images);
  });
}

/**
 * Write the article into the folder the user chose, through a handle stored
 * in IndexedDB. Silent: no dialog, no Downloads entry.
 */
function saveIntoFolder(dir, folder, md, images) {
  function write(handle, name, data) {
    return handle.getFileHandle(name, {create: true}).then(function (file) {
      return file.createWritable().then(function (stream) {
        return stream.write(data).then(function () { return stream.close(); });
      });
    });
  }

  var saved = 0, failed = 0, root;

  return dir.getDirectoryHandle(folder, {create: true}).then(function (created) {
    root = created;
    return write(root, folder + ".md", md);
  }).then(function () {
    saved += 1;
    var withBytes = images.filter(function (img) { return img && img.data; });
    failed += images.length - withBytes.length;
    if (!withBytes.length) { return null; }

    return root.getDirectoryHandle("images", {create: true}).then(function (pictures) {
      var chain = Promise.resolve();
      withBytes.forEach(function (img) {
        chain = chain.then(function () {
          var name = safePathPart(String(img.path).split("/").pop());
          if (!name) { failed += 1; return null; }
          return write(pictures, name, base64ToBlob(img.data, img.type))
            .then(function () { saved += 1; }, function () { failed += 1; });
        });
      });
      return chain;
    });
  }).then(function () {
    return {ok: true, saved: saved, failed: failed, folder: folder, into: dir.name};
  });
}

/** Bytes arrive base64-encoded, because messages are JSON. */
function base64ToBlob(data, type) {
  var binary = atob(data);
  var bytes = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i += 1) { bytes[i] = binary.charCodeAt(i); }
  return new Blob([bytes], {type: type || "application/octet-stream"});
}

function saveViaDownloads(folder, md, images) {

  function download(options) {
    return new Promise(function (resolve) {
      chrome.downloads.download(options, function (id) {
        resolve(!chrome.runtime.lastError && typeof id === "number");
      });
    });
  }

  // A data: URL, because a service worker has no URL.createObjectURL.
  var doc = download({
    url: "data:text/markdown;charset=utf-8," + encodeURIComponent(md),
    filename: folder + "/" + folder + ".md",
    conflictAction: "uniquify",
    saveAs: false
  });

  return doc.then(function (ok) {
    if (!ok) { throw new Error("the browser refused the download"); }
    var saved = 1, failed = 0;
    var chain = Promise.resolve();
    images.forEach(function (img) {
      chain = chain.then(function () {
        if (!img || !img.url || !img.path) { failed += 1; return; }
        var rel = img.path.split("/").map(safePathPart).filter(Boolean).join("/");
        if (!rel) { failed += 1; return; }
        return download({url: img.url, filename: folder + "/" + rel,
                         conflictAction: "uniquify", saveAs: false})
          .then(function (good) { if (good) { saved += 1; } else { failed += 1; } });
      });
    });
    return chain.then(function () { return {ok: true, saved: saved, failed: failed, folder: folder}; });
  });
}

/* Chromium rejects a filename with a path escape, a leading dot or a
   reserved character, and rejects the whole download rather than fixing it. */
function safePathPart(part) {
  return String(part || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/^\.+/, "")
    .replace(/\.+$/, "")
    .trim()
    .slice(0, 120);
}

function errorWithCode(message, code) {
  var e = new Error(message); e.code = code; return e;
}
