/**
 * dsh-approval-alert —— 离线冒烟测试。
 *
 * 把 `lib/client.js` 当成真实的 `window.__ModuleLoader__` 工厂跑起来,用假的
 * window / document / AudioContext / Notification 验证真实行为:
 *
 *   1. 模块形状与两个槽位注册
 *   2. 审批出现、焦点不在 DSH → 提示音 + 系统通知 + 应用内浮层
 *   3. 同一请求不重复提醒;请求被回答后收起
 *   4. 重复提醒(间隔到点再响一次)
 *   5. 聚焦策略(聚焦默认不弹系统通知,可开启)
 *   6. 提问 / 计划评审同样提醒
 *   7. 任务完成的一跳提示(默认关闭)
 *   8. 设置归一化(越界值、未知音效、坏自定义音效)
 *   9. 通知权限缺失/被拒/不支持时安静降级
 *  10. 卸载后不再有任何定时器继续响
 *
 * 运行:`node test/smoke.mjs`(依赖 devDependencies 里的 react / react-dom)
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_FILE = path.resolve(here, '..', 'lib', 'client.js')
const clientSource = fs.readFileSync(CLIENT_FILE, 'utf8')

let failures = 0
let passes = 0

function ok(condition, message) {
  if (condition) {
    passes += 1
    console.log('  ok   ' + message)
  } else {
    failures += 1
    console.log('  FAIL ' + message)
  }
}

function eq(actual, expected, message) {
  ok(actual === expected, message + ' (expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual) + ')')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ============================================================================
// 假环境:够用的 window / document / Web Audio / Notification
// ============================================================================

function createEnv(options) {
  const records = {
    notifications: [],
    oscillationStarts: [],
    styleTags: [],
    focusRequests: 0,
    resumes: 0,
    permissionRequests: 0,
  }

  let focused = options.focused !== false
  let permission = options.permission === undefined ? 'granted' : options.permission
  let audioState = options.audioLocked ? 'suspended' : 'running'

  class FakeAudioContext {
    constructor() {
      this.state = audioState
      this.currentTime = 0
      this.destination = { connect() {} }
    }
    createGain() {
      return {
        gain: {
          value: 1,
          setValueAtTime() {},
          exponentialRampToValueAtTime() {},
          linearRampToValueAtTime() {},
        },
        connect() {},
      }
    }
    createOscillator() {
      const self = this
      return {
        type: 'sine',
        frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() {},
        start() {
          records.oscillationStarts.push(self.state)
        },
        stop() {},
      }
    }
    resume() {
      records.resumes += 1
      this.state = 'running'
      audioState = 'running'
      return Promise.resolve()
    }
  }

  class FakeAudio {
    constructor(src) {
      this.src = src
      this.volume = 1
      this.played = false
    }
    play() {
      this.played = true
      records.oscillationStarts.push('file')
      return Promise.resolve()
    }
  }

  class FakeNotification {
    constructor(title, opts) {
      this.title = title
      this.options = opts || {}
      this.closed = false
      records.notifications.push(this)
    }
    close() {
      this.closed = true
    }
    static requestPermission() {
      records.permissionRequests += 1
      permission = 'granted'
      FakeNotification.permission = 'granted'
      return Promise.resolve('granted')
    }
  }
  FakeNotification.permission = permission

  const storage = new Map()
  if (options.settings !== undefined) {
    storage.set('dsh-approval-alert:settings:v1', JSON.stringify(options.settings))
  }

  const document = {
    visibilityState: 'visible',
    head: { appendChild: (tag) => records.styleTags.push(tag) },
    body: { appendChild() {} },
    documentElement: { appendChild() {} },
    createElement(tag) {
      return { tagName: String(tag).toUpperCase(), dataset: {}, textContent: '', style: {}, appendChild() {} }
    },
    querySelector(selector) {
      if (selector.indexOf('style[data-plugin-css=') === 0) return records.styleTags.length > 0 ? records.styleTags[0] : null
      return null
    },
    addEventListener() {},
    removeEventListener() {},
    hasFocus() {
      return focused
    },
    activeElement: null,
  }

  const win = {
    document,
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => {
        if (options.storageFull) throw new Error('QuotaExceededError')
        storage.set(key, String(value))
      },
      removeItem: (key) => storage.delete(key),
    },
    AudioContext: FakeAudioContext,
    Audio: FakeAudio,
    Notification: FakeNotification,
    navigator: { language: 'zh-CN', languages: ['zh-CN'] },
    focus() {
      records.focusRequests += 1
      focused = true
    },
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 1280,
    innerHeight: 800,
    __ModuleLoader__: {
      load(entry) {
        records.entry = entry
      },
    },
  }

  return {
    records,
    window: win,
    storage,
    setFocused(value) {
      focused = value
    },
    setPermission(value) {
      permission = value
      FakeNotification.permission = value
    },
  }
}

// ============================================================================
// 把 bundle 跑起来
// ============================================================================

function loadPlugin(options = {}) {
  const env = createEnv(options)
  const globals = {
    window: env.window,
    document: env.window.document,
    navigator: env.window.navigator,
    localStorage: env.window.localStorage,
    AudioContext: env.window.AudioContext,
    Audio: env.window.Audio,
    Notification: env.window.Notification,
    FileReader: class {
      readAsDataURL() {}
    },
  }
  const saved = new Map()
  for (const [key, value] of Object.entries(globals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }

  // 执行 bundle:它只做一件事 —— 把工厂登记进 __ModuleLoader__
  new Function(clientSource)() // eslint-disable-line no-new-func

  const entry = env.records.entry
  if (!entry) throw new Error('bundle did not register a __ModuleLoader__ entry')
  const exported = entry.factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error('unexpected external requirement from the client bundle: ' + specifier)
  })

  // ---- 假 client Cordis 上下文 ----
  const statusListeners = new Set()
  let statusMap = new Map()
  const registrations = []
  const injectCalls = []
  const effects = []
  const remote = { handlers: [], $on(event, handler) { if (event === 'approval/request') this.handlers.push(handler); return () => {} } }

  const ctx = {
    effect(callback, label) {
      const dispose = callback()
      if (typeof dispose === 'function') effects.push({ label, dispose })
      return () => {}
    },
    // 可选服务:默认模拟“宿主没有 sessions / remote 服务”
    get(name) {
      return options.noSessionStatus && name === 'remote' ? remote : undefined
    },
    slots: {
      inject(slotName, register) {
        injectCalls.push(slotName)
        register()
      },
      register(meta, component) {
        registrations.push({ meta, component })
        return () => {}
      },
    },
  }
  if (!options.noSessionStatus) {
    ctx.uiSession = {
      sessionStatus: {
        getSnapshot: () => statusMap,
        subscribe(listener) {
          statusListeners.add(listener)
          return () => statusListeners.delete(listener)
        },
      },
    }
  } else {
    // 有这个服务、但没有 sessionStatus:触发兜底分支
    ctx.uiSession = {}
  }

  exported.apply(ctx)

  const api = {
    exported,
    entry,
    env,
    registrations,
    injectCalls,
    effects,
    remote,
    slotOf: (name) => registrations.find((item) => item.meta.name === name),
    /** 模拟宿主推送新的会话状态快照。 */
    setStatus(map) {
      statusMap = map
      for (const listener of Array.from(statusListeners)) listener()
    },
    /** 读插件当前 React 快照(通过它自己挂的调试句柄)。 */
    snapshot() {
      return env.window.__dshApprovalAlert ? env.window.__dshApprovalAlert.getSnapshot() : null
    },
    restoreGlobals() {
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else delete globalThis[key]
      }
    },
  }
  return api
}

