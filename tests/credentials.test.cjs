// Notion credentials: an own app or the built-in connection, never a mix.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const BUILTIN_ID = '3f2d872b-0000-4000-8000-000000000001';
const OWN_ID = 'aaaaaaaa-0000-4000-8000-000000000002';
const REDIRECT = 'https://test.chromiumapp.org/notion';

// app: what notion-config.js ships (LR_NOTION_APP), or null for none.
// tokenReply: how the token endpoint or the exchange answers.
function load(app, tokenReply, stored) {
  const calls = [];
  let saved = Object.assign({}, stored || {});
  const context = {
    URL, btoa, crypto: globalThis.crypto,
    chrome: {
      storage: {local: {
        get: (key, cb) => cb({[key]: saved}),
        set: (obj, cb) => { saved = obj.notion; cb(); }
      }},
      identity: {
        getRedirectURL: () => REDIRECT,
        launchWebAuthFlow: ({url}, cb) => {
          const state = new URL(url).searchParams.get('state');
          calls.push({authorize: url});
          cb(REDIRECT + '?code=consent-code&state=' + state);
        }
      },
      runtime: {}
    },
    fetch: async (url, init) => {
      calls.push({url, init});
      const reply = tokenReply || {status: 200, body: {access_token: 'token', workspace_name: 'Test space',
                                                      workspace_id: 'ws', bot_id: 'bot'}};
      return {ok: reply.status < 400, status: reply.status, text: async () => JSON.stringify(reply.body)};
    },
    module: {exports: {}}
  };
  if (app) context.LR_NOTION_APP = app;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../notion.js'), 'utf8'), context);
  return {notion: context.module.exports, calls, saved: () => saved};
}

const viaExchange = {clientId: BUILTIN_ID, clientSecret: '', exchangeUrl: 'https://exchange.invalid'};

test('nothing typed: the built-in connection, through its exchange', () => {
  const c = load(viaExchange).notion.credentials({});
  assert.equal(c.source, 'builtin');
  assert.equal(c.clientId, BUILTIN_ID);
  assert.equal(c.exchangeUrl, 'https://exchange.invalid');
  assert.equal(c.viaExchange, true);
  assert.equal(c.ready, true);
  assert.equal(c.conflict, false);
  assert.equal(c.problem, '');
});

test('an own app replaces the built-in one completely, and the conflict is reported', () => {
  const c = load(viaExchange).notion.credentials({clientId: OWN_ID, clientSecret: 'own-secret'});
  assert.equal(c.source, 'own');
  assert.equal(c.clientId, OWN_ID);
  assert.equal(c.clientSecret, 'own-secret');
  assert.equal(c.exchangeUrl, '', 'an own app never borrows the built-in exchange');
  assert.equal(c.viaExchange, false);
  assert.equal(c.ready, true);
  assert.equal(c.conflict, true);
});

test('half an own app is not filled up from the built-in one', () => {
  const {notion} = load(viaExchange);
  const idOnly = notion.credentials({clientId: OWN_ID});
  assert.equal(idOnly.source, 'own');
  assert.equal(idOnly.ready, false, 'a typed client id must not be sent to the built-in exchange');
  assert.equal(idOnly.exchangeUrl, '');
  assert.equal(idOnly.problem, 'own-incomplete');
  assert.equal(idOnly.conflict, true);

  const secretOnly = notion.credentials({clientSecret: 'own-secret'});
  assert.equal(secretOnly.source, 'own');
  assert.equal(secretOnly.ready, false, 'a typed secret must not be paired with the built-in client id');
  assert.equal(secretOnly.clientId, '');
  assert.equal(secretOnly.problem, 'own-incomplete');
});

test('the built-in client id an earlier version stored is not an own app', () => {
  const {notion} = load(viaExchange);
  const c = notion.credentials({clientId: BUILTIN_ID, clientSecret: ''});
  assert.equal(c.source, 'builtin');
  assert.equal(c.ownClientId, '');
  assert.equal(c.conflict, false);

  // A build whose notion-config.js holds a secret stored that secret too.
  const withSecret = load({clientId: BUILTIN_ID, clientSecret: 'shipped', exchangeUrl: ''}).notion;
  const copy = withSecret.credentials({clientId: BUILTIN_ID, clientSecret: 'shipped'});
  assert.equal(copy.source, 'builtin');
  assert.equal(copy.conflict, false);
  assert.equal(copy.ownClientSecret, '');
});

