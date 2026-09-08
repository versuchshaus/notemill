// A remembered save folder, shared by the options page and the service worker.
//
// Chrome extensions cannot set the browser's download directory, so saving
// outside Downloads means the File System Access API. Two facts shape this
// file, both measured rather than assumed:
//
//   - showDirectoryPicker() exists only in an extension *page*; in the
//     service worker it is undefined.
//   - a FileSystemDirectoryHandle stored in IndexedDB under the extension's
//     own origin can be read back in the service worker, still reports
//     queryPermission() === "granted", and can be written through.
//
// So the options page picks the folder once and stores the handle here; the
// worker reads it on every save and writes without prompting.

var LRFolder = (function () {
  "use strict";

  var DB = "notemill";
  var STORE = "handles";
  var KEY = "saveDir";

  function open() {
    return new Promise(function (resolve, reject) {
      var request = indexedDB.open(DB, 1);
      request.onupgradeneeded = function () {
        if (!request.result.objectStoreNames.contains(STORE)) {
          request.result.createObjectStore(STORE);
        }
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  function transact(mode, run) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, mode);
        var result;
        try { result = run(tx.objectStore(STORE)); } catch (e) { reject(e); return; }
        tx.oncomplete = function () { resolve(result && result.value !== undefined ? result.value : result); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  /** @return Promise<FileSystemDirectoryHandle|null> */
  function load() {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, "readonly");
        var request = tx.objectStore(STORE).get(KEY);
        request.onsuccess = function () { resolve(request.result || null); };
        request.onerror = function () { reject(request.error); };
      });
    }).catch(function () { return null; });
  }

  function save(handle) {
    return transact("readwrite", function (store) { store.put(handle, KEY); });
  }

  function clear() {
    return transact("readwrite", function (store) { store.delete(KEY); });
  }

  /**
   * The handle, only if it is still writable. A grant can be revoked, and a
   * folder can be moved or deleted, in which case this resolves null and the
   * caller falls back to the Downloads folder.
   *
   * @return Promise<FileSystemDirectoryHandle|null>
   */
  function usable() {
    return load().then(function (handle) {
      if (!handle || typeof handle.queryPermission !== "function") { return null; }
      return handle.queryPermission({mode: "readwrite"}).then(function (state) {
        return state === "granted" ? handle : null;
      }).catch(function () { return null; });
    });
  }

  return {load: load, save: save, clear: clear, usable: usable, KEY: KEY};
}());

if (typeof module !== "undefined" && module.exports) { module.exports = LRFolder; }