// ============================================================================
// 场景
// ============================================================================

function statusPending(interaction, sessionId = 'session-1') {
  return new Map([[sessionId, { running: true, pendingInteraction: interaction, completionUnread: false }]])
}

function statusIdle(sessionId = 'session-1') {
  return new Map([[sessionId, { running: true, pendingInteraction: undefined, completionUnread: false }]])
}

function approval(options = {}) {
  return {
    kind: 'approval',
    key: options.key || 'approval:1',
    toolName: options.toolName || 'pwsh',
    reason: options.reason || '需要写入工作区以外的文件',
  }
}

function renderOverlay(api) {
  const overlay = api.slotOf('shell.overlay')
  if (!overlay) throw new Error('shell.overlay was not registered')
  return renderToStaticMarkup(React.createElement(overlay.component, {}))
}

function renderConfigPage(api, props) {
  const config = api.slotOf('plugins.bundle.config')
  if (!config) throw new Error('plugins.bundle.config was not registered')
  return renderToStaticMarkup(React.createElement(config.component, props || {}))
}

const scenarios = []
function scenario(name, run) {
  scenarios.push({ name, run })
}

// ---------------------------------------------------------------------------

scenario('模块形状与槽位注册', async () => {
  const api = loadPlugin()
  try {
    eq(api.exported.name, 'dsh-approval-alert', 'exported name')
    ok(Array.isArray(api.exported.inject), 'inject is an array')
    ok(api.exported.inject.includes('slots') && api.exported.inject.includes('uiSession'), 'inject requires slots + uiSession')
    eq(typeof api.exported.apply, 'function', 'apply type')
    ok(api.injectCalls.includes('shell.overlay'), 'registers into shell.overlay')
    ok(api.injectCalls.includes('plugins.bundle.config'), 'registers into plugins.bundle.config')
    eq(api.slotOf('shell.overlay').meta.id, 'dsh-approval-alert', 'overlay slot id')
    eq(api.slotOf('plugins.bundle.config').meta.key, 'dsh-approval-alert', 'config slot key is the package name')
    eq(api.env.records.styleTags.length, 1, 'styles injected exactly once')
    ok(!!api.env.window.__dshApprovalAlert, 'debug handle published on window')
  } finally {
    api.restoreGlobals()
  }
})

