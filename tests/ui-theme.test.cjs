// Astra: shared theme preference semantics, without browser services.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function fixture() {
  let load, change, mediaChange, ready;
  const media = {matches:true, addEventListener(type, fn) {mediaChange = fn;}};
  const root = {style:{},setAttribute(key,value) {this[key] = value;}};
  const select = {value:''};
  const context = {window:{matchMedia:() => media}, document:{
    documentElement:root,getElementById:() => select,
    addEventListener(type,fn) {ready = fn;}
  },chrome:{storage:{sync:{get(defaults,cb) {load = cb;}},
    onChanged:{addListener(fn) {change = fn;}}}}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../ui-theme.js'),'utf8'),context);
  return {root,select,media,apply:context.LRUITheme.apply,
    load:value => load({lrTheme:value}), change, ready:() => ready(),
    system:dark => {media.matches = dark; mediaChange();}};
}
test('stored manual theme overrides the system and survives system changes',() => {
  const f = fixture();
  assert.equal(f.root['data-lr-theme'],'dark');
  f.load('light');
  assert.equal(f.root['data-lr-theme'],'light');
  assert.equal(f.root.style.colorScheme,'light');
  f.system(true);
  assert.equal(f.root['data-lr-theme'],'light');
  assert.equal(f.select.value,'light');
});
test('sync changes update the UI; deleting or invalidating preference restores auto',() => {
  const f = fixture();
  f.load('dark');
  f.change({lrTheme:{newValue:'light'}},'local');
  assert.equal(f.root['data-lr-theme'],'dark');
  f.change({lrTheme:{newValue:'light'}},'sync');
  assert.equal(f.root['data-lr-theme'],'light');
  f.change({lrTheme:{}},'sync');
  assert.equal(f.select.value,'auto');
  assert.equal(f.root['data-lr-theme'],'dark');
  f.system(false);
  assert.equal(f.root['data-lr-theme'],'light');
  f.apply('invalid'); f.ready();
  assert.equal(f.select.value,'auto');
});
