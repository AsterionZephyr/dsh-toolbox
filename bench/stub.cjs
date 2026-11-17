'use strict'
const fs = require('node:fs')

const EMPTY = Object.freeze([])

function createReact(effectsEnabled) {
  const effects = []
  const state = { enabled: effectsEnabled !== false }
  function createElement(type, props) {
    const p = Object.assign({}, props || {})
    const children = Array.prototype.slice.call(arguments, 2)
    if (children.length === 1) p.children = children[0]
    else if (children.length > 1) p.children = children
    return { type: type, props: p, children: children }
  }
  class Component {
    constructor(props) {
      this.props = props || {}
      this.state = {}
    }
    setState(partial) {
      const next = typeof partial === 'function' ? partial(this.state, this.props) : partial
      this.state = Object.assign({}, this.state, next)
    }
  }
  Component.prototype.isReactComponent = {}
  const React = {
    Component: Component,
    createElement: createElement,
    useState: function (init) { return [typeof init === 'function' ? init() : init, function () {}] },
    useEffect: function (fn) {
      // 测试桩：渲染时立即执行 effect，返回的清理函数挂在 effects 上，由调用方手动卸载。
      if (!state.enabled) return
      const cleanup = fn()
      if (typeof cleanup === 'function') effects.push(cleanup)
    },
    useSyncExternalStore: function (subscribe, getSnapshot) { return getSnapshot() },
    useLayoutEffect: function (fn) {
      if (!state.enabled) return
      const cleanup = fn()
      if (typeof cleanup === 'function') effects.push(cleanup)
    },
    useRef: function (init) { return { current: init } },
    useCallback: function (fn) { return fn },
    memo: function (component, compare) {
      const wrapped = function (props) { return component(props) }
      wrapped.__wrapped = component
      wrapped.__compare = compare
      return wrapped
    },
  }
  React.__effectsEnabled = state
  return { React: React, effects: effects }
}

function makeSlots(withCore) {
  return class FakeSlots {
    constructor() {
      this.records = new Map()
      this.registerCount = 0
      this.disposeCount = 0
      this.flushCount = 0
      this.flushScheduled = false
      this.rawEntriesCalls = 0
      this.abdicated = new WeakSet()
      this.entryErrorListeners = new Set()
      this.ensure('settings.section')
      if (withCore) {
        const self = this
        this._core = {
          records: this.records,
          markDirty: function (key, rec) { self.markDirty(key, rec) },
        }
      }
    }
    ensure(key) {
      let record = this.records.get(key)
      if (!record) {
        record = { entries: EMPTY, version: 0, listeners: new Set() }
        this.records.set(key, record)
      }
      return record
    }
    markDirty(key, record) {
      record.version += 1
      this.scheduleFlush()
    }
    scheduleFlush() {
      if (this.flushScheduled) return
      this.flushScheduled = true
      const self = this
      queueMicrotask(function () { self.flushNow() })
    }
    flushNow() {
      if (!this.flushScheduled) return
      this.flushScheduled = false
      this.flushCount += 1
      for (const record of this.records.values()) {
        for (const listener of Array.from(record.listeners)) listener()
      }
    }
    // 原实现：过滤器会包住 prototype.entries，这里也用于读原始账本。
    rawEntries(key) { return this.records.get(key) ? this.records.get(key).entries : EMPTY }
    entries(key) {
      this.rawEntriesCalls += 1
      return this.rawEntries(key)
    }
    entriesOfSlot(key) {
      const sorted = this.rawEntries(key).slice().sort(function (a, b) {
        return (a.options.priority || 0) - (b.options.priority || 0) ||
          (a.options.order || 0) - (b.options.order || 0)
      }).filter((entry) => !this.abdicated.has(entry))
      if (key === 'settings.launcher') return sorted.slice(0, 1)
      return sorted
    }
    getVersion(key) { const record = this.records.get(key); return record ? record.version : 0 }
    onEntryError(fn) {
      this.entryErrorListeners.add(fn)
      return () => this.entryErrorListeners.delete(fn)
    }
    reportEntryError(key, entry, error, info) {
      if (info && info.abdicate) this.abdicated.add(entry)
      for (const listener of Array.from(this.entryErrorListeners)) listener(key, entry, error, info || {})
    }
    subscribe(key, fn) {
      const record = this.ensure(key)
      record.listeners.add(fn)
      const self = this
      return function () { record.listeners.delete(fn) }
    }
    register(options, component) {
      this.registerCount += 1
      const record = this.ensure(options.name)
      const entry = {
        options: options,
        component: component,
        children: options.children,
        locale: options.locale,
        inject: options.inject,
        store: options.store,
      }
      record.entries = record.entries.concat([entry])
      if (options.name === 'settings.section') {
        record.entries = record.entries.slice().sort(function (a, b) {
          return (a.options.order || 0) - (b.options.order || 0)
        })
      }
      this.markDirty(options.name, record)
      const self = this
      let disposed = false
      return function () {
        if (disposed) return
        disposed = true
        self.disposeCount += 1
        record.entries = record.entries.filter(function (item) { return item !== entry })
        self.markDirty(options.name, record)
      }
    }
    inject(key, callback) {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : function () {}
    }
  }
}