scenario('焦点不在 DSH:提示音 + 系统通知 + 浮层', async () => {
  const api = loadPlugin({ focused: false })
  try {
    api.setStatus(statusPending(approval()))
    ok(api.env.records.oscillationStarts.length > 0, 'played a synthesized alert sound')
    eq(api.env.records.notifications.length, 1, 'created exactly one system notification')
    ok(api.env.records.notifications[0].title.indexOf('审批') >= 0, 'notification title mentions approval')
    ok(String(api.env.records.notifications[0].options.body).indexOf('写入工作区') >= 0, 'notification body carries the reason')
    eq(api.env.records.notifications[0].options.silent, true, 'system notification is silent by default (our own sound plays)')

    const snapshot = api.snapshot()
    eq(snapshot.alerts.length, 1, 'snapshot exposes one pending alert')
    eq(snapshot.alerts[0].kind, 'approval', 'pending alert kind')
    ok(!!snapshot.toast, 'snapshot exposes a toast')

    const markup = renderOverlay(api)
    ok(markup.indexOf('需要你的审批') >= 0, 'in-app toast renders the approval title')
    ok(markup.indexOf('去处理') >= 0, 'in-app toast renders the action button')
    ok(markup.indexOf('daa-dock') >= 0, 'dock bell renders')
    ok(markup.indexOf('daa-badge') >= 0, 'dock shows a pending badge')
  } finally {
    api.restoreGlobals()
  }
})

scenario('同一请求不重复提醒,回答后收起', async () => {
  const api = loadPlugin({ focused: false })
  try {
    api.setStatus(statusPending(approval({ key: 'approval:7' })))
    const sounds = api.env.records.oscillationStarts.length
    const notifications = api.env.records.notifications.length

    api.setStatus(statusPending(approval({ key: 'approval:7' })))
    eq(api.env.records.oscillationStarts.length, sounds, 'unchanged snapshot does not re-ring')
    eq(api.env.records.notifications.length, notifications, 'unchanged snapshot does not re-notify')

    api.setStatus(statusIdle())
    eq(api.snapshot().alerts.length, 0, 'alert removed once answered')
    eq(api.snapshot().toast, null, 'toast cleared once answered')
    const markup = renderOverlay(api)
    ok(markup.indexOf('需要你的审批') < 0, 'toast gone from markup')
    ok(markup.indexOf('daa-badge') < 0, 'badge gone from markup')
  } finally {
    api.restoreGlobals()
  }
})

scenario('重复提醒:间隔到点再响一次', async () => {
  const api = loadPlugin({
    focused: false,
    settings: { events: { approval: { enabled: true, sound: 'preset:double', volume: 0.9, repeat: 2, intervalSec: 3 } } },
  })
  try {
    api.setStatus(statusPending(approval({ key: 'approval:repeat' })))
    const first = api.env.records.oscillationStarts.length
    ok(first >= 2, 'double preset plays two notes on the first ring')
    await sleep(3400)
    ok(api.env.records.oscillationStarts.length > first, 'second ring happened after the interval')
    ok(api.env.records.notifications.length >= 2, 'second system notification also happened')

    api.setStatus(statusIdle())
    const settled = api.env.records.oscillationStarts.length
    await sleep(1500)
    eq(api.env.records.oscillationStarts.length, settled, 'no rings after the request was answered')
  } finally {
    api.restoreGlobals()
  }
})

