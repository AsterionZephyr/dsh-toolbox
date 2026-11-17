'use strict'
const path = require('node:path')
const { createHarness } = require('./stub.cjs')

function median(values) {
  const sorted = values.slice().sort(function (a, b) { return a - b })
  return sorted[Math.floor(sorted.length / 2)]
}

function fresh(withCore) {
  const harness = createHarness({ clientPath: currentFile, withCore: withCore, storage: new Map() })
  harness.addPages(harness.defaultPages)
  harness.flush()
  return harness
}

function measureFilter(withCore, rounds, batch) {
  const harness = fresh(withCore)
  const ns = []
  const raw = []
  const labels = []
  for (let round = 0; round < rounds; round += 1) {
    harness.slots.rawEntriesCalls = 0
    harness.labelCalls.count = 0
    const start = process.hrtime.bigint()
    for (let index = 0; index < batch; index += 1) harness.slots.entries('settings.section')
    const end = process.hrtime.bigint()
    ns.push(Number(end - start) / batch)
    raw.push(harness.slots.rawEntriesCalls / batch)
    labels.push(harness.labelCalls.count / batch)
  }
  harness.disposePlugin()
  harness.restoreGlobals()
  return {
    nsPerCall: Number(median(ns).toFixed(2)),
    rawEntriesPerCall: Number(median(raw).toFixed(2)),
    labelCallsPerCall: Number(median(labels).toFixed(3)),
  }
}

function measureRender(withCore, rounds, batch) {
  const harness = fresh(withCore)
  const us = []
  const raw = []
  const labels = []
  harness.setEffectsEnabled(false)
  for (let round = 0; round < rounds; round += 1) {
    harness.slots.rawEntriesCalls = 0
    harness.labelCalls.count = 0
    const start = process.hrtime.bigint()
    for (let index = 0; index < batch; index += 1) harness.renderToolbox()
    const end = process.hrtime.bigint()
    us.push(Number(end - start) / batch / 1000)
    raw.push(harness.slots.rawEntriesCalls / batch)
    labels.push(harness.labelCalls.count / batch)
  }
  harness.disposePlugin()
  harness.restoreGlobals()
  return {
    usPerRender: Number(median(us).toFixed(2)),
    rawEntriesPerRender: Number(median(raw).toFixed(2)),
    labelCallsPerRender: Number(median(labels).toFixed(3)),
  }
}

function measureToggle(withCore, rounds) {
  const samples = []
  for (let round = 0; round < rounds; round += 1) {
    const harness = fresh(withCore)
    const versionBefore = harness.slots.getVersion('settings.section')
    const registerBefore = harness.slots.registerCount
    const disposeBefore = harness.slots.disposeCount
    harness.toggleFor('theme-palette').props.onClick()
    samples.push({
      versionDelta: harness.slots.getVersion('settings.section') - versionBefore,
      registerDelta: harness.slots.registerCount - registerBefore,
      disposeDelta: harness.slots.disposeCount - disposeBefore,
      visibleAfter: harness.filtered().some(function (entry) { return entry.options.id === 'theme-palette' }),
    })
    harness.disposePlugin()
    harness.restoreGlobals()
  }
  return {
    versionDelta: median(samples.map(function (item) { return item.versionDelta })),
    registerDelta: median(samples.map(function (item) { return item.registerDelta })),
    disposeDelta: median(samples.map(function (item) { return item.disposeDelta })),
    visibleAfter: samples.every(function (item) { return item.visibleAfter }),
  }
}

let currentFile = ''
const files = process.argv.slice(2)
if (!files.length) {
  console.error('usage: node bench/bench.cjs <client.js> [client2.js ...]')
  process.exit(2)
}

const output = []
for (const file of files) {
  currentFile = path.resolve(file)
  for (const withCore of [true, false]) {
    output.push({
      file: path.basename(file),
      withCore: withCore,
      filter: measureFilter(withCore, 5, 5000),
      render: measureRender(withCore, 5, 300),
      toggle: measureToggle(withCore, 5),
    })
  }
}
console.log(JSON.stringify(output, null, 2))
