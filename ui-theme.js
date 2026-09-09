// Astra: extension-owned pages follow the same lrTheme preference as the reader.
// Loaded in <head> so the system theme applies before the first body paint.
var LRUITheme = (function () {
  "use strict";
  var media = window.matchMedia("(prefers-color-scheme: dark)");
  var preference = "auto";

  function apply(value) {
    preference = value === "light" || value === "dark" ? value : "auto";
    var resolved = preference === "auto" ? (media.matches ? "dark" : "light") : preference;
    document.documentElement.setAttribute("data-lr-theme", resolved);
    document.documentElement.style.colorScheme = resolved;
    var select = document.getElementById("lr_theme");
    if (select) { select.value = preference; }
  }

  apply("auto");
  media.addEventListener("change", function () { apply(preference); });
  document.addEventListener("DOMContentLoaded", function () { apply(preference); });
  chrome.storage.sync.get({lrTheme: "auto"}, function (items) {
    apply((items && items.lrTheme) || "auto");
  });
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === "sync" && changes.lrTheme) { apply(changes.lrTheme.newValue); }
  });
  return {apply: apply};
}());
