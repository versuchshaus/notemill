// Astra: real MV3 integration, no mocked extension/storage/download services.
// Requires isolated Chrome 152+ with --enable-automation,
// --enable-unsafe-extension-debugging, --headless=new, --remote-debugging-port=9563
// and --user-data-dir=/tmp/notemill-astra-live.<unique>. Never use a personal profile.
// Before launching, set Default/Preferences download.default_directory to that
// profile's downloads/ subdirectory (and prompt_for_download:false).
const {connect,connectBrowser} = require('./cdp.cjs');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname,'..');
const base = process.env.CDP_URL || 'http://localhost:9563';
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
async function until(fn, message) {
  for (let i=0; i<150; i++) { const value = await fn(); if (value) return value; await delay(50); }
  throw new Error(message);
}
(async () => {
  const browser = await connectBrowser(base);
  let server, extensionId;
  const pages = [];
  const work = fs.mkdtempSync(path.join(os.tmpdir(),'notemill-astra-integration.'));
  try {
    const {arguments: args} = await browser.call('Browser.getBrowserCommandLine');
    assert.ok(args.includes('--headless=new') && args.includes('--enable-unsafe-extension-debugging') &&
      args.some(arg => /^--user-data-dir=(\/private)?\/tmp\/notemill-astra-live\./.test(arg)),
      'Refusing real extension tests outside a designated isolated test profile');
    const profile = args.find(arg => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
    const downloads = path.join(profile,'downloads');
    const prefs = JSON.parse(fs.readFileSync(path.join(profile,'Default/Preferences'),'utf8'));
    assert.equal(prefs.download?.default_directory, downloads,
      'Configure the isolated profile download directory before starting Chrome');
    assert.equal(prefs.download?.prompt_for_download, false);
    const staging = path.join(work,'extension');
    fs.mkdirSync(staging); fs.mkdirSync(downloads,{recursive:true});
    const runId = path.basename(work).split('.').at(-1).toLowerCase();
    const title = 'Astra integration fixture ' + runId;
    // Exercise the shipping allowlist, never copy personal credentials or keys.
    const make = fs.readFileSync(path.join(root,'Makefile'),'utf8');
    const shipped = make.match(/SHIPPED := ([\s\S]*?)\n\n/)[1].replace(/\\\n/g,' ').trim().split(/\s+/);
    for (const file of shipped) {
      if (file === 'manifest.json' || file === 'notion-config.js') continue;
      fs.cpSync(path.join(root,file),path.join(staging,file),{recursive:true});
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(root,'manifest.base.json'),'utf8'));
    delete manifest.__firefox_background; delete manifest.browser_specific_settings;
    fs.writeFileSync(path.join(staging,'manifest.json'),JSON.stringify(manifest,null,2));
    fs.writeFileSync(path.join(staging,'notion-config.js'),'// Deliberately unconfigured test build. No private credentials.\nvar LR_NOTION_APP = {};\n');
    // Do not override downloads via CDP: it bypasses extension-suggested paths.
    ({id:extensionId} = await browser.call('Extensions.loadUnpacked',{path:staging}));
    const origin = 'chrome-extension://' + extensionId;
    async function targetAt(url) {
      return until(async () => (await (await fetch(base + '/json/list')).json())
        .find(t => t.type === 'page' && t.url === url), 'Missing extension page: ' + url);
    }
    async function attach(url) {
      const p = await connect(base,await targetAt(url)); pages.push(p); return p;
    }
    const options = await attach(origin + '/options.html');
    await options.waitFor(`document.readyState === 'complete' && document.getElementById('notion_state').textContent === 'Not connected.'`);
    assert.equal(await options.evaluate('chrome.runtime.id'),extensionId);
    const ping = await options.evaluate(`chrome.runtime.sendMessage({type:'ping'})`);
    assert.equal(ping.ok,true); assert.equal(ping.version,manifest.version);
    assert.equal(await options.evaluate(`LRNotion.load().then(settings => !!settings.accessToken)`),false);
    // The shortcut is a command of its own (not _execute_action), so it leaves focus on the page.
    const commands = await options.evaluate(`chrome.commands.getAll()`);
    const readerCommand = commands.find(c => c.name === 'open-reader');
    assert.ok(readerCommand, 'open-reader command registered');
    assert.ok(!commands.some(c => c.name === '_execute_action' && c.shortcut), 'the toolbar-button command has no shortcut');
    assert.match(readerCommand.shortcut, /U$/, 'the suggested shortcut is assigned: ' + readerCommand.shortcut);
    console.log('PASS real extension installs, opens options and answers worker ping (no account connected)');

    const image = fs.readFileSync(path.join(root,'img/icon-128.png'));
    const paragraph = '<p>Astra integration fixture checks local article extraction and Markdown saving. This article has substantial text, meaningful paragraphs, and an image to keep beside the document. Reading and saving should retain the original source link and the complete content.</p>';
    server = http.createServer((req,res) => {
      if (req.url === '/figure.png') {res.setHeader('Content-Type','image/png'); res.end(image); return;}
      // A page with three parts, for keeping only a selection.
      if (req.url.startsWith('/parts')) {
        res.setHeader('Content-Type','text/html');
        const part = word => '<p>' + word + ' part of the page. ' + paragraph.slice(3, -4) + '</p>';
        res.end('<!doctype html><html><head><title>Parts ' + runId + '</title></head><body><article><h1>Parts</h1>' +
          part('ALPHA').repeat(4) + '<ul id="pick"><li>' + part('BETA') + '</li><li>' + part('BETA') + '</li></ul>' +
          part('GAMMA').repeat(4) + '</article></body></html>');
        return;
      }
      // Nothing that looks like an article: a few short links.
      if (req.url === '/links') {
        res.setHeader('Content-Type','text/html');
        res.end('<!doctype html><html><head><title>Links only</title></head><body><nav>' +
          '<a href="/a">One</a> <a href="/b">Two</a> <a href="/c">Three</a></nav></body></html>');
        return;
      }
      if (req.url !== '/article') {res.writeHead(404); res.end(); return;}
      res.setHeader('Content-Type','text/html');
      res.setHeader('Content-Security-Policy',"script-src 'none'; object-src 'none'");
      res.end('<!doctype html><html><head><title>' + title + '</title></head><body><article><h1>' + title + '</h1>' +
        paragraph.repeat(5) + '<figure><img src="/figure.png" width="640" height="360" alt="Fixture illustration"><figcaption>A local illustration.</figcaption></figure>' +
        paragraph.repeat(5) + '</article></body></html>');
    });
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    const articleURL = 'http://127.0.0.1:' + server.address().port + '/article';
    const reader = await connect(base); pages.push(reader);
    await reader.call('Page.navigate',{url:articleURL});
    await reader.waitFor(`location.href === ${JSON.stringify(articleURL)} && document.readyState === 'complete'`);
    // Chrome's extension action targets the tab wrapper, not its page target.
    const tab = await until(async () => {
      const {targetInfos} = await browser.call('Target.getTargets',{filter:[{type:'tab'}]});
      return targetInfos.find(t => t.url === articleURL);
    }, 'Missing article tab target');
    await browser.call('Extensions.triggerAction',{id:extensionId,targetId:tab.targetId});
    await reader.waitFor(`!!document.getElementById('readability-content') && !!document.getElementById('readTools')`);
    await reader.waitFor(`getComputedStyle(document.getElementById('readTools')).getPropertyValue('--fill-bg').trim() !== ''`);
    assert.ok(await reader.evaluate(`document.getElementById('readability-content').textContent.includes('Astra integration fixture')`));
    assert.equal(await reader.evaluate(`document.querySelectorAll('#readability-content img').length`),1);
    console.log('PASS real toolbar activation grants activeTab and injects reader with shared CSS and image intact');

    // Open a fixture page in its own tab, optionally select part of it, press the toolbar icon.
    async function readerFor(pathname, select) {
      const url = 'http://127.0.0.1:' + server.address().port + pathname;
      const p = await connect(base); pages.push(p);
      await p.call('Page.navigate',{url});
      await p.waitFor(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`);
      if (select) await p.evaluate(select);
      const t = await until(async () => {
        const {targetInfos} = await browser.call('Target.getTargets',{filter:[{type:'tab'}]});
        return targetInfos.find(x => x.url === url);
      }, 'Missing tab target for ' + pathname);
      await browser.call('Extensions.triggerAction',{id:extensionId,targetId:t.targetId});
      await p.waitFor(`!!document.getElementById('readability-content') && !!document.getElementById('readTools')`);
      return p;
    }
    const count = (p, word) => p.evaluate(`(document.getElementById('readability-content').textContent.match(/${word}/g) || []).length`);

    // A selection replaces the guess: only the two list items, still as a list.
    const picked = await readerFor('/parts', `(() => { const r = document.createRange();
      r.setStart(document.querySelector('#pick li').firstChild.firstChild, 0);
      r.setEnd(document.querySelector('#pick li:last-child').firstChild.lastChild, 20);
      getSelection().removeAllRanges(); getSelection().addRange(r); })()`);
    assert.equal(await count(picked,'ALPHA'),0);
    assert.equal(await count(picked,'GAMMA'),0);
    assert.equal(await count(picked,'BETA'),2);
    assert.equal(await picked.evaluate(`document.querySelectorAll('#readability-content ul > li').length`),2,'the list survives');
    assert.ok(await picked.evaluate(`!!document.getElementById('readSelectionNote')`));
    assert.equal(await picked.evaluate(`document.getElementById('readSelectionNote').closest('#readability-content')`),null,
      'the note is not part of what is saved');
    console.log('PASS a selection is all the reader shows and keeps, with its list structure and a note');

    // Paragraphs inside a custom element: the wrapper becomes a <div>, so they stay paragraphs.
    const custom = await readerFor('/parts?custom', `(() => {
      const host = document.createElement('app-article-body');
      host.innerHTML = '<p>' + 'DELTA first paragraph of a component. '.repeat(3) + '</p><p>' + 'DELTA second paragraph. '.repeat(3) + '</p>';
      document.querySelector('article').appendChild(host);
      const r = document.createRange(); r.selectNodeContents(host);
      getSelection().removeAllRanges(); getSelection().addRange(r); })()`);
    assert.equal(await custom.evaluate(`document.querySelectorAll('#readability-content app-article-body').length`),0);
    assert.equal(await custom.evaluate(`document.querySelectorAll('#readability-content p').length`),2);
    assert.equal(await count(custom,'ALPHA'),0);
    console.log('PASS a selection inside a custom element keeps its paragraphs apart');

    // Without a selection the same page is read whole, with no note.
    const whole = await readerFor('/parts?whole');
    assert.equal(await count(whole,'ALPHA'),4);
    assert.equal(await count(whole,'GAMMA'),4);
    assert.equal(await whole.evaluate(`document.getElementById('readSelectionNote')`),null);
    console.log('PASS without a selection the whole article is read as before');

    // No article: Notemill's own explanation, and nothing gets saved.
    const empty = await readerFor('/links');
    const said = await empty.evaluate(`document.getElementById('readability-content').textContent`);
    assert.match(said,/Notemill could not find an article on this page/);
    assert.match(said,/select the text you want/);
    assert.doesNotMatch(said,/readability|code\.google/i);
    await empty.evaluate(`document.getElementById('save-markdown').click()`);
    await empty.waitFor(`document.getElementById('readMarkdownStatus').textContent.includes('There is no article here to save')`);
    // Escape closes the row, so Send to Notion has to write the refusal itself.
    await empty.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))`);
    await empty.waitFor(`document.getElementById('readMarkdownStatus').textContent.trim() === ''`);
    await empty.evaluate(`document.getElementById('send-notion').click()`);
    await empty.waitFor(`document.getElementById('readMarkdownStatus').textContent.includes('There is no article here to save')`);
    console.log('PASS a page without an article explains the selection route and refuses to save the message');

    await reader.evaluate(`document.getElementById('send-notion').click()`);
    await reader.waitFor(`document.getElementById('readMarkdownStatus').classList.contains('is-error')`);
    assert.ok(await reader.evaluate(`document.getElementById('readMarkdownStatus').textContent.includes('Connect Notion')`));
    await reader.evaluate(`document.querySelector('#readMarkdownStatus a').click()`);
    const recovery = await attach(origin + '/options.html#notion');
    await recovery.call('Page.bringToFront');
    await recovery.waitFor(`document.activeElement.id === 'notion_client_id'`);
    assert.equal(await recovery.evaluate(`document.getElementById('notion_app').open`),true);
    console.log('PASS real disconnected Notion response opens the credential recovery section');

    for (const theme of ['dark','light']) {
      await options.evaluate(`document.getElementById('lr_theme').value = '${theme}'; document.getElementById('lr_theme').dispatchEvent(new Event('change'))`);
      for (const p of [reader,options,recovery]) await p.waitFor(`document.documentElement.dataset.lrTheme === '${theme}'`);
      assert.equal(await options.evaluate(`chrome.storage.sync.get('lrTheme').then(settings => settings.lrTheme)`),theme);
    }
    await options.evaluate(`document.getElementById('lr_theme').value = 'auto'; document.getElementById('lr_theme').dispatchEvent(new Event('change'))`);
    for (const p of [reader,options,recovery]) {
      await p.call('Page.bringToFront');
      for (const theme of ['dark','light']) {
        await p.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme}]});
        await p.waitFor(`document.documentElement.dataset.lrTheme === '${theme}'`);
      }
    }
    await options.evaluate(`document.getElementById('lr_theme').value = 'light'; document.getElementById('lr_theme').dispatchEvent(new Event('change'))`);
    await options.waitFor(`chrome.storage.sync.get('lrTheme').then(settings => settings.lrTheme === 'light')`);
    await options.call('Page.bringToFront');
    await options.call('Page.reload');
    await options.waitFor(`document.readyState === 'complete' && document.getElementById('lr_theme').value === 'light'`);
    console.log('PASS real Chrome storage persists Day/Night/System and updates reader and multiple options pages');

    await reader.evaluate(`document.getElementById('save-markdown').click()`);
    await reader.waitFor(`!!document.querySelector('#readMarkdownStatus .primary')`);
    await reader.evaluate(`Array.from(document.querySelectorAll('#readMarkdownStatus a')).find(a => /choose folder/.test(a.textContent)).click()`);
    const picker = await attach(origin + '/pick.html');
    await picker.waitFor(`document.readyState === 'complete' && document.documentElement.dataset.lrTheme === 'light'`);
    await options.evaluate(`document.getElementById('lr_theme').value = 'dark'; document.getElementById('lr_theme').dispatchEvent(new Event('change'))`);
    await picker.waitFor(`document.documentElement.dataset.lrTheme === 'dark'`);
    await reader.waitFor(`document.documentElement.dataset.lrTheme === 'dark'`);
    // Cancel the extension popup; do not automate/claim a native folder selection.
    // Let the evaluation reply reach CDP before Cancel closes its own target.
    await picker.evaluate(`setTimeout(() => document.getElementById('cancel').click(), 50); true`);
    picker.closeSocket(); pages.splice(pages.indexOf(picker),1);
    await reader.waitFor(`!!document.querySelector('#readMarkdownStatus .primary')`);
    console.log('PASS real picker window, live theme update and cancellation recover the Save chooser');

    await reader.evaluate(`document.querySelector('#readMarkdownStatus .primary').click()`);
    await reader.waitFor(`document.getElementById('readMarkdownStatus').classList.contains('is-done')`);
    const slug = 'astra-integration-fixture-' + runId;
    const folder = path.join(downloads,slug);
    const mdPath = path.join(folder,slug + '.md');
    const imagePath = path.join(folder,'images','01-figure.png');
    await until(() => fs.existsSync(mdPath) && fs.existsSync(imagePath), 'Expected Markdown/image download files')
      .catch(async err => { throw new Error(err.message + ': ' + JSON.stringify(await options.evaluate(
        `chrome.downloads.search({}).then(items => items.map(i => ({filename:i.filename,state:i.state,error:i.error,bytes:i.bytesReceived})))`))); });
    await until(() => fs.readFileSync(imagePath).equals(image), 'Image download did not finish correctly');
    const markdown = fs.readFileSync(mdPath,'utf8');
    assert.ok(markdown.includes('Astra integration fixture'));
    assert.ok(markdown.includes(articleURL));
    assert.ok(markdown.includes('images/01-figure.png'));
    assert.ok(!markdown.includes('chrome-extension://'));
    console.log('PASS real chrome.downloads writes Markdown plus byte-identical local image');
    console.log('Verified files: ' + folder);

    const out = path.join(root,'build/preview/astra'); fs.mkdirSync(out,{recursive:true});
    for (const [name,p] of [['real-reader',reader],['real-options',options]]) {
      await p.call('Page.bringToFront');
      const shot = await p.call('Page.captureScreenshot',{format:'png'});
      fs.writeFileSync(path.join(out,name + '.png'),Buffer.from(shot.data,'base64'));
    }
    assert.equal(await options.evaluate(`LRNotion.load().then(settings => !!settings.accessToken)`),false);
    console.log('No Notion sign-in or workspace writes performed; native directory selection remains unverified.');
  } finally {
    for (const p of pages.reverse()) {
      try {await p.close();} catch {p.closeSocket();}
    }
    if (extensionId) {
      try {await browser.call('Extensions.uninstall',{id:extensionId});} catch (err) {console.warn('Test extension cleanup: ' + err.message);}
    }
    browser.closeSocket();
    if (server) await new Promise(resolve => server.close(resolve));
  }
})().catch(err => {console.error(err); process.exitCode = 1;});
