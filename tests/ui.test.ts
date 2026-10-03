import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { PAGE } from '../apps/runtime/ui.js';

// A page whose script does not parse still renders: the skeleton and the buttons appear, but no
// handler is ever attached and no data ever loads, which looks exactly like a frozen program.
// One escaping mistake in the generated JavaScript did that, so the page is parsed here.
test('设置界面的脚本能通过解析，且关键元素齐全', () => {
  const script = /<script>([\s\S]*?)<\/script>/.exec(PAGE)?.[1];
  assert.ok(script, '页面里没有脚本块');
  assert.doesNotThrow(() => new Function(script), '页面脚本无法解析');
  for (const id of ['host', 'self', 'devices', 'bridge', 'add', 'repair', 'refresh',
    'permissions', 'requestaccess', 'requestinput', 'checkpermissions', 'openaccess', 'openinput']) {
    assert.ok(PAGE.includes('id="' + id + '"'), '页面缺少元素 #' + id);
  }
  // The handlers must be attached at the very end: anything that throws earlier leaves the page
  // rendered but dead.
  assert.match(script.trimEnd(), /setInterval\(load,\d+\);$/, '脚本末尾没有启动轮询');
  for (const position of ['left', 'right', 'top', 'bottom']) {
    assert.ok(PAGE.includes('data-pos="' + position + '"'), '屏幕布局缺少 ' + position);
  }
});

test('设置页面 fetch 包装保留浏览器实现，并为读写请求携带会话', async () => {
  const script = /<script>([\s\S]*?)<\/script>/.exec(PAGE)![1];
  const calls: Array<{url:string; options:{headers:Record<string,string>;body?:string}}> = [];
  const context: Record<string,unknown> = {location:{hash:'#'+'a'.repeat(64)},fetch:async (url:string, options: {headers:Record<string,string>;body?:string}) => {calls.push({url,options}); return {ok:true};}};
  context.window = context;
  runInNewContext(script.slice(0,script.indexOf('var q=')),context);
  await (context.fetch as Function)('/api/layout',{method:'POST'});
  await (context.fetch as Function)('/api/status');
  assert.equal(calls.length,2);
  assert.equal(calls[0].options.headers['x-agentlink-session'],'a'.repeat(64));
  assert.equal(calls[0].options.headers['content-type'],'application/json');
  assert.equal(calls[0].options.body,'{}');
});
