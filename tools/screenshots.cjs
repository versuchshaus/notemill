#!/usr/bin/env node
// Regenerates the README screenshots in assets/readme/ from the real extension:
// the real readability.js, stylesheets, options page and - for the install
// picture - the release build loaded into Chrome's own extensions page.
//
//   make release && node tools/screenshots.cjs
//
// It starts its own headless Chrome with a throwaway profile on a free port,
// and stops only that process. Notion and the file system are mocked with a
// fictional workspace ("Acme Studio") and a neutral sample article, so no
// personal data can end up in a picture. Needs Node 22+ and Google Chrome.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const {spawn} = require('node:child_process');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'assets/readme');
const chromeBin = process.env.CHROME ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const release = path.join(root, 'build/notemill');

/* ---- what the pictures show: a fictional workspace ---------------------- */
const TARGETS = [
  {id: 'reading', type: 'database', title: 'Reading list', icon: '📚'},
  {id: 'research', type: 'database', title: 'Research notes', icon: '🔬'},
  {id: 'inbox', type: 'page', title: 'Inbox', icon: '📥'}
];
const TAGS = ['Habits', 'Research', 'Design', 'Productivity', 'Writing'];

/* Runs in the page before its own scripts: stands in for the extension APIs. */
function chromeMock(theme, state) {
  return `(() => {
    const prefs = {lrTheme: ${JSON.stringify(theme)}};
    const targets = ${JSON.stringify(TARGETS)};
    window.__shotState = ${JSON.stringify(state || '')};
    window.chrome = {
      storage: {
        sync: {get: (d, cb) => cb(Object.assign({}, d, prefs)), set: (p, cb) => cb && cb()},
        local: {get: (d, cb) => cb(d || {}), set: (p, cb) => cb && cb()},
        onChanged: {addListener: () => {}}
      },
      runtime: {
        id: 'screenshot', lastError: null,
        getURL: p => '/' + p,
        getManifest: () => ({version: '1.9.0'}),
        reload: () => {},
        sendMessage: (msg, cb) => {
          const reply = r => cb && setTimeout(() => cb(r), 0);
          switch (msg.type) {
            case 'ping': return reply({ok: true, version: '1.9.0'});
            case 'notion-targets':
              // What sw.js sends the reader by default: databases only.
              return reply({ok: true, targets: targets.filter(t => t.type === 'database'),
                            chosen: ['reading', 'research'], defaultId: 'reading',
                            tagsByTarget: {reading: 'Habits, Research'}});
            case 'notion-tag-options': return reply({ok: true, property: 'Tags', options: ${JSON.stringify(TAGS)}});
            case 'notion-send': return reply({ok: true, url: 'https://www.notion.so/', tagProperty: 'Tags'});
            case 'save-target': return reply({ok: true, folder: null});
            default: return reply({ok: true});
          }
        }
      }
    };
  })();`;
}

/* Options-page stand-ins for notion.js and folder.js. */
const NOTION_MOCK = `var LRNotion = {
  credentials: s => ({clientId: 'public-client-id', clientSecret: '', exchangeUrl: 'https://exchange.invalid',
                      ready: true, viaExchange: true}),
  load: async () => window.__shotState === 'connected'
    ? {accessToken: 'mock', workspaceName: 'Acme Studio', targets: ${JSON.stringify(TARGETS)},
       chosenTargets: ['reading', 'research']}
    : {},
  save: async p => p, disconnect: async () => ({}),
  redirectURL: () => 'https://<extension-id>.chromiumapp.org/notion',
  visible: (targets, includePages) => (targets || []).filter(t => includePages || t.type === 'database')
};`;
const FOLDER_MOCK = `var LRFolder = {usable: async () => null, load: async () => null, save: async () => {}, clear: async () => {}};`;

/* ---- a tiny static server: only the files the pictures need ------------- */
const SERVE = {
  '/fixture/article.html': 'tools/fixture/article.html',
  '/fixture/cards.svg': 'tools/fixture/cards.svg',
  '/readability.js': 'readability.js',
  '/options.html': 'options.html', '/options.js': 'options.js', '/ui-theme.js': 'ui-theme.js'
};
const MOCKS = {'/notion.js': NOTION_MOCK, '/folder.js': FOLDER_MOCK,
               '/notion-config.js': '// mocked for screenshots'};
const TYPES = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
               '.svg': 'image/svg+xml', '.woff': 'font/woff', '.png': 'image/png'};

function serve(req, res) {
  const p = new URL(req.url, 'http://x').pathname;
  let body = null;
  if (MOCKS[p] !== undefined) { body = MOCKS[p]; }
  else if (SERVE[p]) { body = fs.readFileSync(path.join(root, SERVE[p])); }
  else if (/^\/(css|img)\/[\w./-]+$/.test(p) && !p.includes('..')) {
    const f = path.join(root, p);
    if (fs.existsSync(f)) { body = fs.readFileSync(f); }
  }
  if (body === null) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, {'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream'});
  res.end(body);
}