test('the built-in client id with an old or rotated secret is still the built-in app', () => {
  // A build that once shipped the secret stored it; the build now uses the exchange.
  const c = load(viaExchange).notion.credentials({clientId: BUILTIN_ID, clientSecret: 'stale-secret'});
  assert.equal(c.source, 'builtin');
  assert.equal(c.viaExchange, true, 'the exchange is used, not the stale secret');
  assert.equal(c.clientSecret, '');
  assert.equal(c.conflict, false);
  assert.equal(c.ownClientId, '');
  assert.equal(c.ownClientSecret, '');
});

test('an old client id from another app, without a secret, is reported, not used', () => {
  const c = load(viaExchange).notion.credentials({clientId: OWN_ID, clientSecret: ''});
  assert.equal(c.source, 'own');
  assert.equal(c.ready, false);
  assert.equal(c.conflict, true);
});

test('without a built-in app an own app is simply used', () => {
  const {notion} = load(null);
  const c = notion.credentials({clientId: OWN_ID, clientSecret: 'own-secret'});
  assert.equal(c.source, 'own');
  assert.equal(c.ready, true);
  assert.equal(c.conflict, false);
  assert.equal(notion.credentials({}).problem, 'none');
  assert.equal(notion.credentials({}).ready, false);
});

test('a notion-config.js with a secret and an exchange uses the secret and says so', () => {
  const c = load({clientId: BUILTIN_ID, clientSecret: 'shipped', exchangeUrl: 'https://exchange.invalid'})
    .notion.credentials({});
  assert.equal(c.source, 'builtin');
  assert.equal(c.clientSecret, 'shipped');
  assert.equal(c.exchangeUrl, '');
  assert.equal(c.viaExchange, false);
  assert.equal(c.problem, 'config-both');
});

test('a notion-config.js with only a client id cannot sign in', () => {
  const c = load({clientId: BUILTIN_ID}).notion.credentials({});
  assert.equal(c.source, 'none');
  assert.equal(c.ready, false);
  assert.equal(c.problem, 'config-incomplete');
});

test('connecting through the built-in app stores the token, not the app', async () => {
  const {notion, calls, saved} = load(viaExchange);
  const result = await notion.connect(notion.credentials({}));
  assert.equal(result.accessToken, 'token');
  assert.equal(result.workspaceName, 'Test space');
  assert.equal(result.connectedWith, 'builtin');
  assert.equal(saved().clientId, undefined, 'the built-in client id must not land in the own-app field');
  assert.equal(saved().clientSecret, undefined);
  const exchange = calls.find(c => c.url === 'https://exchange.invalid');
  assert.ok(exchange, 'the code goes to the exchange');
  assert.equal(exchange.init.credentials, 'omit');
  assert.ok(calls[0].authorize.includes('client_id=' + BUILTIN_ID));
});

test('an own app signs in directly, with its own id, and never through the exchange', async () => {
  const {notion, calls} = load(viaExchange);
  await notion.connect(notion.credentials({clientId: OWN_ID, clientSecret: 'own-secret'}));
  assert.ok(calls[0].authorize.includes('client_id=' + OWN_ID));
  assert.equal(calls.some(c => c.url === 'https://exchange.invalid'), false);
  const token = calls.find(c => c.url === 'https://api.notion.com/v1/oauth/token');
  assert.equal(token.init.headers.Authorization, 'Basic ' + btoa(OWN_ID + ':own-secret'));
  assert.equal(token.init.credentials, 'omit', 'no browser password prompt on a refusal');
});

test('a refused own app says which credentials to check', async () => {
  const {notion} = load(viaExchange, {status: 401, body: {error: 'invalid_client'}});
  await assert.rejects(notion.connect(notion.credentials({clientId: OWN_ID, clientSecret: 'old'})), err => {
    assert.equal(err.code, 'invalid_client');
    assert.match(err.message, /your own Notion app/);
    assert.match(err.message, /built-in connection/);
    return true;
  });
});

test('a refused built-in connection is not blamed on the settings', async () => {
  const {notion} = load(viaExchange, {status: 401, body: {error: 'invalid_client'}});
  await assert.rejects(notion.connect(notion.credentials({})), err => {
    assert.match(err.message, /built-in connection/);
    assert.match(err.message, /not something you can fix in the settings/);
    return true;
  });
});

test('every Notion API request omits browser credentials', async () => {
  const {notion, calls} = load(viaExchange, {status: 200, body: {results: [], has_more: false}});
  await notion.listTargets('token', 'bot');
  const api = calls.filter(c => c.url && c.url.startsWith('https://api.notion.com/'));
  assert.ok(api.length > 0);
  for (const c of api) assert.equal(c.init.credentials, 'omit');
});
