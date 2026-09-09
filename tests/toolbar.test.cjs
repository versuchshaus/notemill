// Astra's dependency-free regression checks for the shared toolbar lifecycle.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function fixture() {
  const timers = new Map();
  let next = 0;
  const row = {children: [], contains(node) { return this.children.includes(node); },
    appendChild(node) { this.children.push(node); },
    set textContent(value) { this.children = []; }};
  const buttons = {'save-markdown': {}, 'send-notion': {}, 'copy-markdown': {}};
  const document = {activeElement: null,
    getElementById(id) { return id === 'readMarkdownStatus' ? row : buttons[id]; },
    createTextNode(text) { return {text}; }};
  const context = {document, console, module: {exports: {}}, window: {
    setTimeout(fn) { timers.set(++next, fn); return next; },
    clearTimeout(id) { timers.delete(id); }
  }};
  vm.runInNewContext(fs.readFileSync(require.resolve('../readability.js'), 'utf8'), context);
  const reader = context.module.exports;
  reader.openPanel = id => { reader.owner = id; };
  reader.arm = el => { reader.armed = el; };
  return {reader, row, buttons, document, timers};
}

test('replacing a result cancels its timer and transfers ownership', () => {
  const {reader, timers, row} = fixture();
  reader.writeRow('copy-markdown', ['Copied'], 100, true);
  assert.equal(timers.size, 1);
  reader.writeRow('save-markdown', ['Choose folder']);
  assert.equal(timers.size, 0);
  assert.equal(reader.owner, 'save-markdown');
  assert.equal(row.className, 'lr-row');
});

test('cancel restores the initiating button and clears timer and ownership', () => {
  const {reader, buttons, timers, row} = fixture();
  reader.writeRow('save-markdown', ['Saved'], 100, true);
  reader.closeRow(true);
  assert.equal(reader.armed, buttons['save-markdown']);
  assert.equal(reader.owner, null);
  assert.equal(row.children.length, 0);
  assert.equal(timers.size, 0);
});

test('replacing focused panel controls does not leave detached armed nodes', () => {
  const {reader, document, buttons} = fixture();
  const save = {};
  reader.writeRow('send-notion', [save]);
  document.activeElement = save;
  reader.armed = save;
  reader.writeRow('send-notion', ['Sending']);
  assert.equal(reader.armed, buttons['send-notion']);
});

test('expiry does not move focus when reading the article', () => {
  const {reader, timers} = fixture();
  const article = {};
  reader.armed = article;
  reader.writeRow('copy-markdown', ['Copied'], 100, true);
  [...timers.values()][0]();
  assert.equal(reader.armed, article);
  assert.equal(reader.owner, null);
});

test('legacy Space paging excludes editing, toolbar and handled events', () => {
  const {reader} = fixture();
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
    assert.equal(reader.isEditingKey({target: {tagName}}), true);
  }
  assert.equal(reader.isEditingKey({target: {isContentEditable: true}}), true);
  assert.equal(reader.isEditingKey({target: {closest: () => ({})}}), true);
  assert.equal(reader.isEditingKey({defaultPrevented: true}), true);
  assert.equal(reader.isEditingKey({target: {tagName: 'P'}}), false);
});
