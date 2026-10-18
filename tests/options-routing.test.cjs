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
    commands:{onCommand:{addListener() {}}},
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

test('the worker starts without a commands API', () => {
  const chrome = {
    runtime:{id:'x', onInstalled:{addListener() {}}, onMessage:{addListener() {}}, getURL:f => f},
    action:{onClicked:{addListener() {}}}, tabs:{}
  };
  assert.doesNotThrow(() => vm.runInNewContext(fs.readFileSync(require.resolve('../sw.js'),'utf8'),{chrome,console}));
});

test('the keyboard shortcut opens the reader in the tab it was pressed in', async () => {
  let onCommand, injected = [];
  const chrome = {
    runtime:{id:'x', onInstalled:{addListener() {}}, onMessage:{addListener() {}}, getURL:f => f},
    action:{onClicked:{addListener() {}}},
    commands:{onCommand:{addListener(fn) { onCommand = fn; }}},
    scripting:{executeScript:async opts => { injected.push(opts); }},
    tabs:{query:(q, cb) => cb([{id: 9}])}
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../sw.js'),'utf8'),{chrome,console});
  onCommand('open-reader', {id: 7});
  onCommand('something-else', {id: 8});
  onCommand('open-reader');          // older Firefox: no tab passed
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(injected.map(o => o.target.tabId), [7, 9]);
  assert.deepEqual(Array.from(injected[0].files), ['readability.js', 'content.js']);
});
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

test('the toolbar tooltip names the shortcut, or stays plain without one', async () => {
  for (const [shortcut, expected] of [['⇧⌘U', 'Make this page readable (⇧⌘U)'], ['', 'Make this page readable']]) {
    let title = null;
    const chrome = {
      runtime:{id:'x', onInstalled:{addListener() {}}, onMessage:{addListener() {}}, getURL:f => f,
               getManifest:() => ({action:{default_title:'Make this page readable'}})},
      action:{onClicked:{addListener() {}}, setTitle:o => { title = o.title; }},
      commands:{onCommand:{addListener() {}}, getAll:cb => cb([{name:'open-reader', shortcut}])},
      tabs:{}
    };
    let startup = null;
    chrome.runtime.onStartup = {addListener(fn) { startup = fn; }};
    vm.runInNewContext(fs.readFileSync(require.resolve('../sw.js'),'utf8'),{chrome,console});
    assert.equal(title, expected);
    // After a browser restart the session title is gone; startup puts it back.
    title = null; startup();
    assert.equal(title, expected);
  }
});
