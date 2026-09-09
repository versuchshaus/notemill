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

test('dismissed interactions cannot reopen the row or change focus', () => {
  const {reader, buttons, row} = fixture();
  const generation = reader.beginRow();
  reader.writeRow('save-markdown', ['Loading'], 0, false, generation);
  reader.closeRow(true);
  reader.writeRow('save-markdown', ['Late reply'], 100, true, generation);
  assert.equal(row.children.length, 0);
  assert.equal(reader.owner, null);
  assert.equal(reader.armed, buttons['save-markdown']);
});

test('same-button retry rejects old replies without clearing the newer timer', () => {
  const {reader, row, timers} = fixture();
  const old = reader.beginRow();
  reader.writeRow('send-notion', ['Loading'], 0, false, old);
  const current = reader.beginRow();
  reader.writeRow('send-notion', ['New result'], 100, true, current);
  const timer = row._timer;
  reader.writeRow('send-notion', ['Old result'], 200, true, old);
  assert.equal(row.children[0].text, 'New result');
  assert.equal(row._timer, timer);
  assert.equal(timers.size, 1);
});

test('even a queued old expiry cannot dismiss a newer interaction', () => {
  const {reader, timers, row} = fixture();
  const old = reader.beginRow();
  reader.writeRow('copy-markdown', ['Copied'], 100, true, old);
  const expire = [...timers.values()][0];
  const current = reader.beginRow();
  reader.writeRow('save-markdown', ['Choose'], 0, false, current);
  expire();
  assert.equal(reader.owner, 'save-markdown');
  assert.equal(row.children[0].text, 'Choose');
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
