// Astra: recovery routing stays inside approved extension settings sections.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function fixture() {
  const listeners = [], opened = [];
  const chrome = {
    runtime: {
      id:'test-extension', onInstalled:{addListener() {}},
      onMessage:{addListener(fn) {listeners.push(fn);}},
      getURL:file => 'chrome-extension://test-extension/' + file,
      openOptionsPage:async () => {opened.push('default');}
    },
    action:{onClicked:{addListener() {}}},
    tabs:{create:async opts => {opened.push(opts.url);}}
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../sw.js'),'utf8'),{chrome,console});
  function route(at) {
    return new Promise(resolve => {
      const keepAlive = listeners[0]({type:'open-options',at},{id:chrome.runtime.id},resolve);
      assert.equal(keepAlive,true);
    });
  }
  return {route,opened,chrome,listeners};
}
test('approved recovery sections open local URLs and acknowledge success',async () => {
  const {route,opened} = fixture();
  for (const at of ['notion','destinations','folder','appearance','custom-css']) {
    assert.equal((await route(at)).ok,true);
    assert.equal(opened.at(-1),'chrome-extension://test-extension/options.html#' + at);
  }
});
test('unknown/missing destinations use default options, never arbitrary URLs',async () => {
  const {route,opened} = fixture();
  for (const at of [undefined,'https://example.com','../notion-config.js','__proto__']) {
    assert.equal((await route(at)).ok,true);
    assert.equal(opened.at(-1),'default');
  }
});
test('opening errors are returned to the caller',async () => {
  const {route,chrome} = fixture();
  chrome.tabs.create = async () => {throw new Error('Blocked');};
  const response = await route('notion');
  assert.equal(response.ok,false);
  assert.equal(response.error,'Blocked');
});