function find(root, predicate, out) {
  out = out || []
  if (!root || typeof root !== 'object') return out
  if (Array.isArray(root)) {
    for (const item of root) find(item, predicate, out)
    return out
  }
  if (predicate(root)) out.push(root)
  if (root.children) find(root.children, predicate, out)
  return out
}

function textOf(element) {
  if (element === null || element === undefined) return ''
  if (typeof element === 'string' || typeof element === 'number') return String(element)
  if (Array.isArray(element)) return element.map(textOf).join(' ')
  if (element.props && element.props.children !== undefined) return textOf(element.props.children)
  return ''
}

function createHarness(options) {
  const clientPath = options.clientPath
  const withCore = options.withCore !== false
  const storage = options.storage || new Map()
  const react = createReact(options.effects !== false)
  const Slots = makeSlots(withCore)
  const slots = new Slots()

  const windowObject = {
    __ModuleLoader__: {
      load: function (definition) { global.__toolboxCaptured = definition },
    },
    localStorage: {
      getItem: function (key) { return storage.has(key) ? storage.get(key) : null },
      setItem: function (key, value) { storage.set(key, value) },
    },
  }
  const documentObject = {
    createElement: function () { return { setAttribute: function () {}, style: {}, parentNode: null } },
    head: { appendChild: function () {} },
  }
  const previousWindow = global.window
  const previousDocument = global.document
  const previousCaptured = global.__toolboxCaptured
  global.window = windowObject
  global.document = documentObject
  global.__toolboxCaptured = undefined

  const source = fs.readFileSync(clientPath, 'utf8')
  new Function('window', 'document', source)(windowObject, documentObject)
  const definition = global.__toolboxCaptured
  if (!definition || definition.id !== 'dsh-toolbox') {
    throw new Error('client bundle did not register dsh-toolbox: ' + (definition && definition.id))
  }
  const pluginExports = definition.factory(function (name) {
    if (name === 'react') return react.React
    throw new Error('unexpected require(' + JSON.stringify(name) + ')')
  })

  const labelCalls = { count: 0 }
  const disposers = []
  let localeRevisionNumber = 0
  const localeListeners = new Set()
  const locale = {
    getSnapshot: function () { return { revision: localeRevisionNumber } },
    subscribe: function (listener) {
      localeListeners.add(listener)
      return function () { localeListeners.delete(listener) }
    },
  }
  const ctx = {
    slots: slots,
    locale: options.noLocale ? undefined : locale,
    effect: function (fn) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return function () {}
    },
    inject: function () {},
  }

  pluginExports.apply(ctx)

  function addPage(id, order, labelKind, component) {
    const label = labelKind === 'string' ? id.toUpperCase() : function () {
      labelCalls.count += 1
      return id.toUpperCase()
    }
    slots.register({ name: 'settings.section', id: id, order: order, label: label }, component || function () { return null })
  }
  function addPages(pages) {
    for (const page of pages) addPage(page[0], page[1], page[2] || 'thunk')
  }

  const defaultPages = [
    ['account', -10], ['general', 0], ['models', 10], ['plugins', 15], ['theme-palette', 5],
    ['skills-manager', 25], ['notifications', 40], ['wechat', 40], ['market', 40],
    ['workspace-mover-rescue', 60], ['better-sidebar', 100], ['bili', 100], ['pet', 120],
  ]

  function toolboxEntry() {
    return slots.rawEntries('settings.section').find(function (entry) { return entry.options.id === 'toolbox' })
  }
  function renderToolbox() {
    const entry = toolboxEntry()
    if (!entry) throw new Error('toolbox section is not registered')
    let element = entry.component({
      api: {
        ctx: function () { return ctx },
        filterInstalled: function () { return true },
      },
      renderSlot: options.slotRender || function () { return null },
    })
    // ToolboxShell 用 class 错误边界包住 ToolboxSection；桩里手动剥掉这一层，
    // 拿到 ToolboxSection 的元素树，方便继续找卡片/按钮/展开的 SectionHost。
    if (element && element.type && element.type.prototype && element.type.prototype.isReactComponent) {
      const instance = new element.type(element.props)
      element = instance.render()
      if (element && typeof element.type === 'function' && !(element.type.prototype && element.type.prototype.isReactComponent)) {
        element = element.type(element.props)
      }
    }
    return element
  }
  function filtered() { return slots.entries('settings.section') }
  function cardFor(id) {
    const cards = find(renderToolbox(), function (element) {
      return element.props && typeof element.props.className === 'string' &&
        element.props.className.indexOf('dshtb-card') === 0
    })
    for (const card of cards) {
      if (find(card, function (element) {
        return element.props && element.props.className === 'dshtb-id' && textOf(element) === id
      }).length > 0) return card
    }
    return undefined
  }
  function buttonIn(card, classNamePrefix) {
    return find(card, function (element) {
      return element.props && typeof element.props.className === 'string' &&
        element.props.className.indexOf(classNamePrefix) === 0
    })[0]
  }
  function toggleFor(id) {
    const card = cardFor(id)
    if (!card) throw new Error('card not found: ' + id)
    const button = buttonIn(card, 'dshtb-toggle')
    if (!button) throw new Error('toggle not found: ' + id)
    return button
  }
  function headFor(id) {
    const card = cardFor(id)
    if (!card) throw new Error('card not found: ' + id)
    return buttonIn(card, 'dshtb-head')
  }
  function toolbarButton(label) {
    const tree = renderToolbox()
    const buttons = find(tree, function (element) {
      return element.props && element.props.className === 'dshtb-btn'
    })
    for (const button of buttons) if (textOf(button) === label) return button
    throw new Error('toolbar button not found: ' + label)
  }
  function renderHosted() {
    const tree = renderToolbox()
    const hosts = find(tree, function (element) {
      const type = element.type
      if (!type) return false
      if (type.__wrapped && type.__wrapped.name === 'SectionHost') return true
      return type.name === 'SectionHost'
    })
    if (!hosts.length) throw new Error('no expanded SectionHost')
    const element = hosts[0]
    const before = react.effects.length
    const output = element.type(element.props)
    return { element: element, output: output, cleanups: react.effects.slice(before) }
  }
  function runUnmount(cleanups) {
    for (let index = cleanups.length - 1; index >= 0; index -= 1) cleanups[index]()
  }
  function disposePlugin() {
    while (disposers.length) {
      const disposer = disposers.pop()
      try { disposer() } catch (_) {}
    }
  }
  function setLocaleRevision(value) {
    localeRevisionNumber = value
    for (const listener of Array.from(localeListeners)) listener()
  }

  function renderDeep(node) {
    if (node === null || node === undefined || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map(renderDeep)
    const type = node.type
    if (typeof type === 'function') {
      const isClass = type.prototype && type.prototype.isReactComponent
      if (isClass) {
        const instance = new type(node.props)
        try {
          return renderDeep(instance.render())
        } catch (error) {
          if (typeof type.getDerivedStateFromError === 'function') {
            instance.state = Object.assign({}, instance.state, type.getDerivedStateFromError(error))
          }
          if (typeof instance.componentDidCatch === 'function') instance.componentDidCatch(error)
          return renderDeep(instance.render())
        }
      }
      return renderDeep(type(node.props))
    }
    if (typeof type === 'string') {
      const props = Object.assign({}, node.props)
      if (props.children !== undefined) props.children = renderDeep(props.children)
      return { type: type, props: props, children: props.children }
    }
    return node
  }

  const harness = {
    clientPath: clientPath,
    slots: slots,
    ctx: ctx,
    storage: storage,
    labelCalls: labelCalls,
    effects: react.effects,
    addPage: addPage,
    addPages: addPages,
    defaultPages: defaultPages,
    filtered: filtered,
    raw: function (key) { return slots.rawEntries(key) },
    renderToolbox: renderToolbox,
    cardFor: cardFor,
    toggleFor: toggleFor,
    headFor: headFor,
    toolbarButton: toolbarButton,
    renderHosted: renderHosted,
    renderDeep: renderDeep,
    runUnmount: runUnmount,
    disposePlugin: disposePlugin,
    setLocaleRevision: setLocaleRevision,
    setEffectsEnabled: function (value) { react.React.__effectsEnabled.enabled = value !== false },
    flush: function () { slots.flushNow() },
    id: options.id || clientPath,
    restoreGlobals: function () {
      global.window = previousWindow
      global.document = previousDocument
      global.__toolboxCaptured = previousCaptured
    },
  }
  return harness
}

module.exports = {
  createHarness: createHarness,
  find: find,
  textOf: textOf,
}