scenario('聚焦策略:默认只响声音', async () => {
  const api = loadPlugin({ focused: true })
  try {
    api.setStatus(statusPending(approval()))
    ok(api.env.records.oscillationStarts.length > 0, 'sound still plays while focused')
    eq(api.env.records.notifications.length, 0, 'no system notification while focused (default)')
  } finally {
    api.restoreGlobals()
  }

  const api2 = loadPlugin({ focused: true, settings: { notify: { whenFocused: true } } })
  try {
    api2.setStatus(statusPending(approval()))
    eq(api2.env.records.notifications.length, 1, 'system notification appears when the option is enabled')
  } finally {
    api2.restoreGlobals()
  }
})

scenario('提问 / 计划评审同样提醒', async () => {
  for (const kind of ['question', 'plan-review']) {
    const api = loadPlugin({ focused: false })
    try {
      api.setStatus(statusPending({ kind, key: kind + ':1', questions: [{ question: '要用哪种配色?' }] }, 'session-2'))
      ok(api.env.records.oscillationStarts.length > 0, 'plays a sound for ' + kind)
      const markup = renderOverlay(api)
      ok(markup.indexOf('AI 在等你回答') >= 0, 'toast title for ' + kind)
      ok(markup.indexOf('要用哪种配色') >= 0, 'toast carries the question text for ' + kind)
    } finally {
      api.restoreGlobals()
    }
  }
})

scenario('任务完成的一跳提示(默认关闭)', async () => {
  const off = loadPlugin({ focused: false })
  try {
    off.setStatus(statusPending(undefined, 'session-3'))
    off.setStatus(new Map([['session-3', { running: false, pendingInteraction: undefined, completionUnread: true }]]))
    eq(off.env.records.notifications.length, 0, 'no completion notification while the option is off')
  } finally {
    off.restoreGlobals()
  }

  const on = loadPlugin({ focused: false, settings: { events: { completion: { enabled: true, sound: 'preset:soft', volume: 0.7 } } } })
  try {
    on.setStatus(statusPending(undefined, 'session-3'))
    const before = on.env.records.oscillationStarts.length
    on.setStatus(new Map([['session-3', { running: false, pendingInteraction: undefined, completionUnread: true }]]))
    ok(on.env.records.oscillationStarts.length > before, 'completion plays a sound when enabled')
    eq(on.env.records.notifications.length, 1, 'completion notification when enabled')
    ok(on.env.records.notifications[0].title.indexOf('任务已完成') >= 0, 'completion title')
    const markup = renderOverlay(on)
    ok(markup.indexOf('任务已完成') >= 0, 'completion toast renders')
  } finally {
    on.restoreGlobals()
  }
})

scenario('设置归一化', async () => {
  const api = loadPlugin({
    settings: {
      enabled: true,
      events: { approval: { enabled: true, sound: 'preset:does-not-exist', volume: 9, repeat: 99, intervalSec: 0 } },
      notify: { whenUnfocused: 'yes', inAppToast: true },
      customSounds: [
        { id: 'ok1', name: 'good', dataUrl: 'data:audio/wav;base64,AAAA' },
        { id: 'bad id!', name: 'bad', dataUrl: 'data:audio/wav;base64,AAAA' },
        { id: 'no2', name: 'bad-data', dataUrl: 'https://example.com/x.mp3' },
      ],
    },
  })
  try {
    const settings = api.snapshot().settings
    eq(settings.events.approval.volume, 1, 'volume clamped to 1')
    ok(settings.events.approval.repeat >= 1 && settings.events.approval.repeat <= 5, 'repeat clamped into 1..5')
    ok(settings.events.approval.intervalSec >= 3, 'interval clamped to >= 3s')
    eq(settings.events.approval.sound, 'preset:chime', 'unknown preset falls back to chime')
    eq(settings.events.completion.enabled, false, 'completion stays opt-in')
    eq(settings.notify.whenUnfocused, true, 'non-boolean notify flag falls back to the default')
    eq(settings.customSounds.length, 1, 'only well-formed custom sounds are kept')
    eq(settings.customSounds[0].id, 'ok1', 'custom sound id preserved')

    // 归一化后的设置必须能渲染
    const page = renderConfigPage(api)
    ok(page.indexOf('审批提醒') >= 0, 'config page renders approval section')
    ok(page.indexOf('清脆叮咚') >= 0, 'config page lists preset sounds')
    eq(renderConfigPage(api, { view: 'summary' }), '', 'summary view renders nothing')
  } finally {
    api.restoreGlobals()
  }

  const full = loadPlugin({ storageFull: true })
  try {
    ok(true, 'plugin loads with a throwing localStorage')
    full.setStatus(statusPending(approval()))
    ok(full.env.records.oscillationStarts.length > 0, 'still alerts when settings cannot be persisted')
  } finally {
    full.restoreGlobals()
  }
})

