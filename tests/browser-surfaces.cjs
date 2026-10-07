// Astra: real options/picker HTML, JS and CSS; mocked extension/native services.
// Uses an isolated Chrome at CDP_URL (default http://localhost:9563).
const {connect} = require('./cdp.cjs');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const init = `
  window.fixtureErrors = [];
  window.addEventListener('error', e => window.fixtureErrors.push(e.message));
  window.addEventListener('unhandledrejection', e => window.fixtureErrors.push(String(e.reason)));
  window.fixtureMessages = [];
  window.close = () => { window.fixtureClosed = true; };
  const listeners = [];
  function prefs() { return JSON.parse(localStorage.getItem('fixturePrefs') || '{}'); }
  function emit(old, next) {
    const changes = {};
    for (const k of new Set([...Object.keys(old), ...Object.keys(next)])) {
      if (old[k] !== next[k]) changes[k] = {oldValue:old[k], newValue:next[k]};
    }
    listeners.forEach(fn => fn(changes, 'sync'));
  }
  window.addEventListener('storage', e => {
    if (e.key === 'fixturePrefs') emit(JSON.parse(e.oldValue || '{}'), JSON.parse(e.newValue || '{}'));
  });
  window.chrome = {
    storage: {sync: {
      get: (defaults, cb) => cb({...defaults, ...prefs()}),
      set: (patch, cb) => {
        const old = prefs(), next = {...old, ...patch};
        localStorage.setItem('fixturePrefs', JSON.stringify(next)); emit(old, next); if (cb) cb();
      }
    }, onChanged: {addListener: fn => listeners.push(fn)}},
    runtime: {
      getManifest: () => ({version:'1.8.0'}),
      reload: () => { throw new Error('Unexpected extension reload'); },
      sendMessage: (msg, cb) => {
        window.fixtureMessages.push(msg);
        if (msg.type === 'ping') cb({ok:true,version:'1.8.0'});
        else if (msg.type === 'notion-targets') cb({ok:true,targets:[{id:'test-db',type:'database',title:'Reading notes'}],chosen:[]});
        else if (cb) cb({ok:true});
      }
    }
  };`;
const notion = `var LRNotion = {
  credentials: settings => {
    const app = localStorage.getItem('fixtureApp') !== 'missing';
    const id = settings.clientId || (app ? '11111111-1111-1111-1111-111111111111' : '');
    const secret = settings.clientSecret || '';
    return {clientId:id,clientSecret:secret,ready:!!(id && (secret || app)),exchangeUrl:app ? 'https://example.invalid' : ''};
  },
  load: async () => localStorage.getItem('fixtureApp') === 'missing' ? {} :
    {accessToken:'test-only',workspaceName:'Test workspace',targets:[{id:'test-db',type:'database',title:'Reading notes'}]},
  save: async patch => { window.fixtureSaved = patch; return patch; },
  disconnect: async () => ({}),
  redirectURL: () => 'https://test.chromiumapp.org/notion',
  visible: (targets, includePages) => (targets || []).filter(t => includePages || t.type === 'database')
};`;
const folder = `var LRFolder = {
  usable: async () => null, load: async () => null,
  save: async dir => { window.fixtureFolder = dir.name; }, clear: async () => {}
};`;
const allowed = new Set(['options.html','pick.html','options.js','pick.js','ui-theme.js',
  'css/extension.css','css/ui-tokens.css']);
