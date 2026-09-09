// Minimal CDP helper for Astra's isolated-browser tests (Node 22+).
async function connect(base = process.env.CDP_URL || 'http://localhost:9563') {
  const target = await (await fetch(base + '/json/new?about:blank', {method: 'PUT'})).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, {once:true});
    ws.addEventListener('error', reject, {once:true});
  });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', e => {
    const msg = JSON.parse(e.data);
    if (!pending.has(msg.id)) return;
    const {resolve, reject, timer} = pending.get(msg.id);
    clearTimeout(timer); pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  });
  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {pending.delete(id); reject(new Error('CDP timeout: ' + method));}, 10000);
      pending.set(id, {resolve, reject, timer});
      ws.send(JSON.stringify({id,method,params}));
    });
  }
  async function evaluate(expression) {
    const result = await call('Runtime.evaluate', {expression,returnByValue:true,awaitPromise:true});
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function waitFor(expression) {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error('Condition not met: ' + expression);
  }
  async function key(key, code, virtual) {
    await call('Input.dispatchKeyEvent', {type:'keyDown',key,code,windowsVirtualKeyCode:virtual,
      text:key === 'Enter' ? '\r' : key === ' ' ? ' ' : undefined});
    await call('Input.dispatchKeyEvent', {type:'keyUp',key,code,windowsVirtualKeyCode:virtual});
  }
  async function close() {
    try { await call('Page.close'); } finally { ws.close(); }
  }
  await call('Page.enable');
  await call('Runtime.enable');
  return {call,evaluate,waitFor,key,close};
}
module.exports = {connect};