scenario('通知权限缺失/被拒/不支持时安静降级', async () => {
  for (const permission of ['default', 'denied', 'unsupported']) {
    const api = loadPlugin({ focused: false, permission })
    try {
      api.setStatus(statusPending(approval()))
      ok(api.env.records.oscillationStarts.length > 0, 'sound still plays when permission is ' + permission)
      eq(api.env.records.notifications.length, 0, 'no notification created when permission is ' + permission)
      if (permission === 'default') {
        ok(api.env.records.permissionRequests >= 1, 'asks for permission once when it is still undecided')
      }
      const markup = renderOverlay(api)
      ok(markup.indexOf('需要你的审批') >= 0, 'in-app toast still works when permission is ' + permission)
    } finally {
      api.restoreGlobals()
    }
  }
})

scenario('卸载后不再有定时器继续响', async () => {
  const api = loadPlugin({ focused: false, settings: { events: { approval: { enabled: true, repeat: 3, intervalSec: 3 } } } })
  try {
    api.setStatus(statusPending(approval({ key: 'approval:dispose' })))
    const sounds = api.env.records.oscillationStarts.length
    for (const effect of api.effects) effect.dispose()
    await sleep(3300)
    eq(api.env.records.oscillationStarts.length, sounds, 'no further rings after dispose')
  } finally {
    api.restoreGlobals()
  }
})

scenario('测试按钮与调试句柄', async () => {
  const api = loadPlugin({ focused: false })
  try {
    const handle = api.env.window.__dshApprovalAlert
    ok(!!handle, 'debug handle exists')
    const before = api.env.records.oscillationStarts.length
    handle.testAlert('approval')
    ok(api.env.records.oscillationStarts.length > before, 'testAlert rings')
    eq(api.snapshot().alerts.length, 1, 'testAlert publishes a pending alert')
    const described = handle.describe()
    eq(described.pending.length, 1, 'describe() lists the pending alert')

    // 自检提醒会自己过期,不会一直挂在浮层里
    await sleep(12500)
    eq(api.snapshot().alerts.length, 0, 'self-test alert expires on its own')
  } finally {
    api.restoreGlobals()
  }
})

scenario('没有 sessionStatus 时退回到 approval/request 责任链', async () => {
  const api = loadPlugin({ focused: false, noSessionStatus: true })
  try {
    const remote = api.remote
    ok(!!remote, 'fallback subscribed to remote when sessionStatus is missing')
    eq(remote.handlers.length, 1, 'one approval/request listener registered')
    const listener = remote.handlers[0]
    const soundsBefore = api.env.records.oscillationStarts.length
    let nextCalls = 0
    listener({ toolName: 'pwsh', callId: 'call-42', reason: '需要写入工作区以外的文件' }, () => {
      nextCalls += 1
    })
    eq(nextCalls, 1, 'fallback always delegates with next() so DSH still answers the approval')
    ok(api.env.records.oscillationStarts.length > soundsBefore, 'fallback also rings')
    eq(api.env.records.notifications.length, 1, 'fallback notifies while unfocused')
    eq(api.snapshot().alerts.length, 1, 'fallback publishes a pending alert')
  } finally {
    api.restoreGlobals()
  }
})

// ============================================================================
// 运行
// ============================================================================

for (const item of scenarios) {
  console.log('\n[' + item.name + ']')
  try {
    await item.run()
  } catch (error) {
    failures += 1
    console.log('  FAIL threw: ' + (error && error.stack ? error.stack : String(error)))
  }
}

console.log('\n' + passes + ' passed, ' + failures + ' failed')
process.exit(failures > 0 ? 1 : 0)
