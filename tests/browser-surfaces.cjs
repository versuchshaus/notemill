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
    commands: {
      getAll: cb => cb(JSON.parse(localStorage.getItem('fixtureCommands') || '[{"name":"open-reader","shortcut":"Ctrl+Shift+Y"}]'))
    },
    action: {setTitle: o => { window.fixtureTitle = o.title; }},
    tabs: {create: o => { window.fixtureOpened = o.url; }},
    runtime: {
      getManifest: () => ({version:'1.8.0', action:{default_title:'Make this page readable'}}),
      reload: () => { throw new Error('Unexpected extension reload'); },
      sendMessage: (msg, cb) => {
        window.fixtureMessages.push(msg);
        if (msg.type === 'ping') cb({ok:true,version:'1.8.0'});
        else if (msg.type === 'notion-targets') cb({ok:true,targets:[{id:'test-db',type:'database',title:'Reading notes'}],chosen:[]});
        else if (cb) cb({ok:true});
      }
    }
  };`;
// The real notion.js, so which credentials win is the shipped logic and not a
// copy of it; only storage, permissions and the sign-in itself are replaced.
const notion = fs.readFileSync(path.join(root,'notion.js'),'utf8') + `
;LRNotion = (function (real) {
  function fixture() {
    if (localStorage.getItem('fixtureApp') === 'missing') return {};
    return Object.assign(
      {accessToken:'test-only',workspaceName:'Test workspace',targets:[{id:'test-db',type:'database',title:'Reading notes'}]},
      JSON.parse(localStorage.getItem('fixtureOwn') || '{}'));
  }
  return Object.assign({}, real, {
    load: async () => fixture(),
    save: async patch => { window.fixtureSaved = patch; return Object.assign(fixture(), patch); },
    disconnect: async () => ({}),
    redirectURL: () => 'https://test.chromiumapp.org/notion',
    requestHostPermission: async () => false,
    connect: async () => { throw new Error('connect is not exercised here'); }
  });
}(LRNotion));`;
// The built-in app, as a published build ships it: a client id and an exchange.
const config = `var LR_NOTION_APP = localStorage.getItem('fixtureApp') === 'missing' ? undefined :
  {clientId:'11111111-1111-1111-1111-111111111111', clientSecret:'', exchangeUrl:'https://example.invalid'};`;
const folder = `var LRFolder = {
  usable: async () => null, load: async () => null,
  save: async dir => { window.fixtureFolder = dir.name; }, clear: async () => {}
};`;
const allowed = new Set(['options.html','pick.html','options.js','pick.js','ui-theme.js',
  'css/extension.css','css/ui-tokens.css']);
const server = http.createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname.slice(1);
  // Never serve/read real credentials, tokens or arbitrary project files.
  const mock = {'notion.js':notion,'folder.js':folder,'notion-config.js':config};
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
    assert.equal(await options.evaluate(`document.getElementById('notion_connect').textContent`),'Connected to Test workspace');
    assert.equal(await options.evaluate(`document.getElementById('notion_connect').className`),'connected');
    assert.equal(await options.evaluate(`document.getElementById('notion_source').textContent`),'');
    assert.equal(await options.evaluate(`document.getElementById('notion_source_actions').hidden`),true);
    assert.equal(await options.evaluate(`document.getElementById('notion_app').open`),false);
    console.log('PASS connected button names the workspace and the built-in connection needs no note');
    // The guide: the browser's shortcut, shown where people look for it, and a way to change it.
    assert.deepEqual(await options.evaluate(`[...document.querySelectorAll('main > section')].map(s => s.id).slice(0, 2)`),['notion','guide']);
    assert.deepEqual(await options.evaluate(`[...document.querySelectorAll('.js-shortcut')].map(k => k.textContent)`),['Ctrl+Shift+Y','Ctrl+Shift+Y']);
    assert.equal(await options.evaluate(`document.getElementById('guide_press').hidden`),false);
    assert.equal(await options.evaluate(`document.getElementById('shortcut_state').textContent`),'Opens the reading view: Ctrl+Shift+Y');
    assert.equal(await options.evaluate('window.fixtureTitle'),'Make this page readable (Ctrl+Shift+Y)');
    await options.evaluate(`document.getElementById('shortcut_change').click()`);
    assert.equal(await options.evaluate('window.fixtureOpened'),'chrome://extensions/shortcuts');
    assert.ok(await options.evaluate(`document.querySelectorAll('#guide dl.keys dt').length >= 5`));
    console.log('PASS the guide shows the current shortcut, puts it in the tooltip and opens the shortcut page');
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
    for (const [hash,id] of [['folder','pick_folder'],['guide','shortcut_change'],['appearance','lr_theme'],['custom-css','css_readability'],['destinations','notion_refresh']]) {
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

    // Own credentials saved next to a built-in connection: said out loud, one click back.
    // Page.reload returns before the new document exists, so every wait after a
    // reload also requires a marker that only the old document carries to be gone.
    const reload = async (ready) => {
      await options.evaluate(`window.__oldDocument = true`);
      await options.call('Page.reload');
      await options.waitFor(`!window.__oldDocument && document.readyState === 'complete' && (${ready})`);
    };
    const text = id => options.evaluate(`document.getElementById('${id}').textContent`);
    const prop = (id, name) => options.evaluate(`document.getElementById('${id}').${name}`);
    await options.call('Page.bringToFront');
    await options.call('Emulation.setDeviceMetricsOverride',{width:900,height:900,deviceScaleFactor:1,mobile:false});
    await options.evaluate(`localStorage.setItem('fixtureOwn', JSON.stringify({clientId:'aaaaaaaa-0000-4000-8000-000000000002',clientSecret:'old-secret'}))`);
    await reload(`document.getElementById('notion_source').textContent !== ''`);
    assert.equal(await prop('notion_source','className'),'warn');
    assert.match(await text('notion_source'),/instead of its built-in connection/);
    assert.equal(await prop('notion_source_actions','hidden'),false);
    assert.equal(await prop('notion_app','open'),true);
    assert.equal(await prop('notion_client_id','value'),'aaaaaaaa-0000-4000-8000-000000000002');
    assert.equal(await prop('notion_builtin_hint','hidden'),false);
    await options.evaluate(`LRUITheme.apply('dark'); window.scrollTo(0,0)`);
    fs.writeFileSync(path.join(out,'options-conflict-dark.png'),Buffer.from((await options.call('Page.captureScreenshot',{format:'png'})).data,'base64'));
    await options.evaluate(`document.getElementById('notion_use_builtin').click()`);
    await options.waitFor(`document.getElementById('notion_source').textContent === ''`);
    assert.deepEqual(await options.evaluate('window.fixtureSaved'),{clientId:'',clientSecret:''});
    assert.equal(await prop('notion_source_actions','hidden'),true);
    assert.equal(await prop('notion_client_id','value'),'');
    assert.equal(await options.evaluate(`document.activeElement.id`),'notion_connect');
    assert.equal(await text('notion_connect'),'Connected to Test workspace');
    console.log('PASS saved own credentials are announced and one click returns to the built-in connection');

    await options.evaluate(`localStorage.setItem('fixtureOwn', JSON.stringify({clientId:'aaaaaaaa-0000-4000-8000-000000000002',clientSecret:''}))`);
    await reload(`document.getElementById('notion_source').textContent !== ''`);
    assert.match(await text('notion_source'),/a client ID without its secret/);
    assert.equal(await prop('notion_connect','disabled'),true);
    assert.equal(await text('notion_state'),'', 'no advice to press a button that is disabled');
    assert.equal(await prop('notion_connect','title'),'');
    console.log('PASS half an own app is reported and never combined with the built-in exchange');

    // The client id an earlier version copied from the built-in app is not an own app,
    // whatever secret was stored next to it.
    await options.evaluate(`localStorage.setItem('fixtureOwn', JSON.stringify({clientId:'11111111-1111-1111-1111-111111111111',clientSecret:'stale-secret'}))`);
    await reload(`document.getElementById('notion_connect').textContent === 'Connected to Test workspace'`);
    assert.equal(await text('notion_source'),'');
    assert.equal(await prop('notion_client_id','value'),'');
    assert.equal(await prop('notion_client_secret','value'),'');
    assert.equal(await prop('notion_connect','disabled'),false);
    assert.match(await text('notion_state'),/sign in again with the button above/);
    console.log('PASS a stored copy of the built-in app is ignored');

    // Signed in with an own app, which is gone from the settings since: still said.
    await options.evaluate(`localStorage.setItem('fixtureOwn', JSON.stringify({connectedWith:'own'}))`);
    await reload(`document.getElementById('notion_source').textContent !== ''`);
    assert.match(await text('notion_source'),/still connected through your own Notion app/);
    assert.equal(await prop('notion_source_actions','hidden'),true);
    console.log('PASS a connection made with a removed own app is pointed out');

    // Typing describes what Connect would do, under the fields, without claiming anything is saved.
    await options.evaluate(`localStorage.removeItem('fixtureOwn')`);
    await reload(`document.getElementById('notion_connect').textContent === 'Connected to Test workspace' && document.getElementById('notion_source').textContent === ''`);
    // Position on the page, not in the window: scrolling is not what is being tested.
    const fieldTop = () => options.evaluate(`document.getElementById('notion_client_secret').getBoundingClientRect().top + window.scrollY`);
    await options.evaluate(`document.getElementById('notion_app').open = true; document.getElementById('notion_client_id').scrollIntoView({block: 'center'})`);
    const before = await fieldTop();
    await options.evaluate(`document.getElementById('notion_client_id').value = 'aaaaaaaa-0000-4000-8000-000000000002';
      document.getElementById('notion_client_id').dispatchEvent(new Event('input'));`);
    assert.match(await text('notion_typed'),/Enter the client secret as well, or clear the client ID to keep the built-in connection/);
    assert.doesNotMatch(await text('notion_typed'),/saved/);
    assert.equal(await text('notion_source'),'');
    assert.ok(Math.abs(await fieldTop() - before) < 0.5,'typing must not move the fields');
    assert.equal(await prop('notion_connect','disabled'),true);
    await options.evaluate(`document.getElementById('notion_client_secret').value = 'typed-secret';
      document.getElementById('notion_client_secret').dispatchEvent(new Event('input'));`);
    assert.equal(await prop('notion_connect','disabled'),false);
    assert.equal(await prop('notion_typed','className'),'warn');
    assert.match(await text('notion_typed'),/instead of its built-in connection/);
    await options.evaluate(`for (const id of ['notion_client_id','notion_client_secret']) {
      document.getElementById(id).value = ''; document.getElementById(id).dispatchEvent(new Event('input')); }`);
    assert.equal(await text('notion_typed'),'');
    assert.equal(await prop('notion_connect','disabled'),false);
    console.log('PASS typing an own app explains the effect live, below the fields, and clearing it returns to the built-in connection');

    // Without a shortcut the guide says so and offers to set one; the tooltip stays plain.
    await options.evaluate(`localStorage.setItem('fixtureCommands', JSON.stringify([{name:'open-reader', shortcut:''}]))`);
    await reload(`document.getElementById('shortcut_change').textContent === 'Set a shortcut…'`);
    assert.equal(await options.evaluate(`document.getElementById('guide_press').hidden`),true);
    assert.match(await options.evaluate(`document.getElementById('shortcut_state').textContent`),/No shortcut is set/);
    assert.equal(await options.evaluate('window.fixtureTitle'),'Make this page readable');
    await options.evaluate(`localStorage.removeItem('fixtureCommands')`);
    console.log('PASS without a shortcut the guide offers to set one and the tooltip stays plain');

    await options.evaluate(`localStorage.setItem('fixtureApp','missing'); location.hash = 'notion'`);
    await reload(`document.activeElement.id === 'notion_client_id'`);
    assert.equal(await options.evaluate(`document.getElementById('notion_app').open`),true);
    assert.equal(await options.evaluate(`document.getElementById('notion_connect').disabled`),true);
    assert.equal(await options.evaluate(`document.getElementById('notion_connect').textContent`),'Connect to Notion');
    assert.match(await options.evaluate(`document.getElementById('notion_source').textContent`),/Add your own Notion app below/);
    assert.equal(await options.evaluate(`document.getElementById('notion_builtin_hint').hidden`),true,
      'no promise of a built-in connection in a build without one');
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
