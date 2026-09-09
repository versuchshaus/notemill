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

    // Real layout checks: use production rows and CSS, not a static mockup.
    const screenshotDir = path.join(root, 'build/preview/astra');
    fs.mkdirSync(screenshotDir, {recursive: true});
    for (const theme of ['light', 'dark']) {
      for (const width of [1280, 760, 520, 320]) {
        await call('Emulation.setDeviceMetricsOverride', {width, height: 900, deviceScaleFactor: 1, mobile: false});
        await evaluate(`readability.applyTheme(${JSON.stringify(theme)}); readability.closeRow(false); readability.openPanel('copy-markdown');`);
        const baseline = await evaluate(`document.getElementById('readTools').getBoundingClientRect().width`);
        await evaluate(`readability.writeRow('copy-markdown', ['Copied as Markdown'], 0, true);`);
        // Let resize/ResizeObserver callbacks settle before measuring.
        await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
        const layout = await evaluate(`(() => {
          const bar = document.getElementById('readTools');
          const row = document.getElementById('readMarkdownStatus');
          const owner = document.getElementById('copy-markdown');
          const range = document.createRange(); range.selectNodeContents(row);
          return {barWidth:bar.getBoundingClientRect().width, left:bar.getBoundingClientRect().left,
            right:bar.getBoundingClientRect().right, textLeft:range.getBoundingClientRect().left,
            ownerLeft:owner.getBoundingClientRect().left, rowLeft:row.getBoundingClientRect().left,
            wide:bar.classList.contains('lr-feedback-wide'),
            arrow:getComputedStyle(owner,'::after').display,
            anchor:parseFloat(row.style.getPropertyValue('--lr-row-anchor'))};
        })()`);
        assert.ok(Math.abs(layout.barWidth - baseline) < 1, 'feedback must not widen toolbar: ' + JSON.stringify({baseline,layout}));
        assert.ok(layout.left >= 0 && layout.right <= width + 1, 'toolbar stays within viewport');
        if (layout.wide) {
          assert.equal(layout.anchor, 0);
          assert.equal(layout.arrow, 'none');
          assert.ok(Math.abs(layout.textLeft - layout.rowLeft) < 1);
        } else {
          assert.ok(Math.abs(layout.textLeft - layout.ownerLeft) < 1, 'Copy feedback aligns to owner');
          assert.notEqual(layout.arrow, 'none');
        }
        const shot = await call('Page.captureScreenshot', {format:'png'});
        fs.writeFileSync(path.join(screenshotDir, `copy-${theme}-${width}.png`), Buffer.from(shot.data, 'base64'));
        await evaluate(`readability.writeRow('save-markdown', ['Long result: ' + 'unbroken-filename-'.repeat(35)], 0, true);`);
        assert.ok(await evaluate(`(() => {const row = document.getElementById('readMarkdownStatus');
          return row.scrollWidth <= row.clientWidth + 1;})()`), 'long feedback must wrap');
        await evaluate(`window.holdType = ''; document.getElementById('save-markdown').click();`);
        assert.ok(await evaluate(`(() => {const row = document.getElementById('readMarkdownStatus');
          const owner = document.getElementById('save-markdown');
          return document.getElementById('readTools').classList.contains('lr-feedback-wide') ||
            Math.abs(row.firstElementChild.getBoundingClientRect().left - owner.getBoundingClientRect().left) < 1;
        })()`), 'Save chooser aligns to Save trigger');
        assert.ok(await evaluate(`(() => {const row = document.getElementById('readMarkdownStatus');
          return row.scrollWidth <= row.clientWidth + 1;})()`), 'Save chooser stays contained');
        const saveShot = await call('Page.captureScreenshot', {format:'png'});
        fs.writeFileSync(path.join(screenshotDir, `save-${theme}-${width}.png`), Buffer.from(saveShot.data, 'base64'));
        await evaluate(`document.getElementById('send-notion').click();`);
        assert.ok(await evaluate(`(() => {const row = document.getElementById('readMarkdownStatus');
          return row.scrollWidth <= row.clientWidth + 1;})()`), 'Notion chooser stays contained');
        console.log('PASS feedback geometry, long text, Save and Notion choosers: ' + theme + ' ' + width + 'px');
      }
    }
    // Check a live row after resizing in both directions (no intervening row write).
    await call('Emulation.setDeviceMetricsOverride', {width:1280,height:900,deviceScaleFactor:1,mobile:false});
    await evaluate(`readability.writeRow('copy-markdown', ['Copied'], 0, true)`);
    for (const width of [520, 1280]) {
      await call('Emulation.setDeviceMetricsOverride', {width,height:900,deviceScaleFactor:1,mobile:false});
      await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
      assert.equal(await evaluate(`document.getElementById('readTools').classList.contains('lr-feedback-wide')`), width === 520);
    }
    console.log('PASS live feedback reanchors on narrow → wide resize');
    await evaluate(`document.body.dir = 'rtl'; readability.writeRow('save-markdown', ['Saved'], 0, true);`);
    assert.ok(await evaluate(`(() => {
      const row = document.getElementById('readMarkdownStatus');
      const owner = document.getElementById('save-markdown');
      const range = document.createRange(); range.selectNodeContents(row);
      return Math.abs(range.getBoundingClientRect().right - owner.getBoundingClientRect().right) < 1;
    })()`), 'RTL feedback aligns at the owner right edge');
    console.log('PASS RTL feedback uses the inline start edge');
    await evaluate(`readability.closeRow(false); readability.openPanel('print-page');`);
    assert.equal(await evaluate(`getComputedStyle(document.getElementById('print-page'),'::after').display`), 'none');
    console.log('PASS empty feedback never draws an arrow');

    await evaluate(`document.body.dir = 'ltr'; readability.closeRow(false);
      window.holdType = 'save-target'; document.getElementById('save-markdown').click();`);
    assert.equal(await evaluate(`document.getElementById('readMarkdownStatus').className`), 'lr-row is-busy');
    assert.equal(await evaluate(`document.querySelector('#readMarkdownStatus .spin').getAttribute('aria-hidden')`), 'true');
    await call('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    assert.ok(await evaluate(`parseFloat(getComputedStyle(document.querySelector('#readMarkdownStatus .spin')).animationDuration) <= 0.001`));
    console.log('PASS busy feedback has a decorative spinner and respects reduced motion');

    await evaluate(`window.recordedTimers = []; window.nativeSetTimeout = window.setTimeout;
      window.setTimeout = (fn, ms, ...args) => { window.recordedTimers.push(ms); return window.nativeSetTimeout(fn, ms, ...args); };
      window.deferred.shift().cb({ok:false,error:'Folder access failed — choose it again.'});`);
    assert.equal(await evaluate(`document.getElementById('readMarkdownStatus').className`), 'lr-row is-error');
    assert.equal(await evaluate(`document.querySelector('#readTools a.open').id`), 'save-markdown');
    assert.equal(await evaluate(`!!document.querySelector('#readMarkdownStatus svg:not(.spin)')`), true);
    assert.equal(await evaluate('window.recordedTimers.some(ms => ms > 1000)'), false);
    for (const theme of ['light', 'dark']) {
      await evaluate(`readability.applyTheme(${JSON.stringify(theme)})`);
      const shot = await call('Page.captureScreenshot', {format:'png'});
      fs.writeFileSync(path.join(screenshotDir, `error-${theme}.png`), Buffer.from(shot.data, 'base64'));
    }
    await key('Escape', 'Escape', 27);
    assert.equal(await evaluate(`document.getElementById('readMarkdownStatus').textContent`), '');
    assert.equal(await evaluate('document.activeElement.id'), 'save-markdown');
    console.log('PASS folder errors keep their owner, have no expiry timer and dismiss with Escape');

    await evaluate(`window.holdType = 'notion-targets'; readability.notionCache = null;
      document.getElementById('send-notion').click(); window.recordedTimers = [];
      window.deferred.shift().cb({ok:false,code:'not-connected',error:'Connect Notion first.'});`);
    assert.equal(await evaluate(`document.getElementById('readMarkdownStatus').className`), 'lr-row is-error');
    assert.equal(await evaluate(`document.querySelector('#readMarkdownStatus a').textContent`), 'open options');
    assert.equal(await evaluate('window.recordedTimers.some(ms => ms > 1000)'), false);
    await evaluate(`window.holdType = ''; document.getElementById('send-notion').click();`);
    assert.equal(await evaluate(`document.getElementById('readMarkdownStatus').className`), 'lr-row');
    assert.equal(await evaluate(`!!document.querySelector('#readMarkdownStatus > svg')`), false);
    console.log('PASS actionable Notion errors persist and retry clears error styling/icon');

    await evaluate(`Object.defineProperty(navigator, 'clipboard', {configurable:true,value:{
      writeText: () => Promise.reject(new Error('Blocked for test'))}});
      document.getElementById('copy-markdown').click();`);
    assert.equal(await evaluate(`document.getElementById('readMarkdownStatus').className`), 'lr-row is-error');
    assert.equal(await evaluate(`document.querySelector('#readTools a.open').id`), 'copy-markdown');
    assert.ok(await evaluate(`document.getElementById('readMarkdownStatus').textContent.includes('use Save .md')`));
    await evaluate(`window.setTimeout = window.nativeSetTimeout;`);
    console.log('PASS clipboard failures show owned error feedback with a recovery hint');
  } finally {
    await call('Page.close');
    ws.close();
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
