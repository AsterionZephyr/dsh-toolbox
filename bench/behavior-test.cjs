'use strict'
const assert = require('node:assert')
const path = require('node:path')
const { createHarness } = require('./stub.cjs')

const CLIENT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'lib', 'client.js'))

function idsOf(entries) {
  return entries.map(function (entry) { return entry.options.id }).sort()
}

function newHarness(options) {
  const harness = createHarness(Object.assign({ clientPath: CLIENT }, options || {}))
  harness.addPages(harness.defaultPages)
  harness.flush()
  return harness
}

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log('ok   ' + name)
  } catch (error) {
    console.error('FAIL ' + name)
    console.error(error && error.stack ? error.stack : error)
    process.exitCode = 1
    throw error
  }
}

test('工具箱 section 已注册，默认自动模式下核心页保留、第三方页收纳', function () {
  const harness = newHarness()
  const all = harness.raw('settings.section')
  assert.ok(all.some(function (entry) { return entry.options.id === 'toolbox' }), 'toolbox section registered')
  const visible = idsOf(harness.filtered())
  for (const id of ['account', 'general', 'models', 'plugins', 'toolbox']) {
    assert.ok(visible.indexOf(id) >= 0, id + ' should stay in sidebar')
  }
  for (const id of ['theme-palette', 'wechat', 'notifications', 'pet', 'bili']) {
    assert.ok(visible.indexOf(id) < 0, id + ' should be folded')
  }
  harness.disposePlugin()
  harness.restoreGlobals()
})

test('切换 已收纳/在侧栏 立即改侧栏并写 localStorage', function () {
  const harness = newHarness()
  harness.toggleFor('theme-palette').props.onClick()
  let visible = idsOf(harness.filtered())
  assert.ok(visible.indexOf('theme-palette') >= 0, 'unfolded page appears in sidebar')
  let prefs = JSON.parse(harness.storage.get('dsh-toolbox.prefs.v1'))
  assert.strictEqual(prefs.overrides['theme-palette'], false)
  harness.toggleFor('theme-palette').props.onClick()
  visible = idsOf(harness.filtered())
  assert.ok(visible.indexOf('theme-palette') < 0, 'folded page disappears from sidebar')
  prefs = JSON.parse(harness.storage.get('dsh-toolbox.prefs.v1'))
  assert.strictEqual(prefs.overrides['theme-palette'], true)
  harness.disposePlugin()
  harness.restoreGlobals()
})

test('展开把原组件注册进 toolbox.page，卸载后释放', function () {
  const harness = newHarness()
  harness.headFor('theme-palette').props.onClick()
  const hosted = harness.renderHosted()
  assert.ok(hosted.output, 'SectionHost rendered')
  const registered = harness.raw('toolbox.page')
  assert.strictEqual(registered.length, 1, 'one hosted page')
  assert.strictEqual(registered[0].options.id, 'theme-palette')
  harness.runUnmount(hosted.cleanups)
  assert.strictEqual(harness.raw('toolbox.page').length, 0, 'hosted page released on unmount')
  harness.disposePlugin()
  harness.restoreGlobals()
})

test('放回侧栏会清掉展开态，再次收纳不会自动展开', function () {
  const harness = newHarness()
  harness.headFor('theme-palette').props.onClick()
  const hosted = harness.renderHosted()
  harness.runUnmount(hosted.cleanups)
  harness.toggleFor('theme-palette').props.onClick()
  assert.ok(idsOf(harness.filtered()).indexOf('theme-palette') >= 0, 'page back in sidebar')
  harness.toggleFor('theme-palette').props.onClick()
  const tree = harness.renderToolbox()
  const bodies = require('./stub.cjs').find(tree, function (element) {
    return element.props && element.props.className === 'dshtb-body'
  })
  assert.strictEqual(bodies.length, 0, 're-folded page must not auto-expand')
  harness.disposePlugin()
  harness.restoreGlobals()
})

test('放回侧栏后再次收纳不会自动展开（含 全部收纳 路径）', function () {
  const harness = newHarness()
  harness.headFor('theme-palette').props.onClick()
  const hosted = harness.renderHosted()
  harness.runUnmount(hosted.cleanups)
  // 单页放回侧栏：展开态应被清掉
  harness.toggleFor('theme-palette').props.onClick()
  // 再通过「全部收纳」把它收回来；如果展开态残留，这里会自动展开
  harness.toolbarButton('全部收纳').props.onClick()
  const tree = harness.renderToolbox()
  const bodies = require('./stub.cjs').find(tree, function (element) {
    return element.props && element.props.className === 'dshtb-body'
  })
  assert.strictEqual(bodies.length, 0, 're-folded page must not auto-expand')
  harness.disposePlugin()
  harness.restoreGlobals()
})

test('全部收纳 / 全部放回', function () {
  const harness = newHarness()
  harness.toolbarButton('全部收纳').props.onClick()
  let visible = idsOf(harness.filtered())
  assert.deepStrictEqual(visible, ['toolbox'])
  harness.toolbarButton('全部放回').props.onClick()
  visible = idsOf(harness.filtered())
  assert.ok(visible.length >= harness.raw('settings.section').length, 'all sections visible after 全部放回')
  harness.disposePlugin()
  harness.restoreGlobals()
})

test('偏好跨实例持久化', function () {
  const storage = new Map()
  const first = newHarness({ storage: storage })
  first.toggleFor('wechat').props.onClick()
  first.disposePlugin()
  first.restoreGlobals()
  const second = newHarness({ storage: storage })
  assert.ok(idsOf(second.filtered()).indexOf('wechat') >= 0, 'override persisted across module reload')
  second.disposePlugin()
  second.restoreGlobals()
})

test('_core.markDirty 缺失时回退假条目，仍能推送版本', function () {
  const harness = newHarness({ withCore: false })
  const versionBefore = harness.slots.getVersion('settings.section')
  const registerBefore = harness.slots.registerCount
  harness.toggleFor('theme-palette').props.onClick()
  assert.strictEqual(harness.slots.getVersion('settings.section') - versionBefore, 2)
  assert.strictEqual(harness.slots.registerCount - registerBefore, 1)
  assert.ok(idsOf(harness.filtered()).indexOf('theme-palette') >= 0)
  harness.disposePlugin()
  harness.restoreGlobals()
})

test('插件卸载后过滤器撤销，侧栏恢复全部页', function () {
  const harness = newHarness()
  const before = harness.filtered().length
  harness.disposePlugin()
  const after = harness.filtered().length
  assert.ok(after >= before, 'all pages visible after teardown')
  assert.ok(!harness.raw('settings.section').some(function (entry) { return entry.options.id === 'toolbox' }), 'toolbox section removed')
  harness.restoreGlobals()
})

console.log('passed ' + passed + ' tests')
