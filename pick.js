// The folder picker, in a window of its own.
//
// showDirectoryPicker() exists only in an extension page, and it needs a real
// user gesture in that page - activation does not carry over from the click in
// the reader that opened this window. Hence one button here, and no attempt to
// open the dialog automatically.

(function () {
  "use strict";

  var state = document.getElementById("state");
  var done = false;

  function say(text, cls) {
    state.textContent = text;
    state.className = cls || "";
  }

  function tell(message) {
    done = true;
    try { chrome.runtime.sendMessage(message, function () { void chrome.runtime.lastError; }); }
    catch (e) { /* the worker went away; the window closing is enough */ }
  }

  document.getElementById("choose").addEventListener("click", function () {
    if (typeof window.showDirectoryPicker !== "function") {
      say("This browser cannot choose a folder; Notemill will use Downloads.", "err");
      return;
    }
    say("Waiting for the folder dialog…");
    window.showDirectoryPicker({mode: "readwrite", startIn: "downloads"}).then(function (dir) {
      return dir.requestPermission({mode: "readwrite"}).then(function (granted) {
        if (granted !== "granted") { throw new Error("Notemill was not allowed to write there."); }
        return LRFolder.save(dir).then(function () {
          say("Saving to “" + dir.name + "”.");
          tell({type: "folder-picked", name: dir.name});
          window.setTimeout(function () { window.close(); }, 400);
        });
      });
    }).catch(function (err) {
      if (err && err.name === "AbortError") { say(""); return; }   // dialog dismissed
      say((err && err.message) || "That folder could not be used.", "err");
    });
  });

  document.getElementById("cancel").addEventListener("click", function () {
    tell({type: "folder-cancelled"});
    window.close();
  });

  // Closing the window by any other route still has to release the reader.
  window.addEventListener("unload", function () {
    if (!done) { tell({type: "folder-cancelled"}); }
  });
}());