const server = http.createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname.slice(1);
  // Never serve/read real credentials, tokens or arbitrary project files.
  const mock = {'notion.js':notion,'folder.js':folder,'notion-config.js':'// No private configuration in tests.'};
  if (!allowed.has(name) && !Object.hasOwn(mock,name)) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'text/javascript' : 'text/html');
  res.end(Object.hasOwn(mock,name) ? mock[name] : fs.readFileSync(path.join(root,name)));
});
(async () => {
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const pages = [];
  const out = path.join(root,'build/preview/astra'); fs.mkdirSync(out,{recursive:true});
  async function page(file) {
    const p = await connect(); pages.push(p);
    await p.call('Page.addScriptToEvaluateOnNewDocument',{source:init});
    await p.call('Page.navigate',{url:base + '/' + file});
    try {
      await p.waitFor(`document.readyState === 'complete' && typeof LRUITheme !== 'undefined'`);
    } catch (err) {
      throw new Error(err.message + ': ' + JSON.stringify(await p.evaluate(`({url:location.href,ready:document.readyState,errors:window.fixtureErrors,body:document.body && document.body.innerText.slice(0,500)})`)));
    }
    return p;
  }
  try {
    const options = await page('options.html#notion');
    await options.waitFor(`document.activeElement.id === 'notion_connect'`).catch(async err => {
      throw new Error(err.message + ': ' + JSON.stringify(await options.evaluate(`({errors:window.fixtureErrors,active:document.activeElement.id,state:document.getElementById('notion_state').textContent,disabled:document.getElementById('notion_connect').disabled,notion:typeof LRNotion,focus:typeof focusSettingsSection})`)));
    });
    assert.equal(await options.evaluate(`document.querySelector('main > section').id`),'notion');
    console.log('PASS Notion-first options and direct recovery focus');
    const picker = await page('pick.html');
    for (const theme of ['dark','light']) {
      await options.evaluate(`document.getElementById('lr_theme').value = '${theme}'; document.getElementById('lr_theme').dispatchEvent(new Event('change'));`);
      await picker.waitFor(`document.documentElement.dataset.lrTheme === '${theme}'`);
      assert.equal(await options.evaluate(`document.documentElement.dataset.lrTheme`),theme);
      assert.equal(await options.evaluate(`document.documentElement.style.colorScheme`),theme);
      assert.equal(await options.evaluate(`getComputedStyle(document.body).backgroundColor`),
        await picker.evaluate(`getComputedStyle(document.body).backgroundColor`));
      const currentTheme = await options.evaluate(`document.documentElement.dataset.lrTheme`);
      await options.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme === 'dark' ? 'light' : 'dark'}]});
      assert.equal(await options.evaluate(`document.documentElement.dataset.lrTheme`),currentTheme);
      console.log('PASS manual ' + theme + ' applies immediately to options and open picker, independent of OS');
    }
    await options.evaluate(`document.getElementById('lr_theme').value = 'auto'; document.getElementById('lr_theme').dispatchEvent(new Event('change'));`);
    for (const p of [options,picker]) {
      await p.call('Page.bringToFront');
      for (const theme of ['light','dark']) {
        await p.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme}]});
        await p.waitFor(`document.documentElement.dataset.lrTheme === '${theme}'`);
      }
    }
    console.log('PASS System theme follows live OS changes on both surfaces');
    for (const [hash,id] of [['folder','pick_folder'],['appearance','lr_theme'],['custom-css','css_readability'],['destinations','notion_refresh']]) {
      await options.evaluate(`location.hash = '${hash}'`);
      await options.waitFor(`document.activeElement.id === '${id}'`);
    }
    console.log('PASS section links focus their relevant controls');
    await options.evaluate(`document.querySelector('#notion_targets input').click()`);
    assert.deepEqual(await options.evaluate('window.fixtureSaved.chosenTargets'),['test-db']);
    await options.evaluate(`document.getElementById('notion_targets_none').click()`);
    assert.deepEqual(await options.evaluate('window.fixtureSaved.chosenTargets'),[]);
    await options.evaluate(`document.getElementById('css_readability').value = 'article {color: red;}'; document.getElementById('save').click()`);
    assert.equal(await options.evaluate(`JSON.parse(localStorage.getItem('fixturePrefs')).cssReadability`),'article {color: red;}');
    console.log('PASS destination selection and custom CSS persistence preserved');
    await options.call('Page.bringToFront');
    await options.evaluate(`chrome.storage.sync.set({lrTheme:'dark'}); location.hash = 'appearance'`);
    await options.call('Page.reload');
    await options.waitFor(`document.readyState === 'complete' && document.activeElement.id === 'lr_theme'`);
    assert.equal(await options.evaluate(`document.documentElement.dataset.lrTheme`),'dark');
    assert.equal(await options.evaluate(`document.getElementById('lr_theme').value`),'dark');
    console.log('PASS saved theme and deep-link focus survive reload');

    for (const theme of ['light','dark']) {
      for (const width of [900,320]) {
        for (const [name,p] of [['options',options],['picker',picker]]) {
          await p.call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
          await p.evaluate(`LRUITheme.apply('${theme}'); window.scrollTo(0,0)`);
          assert.ok(await p.evaluate(`document.documentElement.scrollWidth <= innerWidth + 1`), name + ' must not overflow');
          const shot = await p.call('Page.captureScreenshot',{format:'png'});
          fs.writeFileSync(path.join(out,`${name}-${theme}-${width}.png`),Buffer.from(shot.data,'base64'));
        }
      }
    }
    console.log('PASS options and picker fit desktop/narrow layouts in both themes');
    await picker.call('Emulation.setDeviceMetricsOverride',{width:460,height:300,deviceScaleFactor:1,mobile:false});
    assert.ok(await picker.evaluate(`document.getElementById('cancel').getBoundingClientRect().bottom <= innerHeight`), 'picker actions fit the actual popup height');
    await picker.call('Page.bringToFront');
    await picker.evaluate(`document.getElementById('choose').focus()`);
    await picker.key('Tab','Tab',9);
    assert.equal(await picker.evaluate(`document.activeElement.id`),'cancel');
    await picker.key('Enter','Enter',13);
    assert.equal(await picker.evaluate(`window.fixtureMessages.at(-1).type`),'folder-cancelled');
    console.log('PASS picker Tab/Enter cancel sends the expected worker message');
    await picker.evaluate(`window.showDirectoryPicker = undefined; document.getElementById('choose').click()`);
    assert.equal(await picker.evaluate(`document.getElementById('state').className`),'err');
    await picker.evaluate(`window.showDirectoryPicker = async () => ({name:'Test notes',requestPermission:async ()=>'granted'}); document.getElementById('choose').click()`);
    await picker.waitFor(`window.fixtureMessages.at(-1).type === 'folder-picked'`);
    assert.equal(await picker.evaluate('window.fixtureFolder'),'Test notes');
    console.log('PASS unsupported-picker error and mocked successful folder selection');

    await options.call('Page.bringToFront');
    await options.evaluate(`localStorage.setItem('fixtureApp','missing'); location.hash = 'notion'`);
    await options.call('Page.reload');
    await options.waitFor(`document.readyState === 'complete' && document.activeElement.id === 'notion_client_id'`);
    assert.equal(await options.evaluate(`document.getElementById('notion_app').open`),true);
    assert.equal(await options.evaluate(`document.getElementById('notion_connect').disabled`),true);
    await options.evaluate(`document.getElementById('notion_client_id').value = '11111111-1111-1111-1111-111111111111';
      document.getElementById('notion_client_secret').value = 'test-only';
      document.getElementById('notion_client_secret').dispatchEvent(new Event('input'));`);
    assert.equal(await options.evaluate(`document.getElementById('notion_connect').disabled`),false);
    console.log('PASS unconfigured recovery focuses credentials and typing enables Connect');
    for (const p of pages) assert.deepEqual(await p.evaluate('window.fixtureErrors'),[]);
    console.log('PASS no uncaught browser errors');
  } finally {
    for (const p of pages) await p.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(err => {console.error(err); server.close(); process.exitCode = 1;});
