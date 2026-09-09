// Astra: real Chromium DOM/keyboard checks with mocked extension services.
// Start an isolated Chrome with --remote-debugging-port=9563, then run this file.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
(async () => {
  const base = process.env.CDP_URL || 'http://localhost:9563';
  const target = await (await fetch(base + '/json/new?about:blank', {method: 'PUT'})).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(resolve => ws.addEventListener('open', resolve, {once: true}));
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (!pending.has(m.id)) return;
    const {resolve, reject} = pending.get(m.id); pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  });
  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++seq; pending.set(id, {resolve, reject});
      ws.send(JSON.stringify({id, method, params}));
    });
  }
  async function evaluate(expression) {
    const r = await call('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  async function key(key, code, virtual) {
    await call('Input.dispatchKeyEvent', {type: 'keyDown', key, code, windowsVirtualKeyCode: virtual, text: key === ' ' ? ' ' : undefined});
    await call('Input.dispatchKeyEvent', {type: 'keyUp', key, code, windowsVirtualKeyCode: virtual});
  }
  try {
    const css = fs.readFileSync(path.join(root, 'css/readability.css'), 'utf8');
    await evaluate(`document.body.innerHTML = '<article><h1>Astra browser fixture</h1>' + '<p>This is a substantial article paragraph, with useful information about reading and saving notes. It contains enough text for extraction and repeated paragraphs for keyboard scrolling.</p>'.repeat(40) + '</article>';
      window.chrome = {storage: {sync: {get: (defaults, cb) => cb({...defaults, cssReadability: ${JSON.stringify(css)}})}}, runtime: {sendMessage: (msg, cb) => {
        if (msg.type === 'save-target') cb({ok:true, folder:'Test notes'});
        else if (msg.type === 'notion-targets') cb({ok:true, targets:[{id:'test',type:'database',title:'Test destination'}]});
        else if (msg.type === 'notion-tag-options') cb({ok:true,property:'Tags',options:[]});
        else if (msg.type === 'notion-send') cb({ok:true,url:'https://example.com/saved'});
        else cb({ok:true});
      }}};
      window.print = () => { window.printCalls = (window.printCalls || 0) + 1; };`);
    await evaluate(fs.readFileSync(path.join(root, 'readability.js'), 'utf8') + '\nreadability.init();');
    await evaluate(`document.getElementById('save-markdown').click()`);
    await key('Escape', 'Escape', 27);
    assert.equal(await evaluate('document.activeElement.id'), 'save-markdown');
    console.log('PASS Save → Escape restores Save focus');
    await evaluate(`document.getElementById('send-notion').click(); document.getElementById('readNotionTags').focus();`);
    await call('Input.insertText', {text: 'machine'});
    const y = await evaluate('window.scrollY');
    await key(' ', 'Space', 32);
    await call('Input.insertText', {text: 'learning'});
    assert.equal(await evaluate(`document.getElementById('readNotionTags').value`), 'machine learning');
    assert.equal(await evaluate('window.scrollY'), y);
    console.log('PASS tag spaces type without scrolling');
    await evaluate(`document.querySelector('#readMarkdownStatus .primary').click()`);
    assert.equal(await evaluate('document.activeElement.id'), 'send-notion');
    console.log('PASS mocked Notion completion restores live trigger focus');
    await evaluate(`readability.writeRow('copy-markdown', ['Copied'], 45000, true); document.getElementById('print-page').click()`);
    assert.equal(await evaluate(`document.querySelector('#readTools a.open').id`), 'copy-markdown');
    assert.equal(await evaluate('window.printCalls'), 1);
    console.log('PASS Print preserves Copy row ownership (print dialog mocked)');

    // Defer selected extension replies to reproduce cancellation and ordering races.
    await evaluate(`window.deferred = []; window.holdType = '';
      const immediate = chrome.runtime.sendMessage;
      chrome.runtime.sendMessage = (msg, cb) => {
        if (msg.type === window.holdType) window.deferred.push({msg, cb});
        else immediate(msg, cb);
      };`);
    await evaluate(`window.holdType = 'notion-targets'; readability.notionCache = null;
      document.getElementById('send-notion').click();`);
    await key('Escape', 'Escape', 27);
    await evaluate(`window.deferred.splice(0).forEach(x => x.cb({ok:true,targets:[{id:'late',type:'page',title:'Late'}]}));`);
    assert.equal(await evaluate(`document.getElementById('readMarkdownStatus').textContent`), '');
    assert.equal(await evaluate('document.activeElement.id'), 'send-notion');
    console.log('PASS delayed Notion destinations cannot reopen an escaped panel');

    await evaluate(`window.holdType = 'save-target'; document.getElementById('save-markdown').click();
      document.getElementById('save-markdown').click();
      window.deferred[1].cb({ok:true,folder:'New folder'});
      window.deferred[0].cb({ok:true,folder:'Old folder'});
      window.deferred = [];`);
    assert.equal(await evaluate(`document.querySelector('#readMarkdownStatus .lr-value').textContent`), 'New folder');
    console.log('PASS repeated Save rejects earlier replies from the same button');

    await evaluate(`window.holdType = 'pick-folder';
      [...document.querySelectorAll('#readMarkdownStatus a')].find(a => a.textContent === 'change folder…').click();`);
    await key('Escape', 'Escape', 27);
    await evaluate(`window.deferred.shift().cb({ok:true,folder:'Late picked folder'});`);
    assert.equal(await evaluate(`document.getElementById('readMarkdownStatus').textContent`), '');
    console.log('PASS delayed folder-picker reply cannot reopen an escaped panel');

    await evaluate(`window.holdType = 'save-bundle'; document.getElementById('save-markdown').click();
      document.querySelector('#readMarkdownStatus .primary').click();
      document.getElementById('send-notion').click();
      window.deferred.shift().cb({ok:true,saved:1});`);
    assert.equal(await evaluate(`document.querySelector('#readTools a.open').id`), 'send-notion');
    assert.equal(await evaluate(`!!document.getElementById('readNotionTags')`), true);
    console.log('PASS submitted save completes without overwriting a newer Notion chooser');

    await evaluate(`window.holdType = 'notion-send';
      document.querySelector('#readMarkdownStatus .primary').click();
      document.getElementById('save-markdown').click();
      window.deferred.shift().cb({ok:false,error:'Late Notion failure'});`);
    assert.equal(await evaluate(`document.querySelector('#readTools a.open').id`), 'save-markdown');
    assert.equal(await evaluate(`document.getElementById('readMarkdownStatus').textContent.includes('Late Notion failure')`), false);
    console.log('PASS late Notion failure cannot overwrite a newer Save chooser');

    await evaluate(`Object.defineProperty(navigator, 'clipboard', {configurable:true,value:{
      writeText: () => new Promise(resolve => { window.finishCopy = resolve; })}});
      document.getElementById('copy-markdown').click();
      document.getElementById('save-markdown').click(); window.finishCopy();`);
    assert.equal(await evaluate(`document.querySelector('#readTools a.open').id`), 'save-markdown');
    console.log('PASS delayed clipboard completion cannot overwrite a newer chooser');

    await evaluate(`window.holdType = 'save-bundle';
      window.originalCollect = readability.collectImages;
      window.originalFetch = readability.fetchImageBytes;
      readability.collectImages = () => ({map:{},list:[{url:'https://example.com/image.png',path:'images/test.png'}]});
      readability.fetchImageBytes = (list, done) => { window.finishImages = () => done(list); };
      document.getElementById('save-markdown').click();
      document.querySelector('#readMarkdownStatus .primary').click();
      document.getElementById('send-notion').click();
      window.finishImages();`);
    assert.equal(await evaluate(`window.deferred[0].msg.type`), 'save-bundle');
    assert.equal(await evaluate(`document.querySelector('#readTools a.open').id`), 'send-notion');
    await evaluate(`window.deferred.shift().cb({ok:true,saved:2});
      readability.collectImages = window.originalCollect;
      readability.fetchImageBytes = window.originalFetch;`);
    assert.equal(await evaluate(`document.querySelector('#readTools a.open').id`), 'send-notion');
    console.log('PASS committed image preparation still submits save without reclaiming feedback');
  } finally {
    await call('Page.close');
    ws.close();
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
