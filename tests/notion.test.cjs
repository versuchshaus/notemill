// Destinations: Notion's search is paged, and only databases are offered by default.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function load(searchPages) {
  const calls = [];
  let stored = {};
  const context = {
    chrome: {storage: {local: {
      get: (key, cb) => cb({[key]: stored}),
      set: (obj, cb) => { stored = obj.notion; cb(); }
    }}},
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      const pages = searchPages[body.filter.value];
      const index = body.start_cursor ? Number(body.start_cursor) : 0;
      const page = pages[index];
      const next = index + 1 < pages.length ? String(index + 1) : null;
      return {ok: true, status: 200,
              text: async () => JSON.stringify({results: page, has_more: !!next, next_cursor: next})};
    },
    module: {exports: {}}
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../notion.js'), 'utf8'), context);
  return {notion: context.module.exports, calls, stored: () => stored};
}

const db = (id, title) => ({object: 'database', id, title: [{plain_text: title}], parent: {type: 'workspace'}});
const page = (id, title) => ({object: 'page', id, parent: {type: 'workspace'},
  properties: {title: {type: 'title', title: [{plain_text: title}]}}});

test('listTargets follows next_cursor until Notion says there is no more', async () => {
  const {notion, calls} = load({
    database: [[db('a', 'Reading list')], [db('b', 'Research notes')], [db('c', 'Recipes')]],
    page: [[page('p', 'Inbox')]]
  });
  const targets = await notion.listTargets('token', 'bot');
  assert.deepEqual(Array.from(targets.filter(t => t.type === 'database'), t => t.id), ['a', 'b', 'c']);
  const dbCalls = calls.filter(c => c.filter.value === 'database');
  assert.deepEqual(dbCalls.map(c => c.start_cursor), [undefined, '1', '2']);
});

test('listTargets stops after ten pages per kind', async () => {
  const many = Array.from({length: 15}, (_, i) => [db('d' + i, 'DB ' + i)]);
  const {notion, calls} = load({database: many, page: [[]]});
  const targets = await notion.listTargets('token', 'bot');
  assert.equal(targets.length, 10);
  assert.equal(calls.filter(c => c.filter.value === 'database').length, 10);
});

test('offered shows databases only unless pages are switched on', () => {
  const {notion} = load({database: [[]], page: [[]]});
  const list = [{id: 'a', type: 'database'}, {id: 'p', type: 'page'}, {id: 'b', type: 'database'}];
  assert.deepEqual(notion.offered(list, [], false).map(t => t.id), ['a', 'b']);
  assert.deepEqual(notion.offered(list, [], true).map(t => t.id), ['a', 'p', 'b']);
  // A ticked page stays hidden while pages are off; the ticked database remains.
  assert.deepEqual(notion.offered(list, ['p', 'b'], false).map(t => t.id), ['b']);
  // Only pages ticked, pages off: fall back to every database rather than nothing.
  assert.deepEqual(notion.offered(list, ['p'], false).map(t => t.id), ['a', 'b']);
});