function freePort() {
  return new Promise(resolve => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function waitForChrome(base) {
  for (let i = 0; i < 100; i++) {
    try { return await (await fetch(base + '/json/version')).json(); } catch (e) { await sleep(100); }
  }
  throw new Error('Chrome did not start');
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---- shots --------------------------------------------------------------- */
async function shot(page, file, clip) {
  const params = {format: 'png', captureBeyondViewport: false};
  if (clip) { params.clip = Object.assign({scale: 1}, clip); }
  const {data} = await page.call('Page.captureScreenshot', params);
  fs.writeFileSync(path.join(out, file), Buffer.from(data, 'base64'));
  console.log('  ' + file);
}

async function rect(page, expr, pad) {
  const r = await page.evaluate(`(() => { const r = (${expr}).getBoundingClientRect();
    return {x: r.left, y: r.top, width: r.width, height: r.height}; })()`);
  pad = pad || 0;
  return {x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.width + 2 * pad, height: r.height + 2 * pad};
}

async function openPage(connect, cdpBase, width, height, theme, init) {
  const page = await connect(cdpBase);
  await page.call('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 2, mobile: false});
  await page.call('Emulation.setEmulatedMedia', {features: [{name: 'prefers-color-scheme', value: theme}]});
  if (init) { await page.call('Page.addScriptToEvaluateOnNewDocument', {source: init}); }
  return page;
}

async function reader(connect, cdpBase, web, theme) {
  const page = await openPage(connect, cdpBase, 1280, 800, theme, chromeMock(theme));
  await page.call('Page.navigate', {url: web + '/fixture/article.html'});
  await page.waitFor(`document.readyState === 'complete'`);
  await page.evaluate(`fetch('/readability.js').then(r => r.text()).then(src => { (0, eval)(src); readability.init(); })`);
  await page.waitFor(`!!document.getElementById('readTools') &&
    getComputedStyle(document.getElementById('readTools')).position === 'sticky'`);
  await page.evaluate(`document.fonts.ready.then(() => true)`);
  await sleep(400);
  const bar = `document.getElementById('readTools')`;

  // 1. The page as it opens, Send to Notion armed: the hero.
  await shot(page, `reader-${theme}.png`);

  // 2. Send to Notion: destination and tags, right under the button.
  await page.evaluate(`document.getElementById('send-notion').click()`);
  await page.waitFor(`!!document.getElementById('readNotionTags') && document.getElementById('readNotionTags').placeholder.indexOf('loading') === -1`);
  await sleep(350);
  await shot(page, `notion-row-${theme}.png`, await rect(page, bar, 18));
  await shot(page, `reader-notion-${theme}.png`);

  // 3. Saved: the result line, with a link to the new page.
  await page.evaluate(`document.querySelector('#readMarkdownStatus .primary').click()`);
  await page.waitFor(`document.getElementById('readMarkdownStatus').classList.contains('is-done')`);
  await sleep(300);
  await shot(page, `notion-saved-${theme}.png`, await rect(page, bar, 18));

  // 4. Save .md: where it goes, and the Save button under the trigger.
  await page.evaluate(`document.getElementById('save-markdown').click()`);
  await page.waitFor(`!!document.querySelector('#readMarkdownStatus .lr-value')`);
  await sleep(350);
  await shot(page, `markdown-row-${theme}.png`, await rect(page, bar, 18));
  await page.close();
}

async function options(connect, cdpBase, web, theme, state, file) {
  const page = await openPage(connect, cdpBase, 900, 1100, theme, chromeMock(theme, state));
  await page.call('Page.navigate', {url: web + '/options.html'});
  await page.waitFor(`document.readyState === 'complete' && typeof LRUITheme !== 'undefined' &&
    document.getElementById('notion_state').textContent.length > 0`);
  await page.evaluate(`document.activeElement && document.activeElement.blur(); document.fonts.ready.then(() => true)`);
  await sleep(300);
  const top = await rect(page, `document.querySelector('header')`, 0);
  const sec = await rect(page, `document.getElementById('notion')`, 0);
  const x = Math.max(0, sec.x - 24);
  await shot(page, file, {x, y: Math.max(0, top.y - 20), width: sec.width + 48, height: sec.y + sec.height - top.y + 44});
  await page.close();
}

/* chrome://extensions with Developer mode on and Notemill loaded, annotated. */
async function extensionsPage(connect, connectBrowser, cdpBase, theme) {
  if (!fs.existsSync(path.join(release, 'manifest.json'))) {
    console.log('  (skipped extensions page: run `make release` first)');
    return;
  }
  const browser = await connectBrowser(cdpBase);
  const {id} = await browser.call('Extensions.loadUnpacked', {path: release});
  await sleep(800);
  // The extension opens its settings on install; close that tab.
  const {targetInfos} = await browser.call('Target.getTargets');
  for (const t of targetInfos) {
    if (t.url.startsWith('chrome-extension://') && t.type === 'page') {
      await browser.call('Target.closeTarget', {targetId: t.targetId});
    }
  }
  const page = await openPage(connect, cdpBase, 1280, 720, theme);
  await page.call('Page.navigate', {url: 'chrome://extensions'});
  await page.waitFor(`!!document.querySelector('extensions-manager')`);
  await sleep(500);
  await page.evaluate(`(() => {
    const tb = document.querySelector('extensions-manager').shadowRoot.querySelector('extensions-toolbar');
    const dev = tb.shadowRoot.querySelector('#devMode');
    if (!dev.checked) dev.click();
  })()`);
  await sleep(700);
  const marks = await page.evaluate(`(() => {
    const mgr = document.querySelector('extensions-manager').shadowRoot;
    const tb = mgr.querySelector('extensions-toolbar').shadowRoot;
    const dev = tb.querySelector('#devMode');
    const label = tb.querySelector('#devModeLabel') || dev.previousElementSibling || dev;
    const load = tb.querySelector('#loadUnpacked');
    const list = mgr.querySelector('extensions-item-list').shadowRoot;
    const card = list.querySelector('extensions-item#${id}') || list.querySelector('extensions-item');
    const box = el => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; };
    const a = box(label), b = box(dev);
    return {dev: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])],
            load: box(load), card: box(card)};
  })()`);
  const ring = theme === 'dark' ? '#FF8A4C' : '#D9480F';
  await page.evaluate(`(() => {
    const marks = ${JSON.stringify(marks)};
    const layer = document.createElement('div');
    Object.assign(layer.style, {position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: 2147483647});
    [['dev', '1'], ['load', '2'], ['card', '3']].forEach(([k, n]) => {
      const [l, t, r, b] = marks[k];
      const pad = k === 'card' ? 6 : 6;
      const box = document.createElement('div');
      Object.assign(box.style, {position: 'absolute', left: (l - pad) + 'px', top: (t - pad) + 'px',
        width: Math.min(r - l + 2 * pad, innerWidth - (l - pad) - 4) + 'px', height: (b - t + 2 * pad) + 'px',
        border: '3px solid ${ring}', borderRadius: '10px'});
      const badge = document.createElement('div');
      badge.textContent = n;
      // Corner badge; where the corner would leave the picture, beside the ring instead.
      const cornered = t - pad - 14 >= 4;
      const bx = cornered ? Math.max(4, l - pad - 14) : l - pad - 34;
      const by = cornered ? t - pad - 14 : t + (b - t) / 2 - 13;
      Object.assign(badge.style, {position: 'absolute', left: bx + 'px', top: by + 'px',
        width: '26px', height: '26px', borderRadius: '13px', background: '${ring}', color: '#fff',
        font: '700 15px/26px system-ui, sans-serif', textAlign: 'center'});
      layer.appendChild(box); layer.appendChild(badge);
    });
    document.body.appendChild(layer);
  })()`);
  await sleep(200);
  const bottom = Math.min(720, marks.card[3] + 40);
  await shot(page, `install-extensions-${theme}.png`, {x: 0, y: 0, width: 1280, height: bottom});
  await page.close();
  await browser.call('Extensions.uninstall', {id}).catch(() => {});
  browser.closeSocket();
}

/* ---- main ---------------------------------------------------------------- */
(async () => {
  fs.mkdirSync(out, {recursive: true});
  const server = http.createServer(serve);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const web = 'http://127.0.0.1:' + server.address().port;

  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'notemill-shots-'));
  const chrome = spawn(chromeBin, ['--headless=new', '--user-data-dir=' + profile,
    '--remote-debugging-port=' + port, '--enable-unsafe-extension-debugging',
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--force-color-profile=srgb', '--lang=en-US', 'about:blank'], {stdio: 'ignore'});
  const cdpBase = 'http://127.0.0.1:' + port;
  process.env.CDP_URL = cdpBase;
  const {connect, connectBrowser} = require('../tests/cdp.cjs');
  try {
    await waitForChrome(cdpBase);
    for (const theme of ['light', 'dark']) {
      console.log(theme);
      await reader(connect, cdpBase, web, theme);
      await options(connect, cdpBase, web, theme, 'connect', `options-connect-${theme}.png`);
      await options(connect, cdpBase, web, theme, 'connected', `options-connected-${theme}.png`);
      await extensionsPage(connect, connectBrowser, cdpBase, theme);
    }
  } finally {
    chrome.kill();
    server.close();
    await sleep(300);
    fs.rmSync(profile, {recursive: true, force: true});
  }
})().catch(err => { console.error(err); process.exit(1); });
