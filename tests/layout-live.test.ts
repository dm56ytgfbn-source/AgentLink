import assert from 'node:assert/strict';
import test from 'node:test';
import { InputSharingEngine } from '../packages/input-share/engine.js';
import { layoutFor } from '../packages/input-share/layout.js';

// Idle layout updates are immediate; in-flight control must first return to local.
const screens = {
  windows: [{ id: 'W', x: 0, y: 0, width: 1920, height: 1080 }],
  mac: [{ id: 'M', x: 0, y: 0, width: 1512, height: 982 }],
};

function engineAt(now: () => number) {
  const sent: unknown[] = [];
  const engine = new InputSharingEngine(screens, layoutFor(screens, 'right'), (_side, command) => sent.push(command), now);
  engine.start();
  return { engine, sent };
}

test('换屏幕位置不打断共享：不暂停、不进入冷却', () => {
  let now = 1000;
  const { engine } = engineAt(() => now);
  engine.setLayout(layoutFor(screens, 'left'));
  assert.equal(engine.rearm_at, 0, '换位置不应该让共享停下来');
  assert.equal(engine.layout.links[0].from.edge, 'left', '几何应该立刻换成新的');
  now += 10;
  engine.tick();
  assert.equal(engine.rearm_at, 0, '换完之后仍然不该有待恢复的暂停');
});

test('换位置之后立刻就能按新边跨屏', () => {
  let now = 5000;
  const { engine } = engineAt(() => now);
  engine.setLayout(layoutFor(screens, 'left'));
  // The pointer travels to the left edge of the Windows screen and leaves it.
  now += 400;
  engine.input('windows', engine.epoch, { kind: 'move', x: 0, y: 500, dx: -1, dy: 0, held: 0 });
  assert.equal(engine.layout.links[0].from.edge, 'left');
});

test('重复设置同一份布局什么都不做', () => {
  let now = 1000;
  const { engine } = engineAt(() => now);
  engine.setLayout(layoutFor(screens, 'left'));
  const before = engine.layout;
  engine.setLayout(layoutFor(screens, 'left'));
  assert.equal(engine.layout, before, '同一份布局不应被重新应用');
});

test('换成对方没有的显示器会被拒绝，且不改变现有几何', () => {
  let now = 1000;
  const { engine } = engineAt(() => now);
  const broken = { links: [{ from: { device: 'windows' as const, display: 'NOPE', edge: 'left' as const },
    to: { device: 'mac' as const, display: 'M', edge: 'right' as const } }], speed: 1, cooldown_ms: 350 };
  assert.throws(() => engine.setLayout(broken), /Display missing/);
  assert.equal(engine.layout.links[0].from.edge, 'right', '被拒绝之后应该保持原来的几何');
  assert.equal(engine.rearm_at, 0, '被拒绝之后不该留下暂停');
});

for (const phase of ['target', 'source', 'active'] as const) {
  test('布局变化取消切换并恢复两端本地控制：' + phase, () => {
    let now = 1000;
    const sent: Array<{side: string; command: import('../packages/input-share/protocol.js').Command}> = [];
    const engine = new InputSharingEngine(screens, layoutFor(screens, 'right'), (side, command) => sent.push({side, command}), () => now);
    engine.start(); now += 1000;
    engine.input('windows', engine.epoch, {kind:'move', x:1919, y:500, dx:4, dy:0, held:0});
    const staleEpoch = engine.epoch;
    if (phase !== 'target') engine.ack('mac', staleEpoch);
    if (phase === 'active') engine.ack('windows', staleEpoch);
    engine.setLayout(layoutFor(screens, 'left'));
    assert.ok(engine.epoch > staleEpoch);
    assert.deepEqual(sent.slice(-2).map(v => [v.side, v.command.t === 'mode' && v.command.mode]), [['windows','local'],['mac','local']]);
    engine.ack('mac', staleEpoch); engine.ack('windows', staleEpoch);
    assert.equal(engine.source, null);
    now += 1000;
    engine.input('windows', engine.epoch, {kind:'move', x:0, y:500, dx:-4, dy:0, held:0});
    engine.ack('mac', engine.epoch); engine.ack('windows', engine.epoch);
    assert.equal(engine.target, 'mac');
    engine.input('windows', engine.epoch, {kind:'move', x:0, y:500, dx:-2, dy:0, held:0});
    assert.equal(sent.at(-1)?.command.t, 'input', 'new layout must still forward input');
  });
}
