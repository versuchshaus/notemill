// content.js - injected after readability.js, kicks off the parse.
//
// The guard matters because each click re-injects readability.js with a fresh
// bodyCache. Without it, a second click would treat our own rendered output as
// the source article and parse it again.
if (window.notemillDone) {
  console.info("Notemill: this page has already been converted.");
} else {
  window.notemillDone = true;
  readability.init();
}
