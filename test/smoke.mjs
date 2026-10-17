/**
 * dsh-approval-alert —— 离线冒烟测试。
 *
 * 把 `lib/client.js` 当成真实的 `window.__ModuleLoader__` 工厂跑起来,用假的
 * window / document / AudioContext 验证真实行为:
 *
 *   1. 模块形状与两个槽位注册
 *   2. 窗口在后台 → 提示音 + 右下角浮层 + 系统通知(标题/正文/tag/silent)
 *   3. 窗口在前台 → 只有提示音 + 浮层
 *   4. 关掉「窗口在后台时弹系统通知」后不再弹
 *   5. 通知权限未授权时安静降级,手势授权后恢复
 *   6. 点系统通知切到审批所属会话
 *   7. 同一请求不重复提醒;请求被回答后收起
 *   8. 重复提醒(间隔到点再响一次,后台通知也跟着重复)
 *   9. 「去处理」跳到审批所属会话(uiWorkspace.openSession / sessions.open 兜底 / 降级)
 *  10. 提问 / 计划评审同样提醒,并带上会话 id
 *  11. 任务完成的一跳提示(默认关闭)
 *  12. 设置归一化(旧版 notify 字段被丢弃,后台通知默认开)
 *  13. 卸载后不再有任何定时器继续响
 *  14. 测试按钮与调试句柄
 *  15. 没有 sessionStatus 时退回到 approval/request 责任链
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
// 假环境:够用的 window / document / Web Audio
// ============================================================================

function createEnv(options) {
  const records = {
    notifications: [],
    notes: [],
    permissionRequests: 0,
    oscillationStarts: [],
    styleTags: [],
    focusRequests: 0,
    resumes: 0,
  }

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

  /**
   * 记录型的 Notification 替身:能观察 title / body / tag / silent,也能手动点它。
   * 权限默认 granted,可用 options.permission 改成 default / denied。
   */
  class FakeNotification {
    constructor(title, options) {
      this.title = title
      this.options = options || {}
      this.onclick = null
      this.closed = false
      this.permission = FakeNotification.permission
      records.notifications.push(this)
      records.notes.push(this)
    }
    close() {
      this.closed = true
    }
    static requestPermission() {
      records.permissionRequests += 1
      if (FakeNotification.permission === 'default') FakeNotification.permission = 'granted'
      return Promise.resolve(FakeNotification.permission)
    }
  }
  FakeNotification.permission = options.permission || 'granted'

  const storage = new Map()
  if (options.settings !== undefined) {
    storage.set('dsh-approval-alert:settings:v1', JSON.stringify(options.settings))
  }

  let focused = options.focused !== false

  const document = {
    get visibilityState() {
      return focused ? 'visible' : 'hidden'
    },
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
      focused = value === true
    },
    permission() {
      return FakeNotification.permission
    },
    grantPermission() {
      FakeNotification.permission = 'granted'
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
    // 可选服务:uiWorkspace / sessions 用来切会话;remote 只在没有 sessionStatus 的宿主上出现
    get(name) {
      if (name === 'uiWorkspace') return options.workspace
      if (name === 'sessions') return options.sessions
      if (name === 'remote') return options.noSessionStatus ? remote : undefined
      return undefined
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
    handle: () => env.window.__dshApprovalAlert,
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
    ok(!!api.handle(), 'debug handle published on window')
  } finally {
    api.restoreGlobals()
  }
})

scenario('窗口在后台:提示音 + 浮层 + 系统通知', async () => {
  const api = loadPlugin({ focused: false })
  try {
    api.setStatus(statusPending(approval()))
    ok(api.env.records.oscillationStarts.length > 0, 'played a synthesized alert sound')

    eq(api.env.records.notifications.length, 1, 'created exactly one system notification')
    const note = api.env.records.notes[0]
    eq(note.title, '需要你的审批 · DSH', 'notification title')
    eq(note.options.body, '需要写入工作区以外的文件', 'notification body carries the approval reason')
    eq(note.options.tag, 'dsh-approval-alert', 'notification tag identifies this plugin')
    eq(note.options.silent, true, 'notification is silent; the plugin plays its own sound')

    const snapshot = api.snapshot()
    eq(snapshot.alerts.length, 1, 'snapshot exposes one pending alert')
    eq(snapshot.alerts[0].kind, 'approval', 'pending alert kind')
    eq(snapshot.alerts[0].sessionId, 'session-1', 'pending alert remembers its session')
    ok(!!snapshot.toast, 'snapshot exposes a toast')
    eq(snapshot.permission, 'granted', 'snapshot reports the notification permission')

    const markup = renderOverlay(api)
    ok(markup.indexOf('需要你的审批') >= 0, 'in-app toast renders the approval title')
    ok(markup.indexOf('去处理') >= 0, 'in-app toast renders the action button')
    ok(markup.indexOf('>设置<') >= 0, 'in-app toast offers a settings button')
    ok(markup.indexOf('daa-dock') < 0, 'no permanent floating dock is rendered')
    ok(markup.indexOf('daa-badge') < 0, 'no badge on a dock (there is no dock)')

    const css = api.env.records.styleTags[0].textContent
    ok(css.indexOf('right:16px;bottom:16px') >= 0, 'toast sits at the very bottom-right corner')
    ok(css.indexOf('--dsw-alias-state-warn') < 0, 'no orange (warn) theme token is used anywhere')
    ok(css.indexOf('--daa-accent:#4d8dff') >= 0, 'light-blue accent is defined')
  } finally {
    api.restoreGlobals()
  }
})

scenario('窗口在前台:只响声音 + 浮层,不打扰系统通知', async () => {
  const api = loadPlugin({ focused: true })
  try {
    api.setStatus(statusPending(approval()))
    ok(api.env.records.oscillationStarts.length > 0, 'still rings')
    eq(api.env.records.notifications.length, 0, 'no system notification while the window is focused')
    ok(!!api.snapshot().toast, 'in-app toast still shows')
  } finally {
    api.restoreGlobals()
  }
})

scenario('关掉「窗口在后台时弹系统通知」', async () => {
  const api = loadPlugin({ focused: false, settings: { notify: { backgroundNotification: false } } })
  try {
    api.setStatus(statusPending(approval()))
    ok(api.env.records.oscillationStarts.length > 0, 'sound is unaffected by the toggle')
    eq(api.env.records.notifications.length, 0, 'no system notification when the toggle is off')
  } finally {
    api.restoreGlobals()
  }
})

scenario('通知权限未授权时安静降级,授权后恢复', async () => {
  const api = loadPlugin({ focused: false, permission: 'default' })
  try {
    api.setStatus(statusPending(approval()))
    eq(api.env.records.notifications.length, 0, 'no notification before the permission is granted')

    // 用户点一下页面 = 手势 → 插件申请一次权限;自检提醒本身也会补发一条通知
    api.handle().testAlert('approval')
    eq(api.env.records.permissionRequests, 1, 'asked for the permission on a user gesture')
    eq(api.env.records.notifications.length, 1, 'the self-test notifies once the permission is granted')

    api.setStatus(statusIdle())
    api.setStatus(statusPending(approval({ key: 'approval:2' })))
    eq(api.env.records.notifications.length, 2, 'real approvals notify again after the permission is granted')
  } finally {
    api.restoreGlobals()
  }
})

scenario('点系统通知切到审批所属会话', async () => {
  const opened = []
  const api = loadPlugin({ focused: false, workspace: { openSession: (id) => opened.push(id) } })
  try {
    api.setStatus(statusPending(approval(), 'session-z'))
    const note = api.env.records.notes[0]
    ok(!!note && typeof note.onclick === 'function', 'notification has a click handler')

    note.onclick()

    eq(opened.join(','), 'session-z', 'jumped to the waiting session')
    ok(api.env.records.focusRequests >= 1, 'window raised as well')
    ok(note.closed === true, 'notification closed after the click')
  } finally {
    api.restoreGlobals()
  }
})

scenario('同一请求不重复提醒,回答后收起', async () => {
  const api = loadPlugin({ focused: false })
  try {
    api.setStatus(statusPending(approval({ key: 'approval:7' })))
    const sounds = api.env.records.oscillationStarts.length
    const notes = api.env.records.notifications.length

    api.setStatus(statusPending(approval({ key: 'approval:7' })))
    eq(api.env.records.oscillationStarts.length, sounds, 'unchanged snapshot does not re-ring')
    eq(api.env.records.notifications.length, notes, 'and does not re-notify')

    api.setStatus(statusIdle())
    eq(api.snapshot().alerts.length, 0, 'alert removed once answered')
    eq(api.snapshot().toast, null, 'toast cleared once answered')
    const markup = renderOverlay(api)
    ok(markup.indexOf('需要你的审批') < 0, 'toast gone from markup')
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
    const firstNotes = api.env.records.notifications.length
    ok(first >= 2, 'double preset plays two notes on the first ring')
    await sleep(3400)
    ok(api.env.records.oscillationStarts.length > first, 'second ring happened after the interval')
    ok(api.env.records.notifications.length > firstNotes, 'and the background notification was repeated too')

    api.setStatus(statusIdle())
    const settled = api.env.records.oscillationStarts.length
    await sleep(1500)
    eq(api.env.records.oscillationStarts.length, settled, 'no rings after the request was answered')
  } finally {
    api.restoreGlobals()
  }
})

scenario('「去处理」跳到审批所属会话', async () => {
  const opened = []
  const workspace = { openSession: (id) => opened.push(id) }
  const api = loadPlugin({ workspace })
  try {
    api.setStatus(statusPending(approval(), 'session-b'))
    const toast = api.snapshot().toast
    eq(toast.sessionId, 'session-b', 'toast carries the session id')

    api.handle().focusAlert(toast)

    eq(opened.join(','), 'session-b', 'uiWorkspace.openSession() got the waiting session')
    ok(api.env.records.focusRequests >= 1, 'window is brought forward as well')
    eq(api.snapshot().toast, null, 'toast dismissed after jumping')
    eq(renderOverlay(api).indexOf('需要你的审批'), -1, 'toast gone from markup')

    // 审批还没回答,所以“等待”仍然存在,只是浮层收起了
    eq(api.snapshot().alerts.length, 1, 'the pending alert itself is untouched')
  } finally {
    api.restoreGlobals()
  }
})

scenario('新版宿主:sessions.open() 作为兜底', async () => {
  const opened = []
  const api = loadPlugin({ sessions: { open: (id) => opened.push(id) } })
  try {
    api.setStatus(statusPending(approval(), 'session-d'))
    const toast = api.snapshot().toast
    api.handle().focusAlert(toast)
    eq(opened.join(','), 'session-d', 'falls back to sessions.open() when uiWorkspace is absent')
    eq(api.snapshot().toast, null, 'toast dismissed as well')
  } finally {
    api.restoreGlobals()
  }
})

scenario('宿主没有 uiWorkspace 时,「去处理」退化为只聚焦窗口', async () => {
  const api = loadPlugin()
  try {
    api.setStatus(statusPending(approval(), 'session-c'))
    const toast = api.snapshot().toast
    eq(toast.sessionId, 'session-c', 'toast still knows its session')

    let threw = false
    try {
      api.handle().focusAlert(toast)
    } catch {
      threw = true
    }
    ok(!threw, 'no exception when uiWorkspace is absent')
    ok(api.env.records.focusRequests >= 1, 'window.focus() still runs')
    eq(api.snapshot().toast, null, 'toast dismissed anyway')
  } finally {
    api.restoreGlobals()
  }
})

scenario('提问 / 计划评审同样提醒,并带上会话 id', async () => {
  for (const kind of ['question', 'plan-review']) {
    const api = loadPlugin()
    try {
      api.setStatus(statusPending({ kind, key: kind + ':1', questions: [{ question: '要用哪种配色?' }] }, 'session-2'))
      ok(api.env.records.oscillationStarts.length > 0, 'plays a sound for ' + kind)
      const toast = api.snapshot().toast
      eq(toast.sessionId, 'session-2', 'toast knows the session for ' + kind)
      const markup = renderOverlay(api)
      ok(markup.indexOf('AI 在等你回答') >= 0, 'toast title for ' + kind)
      ok(markup.indexOf('要用哪种配色') >= 0, 'toast carries the question text for ' + kind)
    } finally {
      api.restoreGlobals()
    }
  }
})

scenario('任务完成的一跳提示(默认关闭)', async () => {
  const off = loadPlugin()
  try {
    off.setStatus(statusPending(undefined, 'session-3'))
    off.setStatus(new Map([['session-3', { running: false, pendingInteraction: undefined, completionUnread: true }]]))
    eq(off.snapshot().alerts.length, 0, 'no completion alert while the option is off')
  } finally {
    off.restoreGlobals()
  }

  const on = loadPlugin({ settings: { events: { completion: { enabled: true, sound: 'preset:soft', volume: 0.7 } } } })
  try {
    on.setStatus(statusPending(undefined, 'session-3'))
    const before = on.env.records.oscillationStarts.length
    on.setStatus(new Map([['session-3', { running: false, pendingInteraction: undefined, completionUnread: true }]]))
    ok(on.env.records.oscillationStarts.length > before, 'completion plays a sound when enabled')
    const markup = renderOverlay(on)
    ok(markup.indexOf('任务已完成') >= 0, 'completion toast renders')
    const toast = on.snapshot().toast
    eq(toast.sessionId, null, 'completion is not tied to a session')
  } finally {
    on.restoreGlobals()
  }
})

scenario('设置归一化:旧版 notify 字段被丢弃,后台通知保留', async () => {
  const api = loadPlugin({
    settings: {
      enabled: true,
      events: { approval: { enabled: true, sound: 'preset:does-not-exist', volume: 9, repeat: 99, intervalSec: 0 } },
      notify: { whenUnfocused: true, whenFocused: true, systemSound: true, inAppToast: false },
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
    eq(settings.notify.inAppToast, false, 'inAppToast survives normalization')
    eq(settings.notify.backgroundNotification, true, 'background notification defaults to on')
    ok(!('whenUnfocused' in settings.notify), 'legacy whenUnfocused is dropped')
    ok(!('whenFocused' in settings.notify), 'legacy whenFocused is dropped')
    ok(!('systemSound' in settings.notify), 'legacy systemSound is dropped')
    eq(settings.customSounds.length, 1, 'only well-formed custom sounds are kept')
    eq(settings.customSounds[0].id, 'ok1', 'custom sound id preserved')

    // 归一化后的设置必须能渲染
    const page = renderConfigPage(api)
    ok(page.indexOf('审批提醒') >= 0, 'config page renders approval section')
    ok(page.indexOf('清脆叮咚') >= 0, 'config page lists preset sounds')
    ok(page.indexOf('右下角浮层') >= 0, 'config page offers the in-app toast switch')
    ok(page.indexOf('窗口在后台时弹系统通知') >= 0, 'config page offers the background notification switch')
    ok(page.indexOf('系统通知权限') >= 0, 'config page reports the notification permission')
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

scenario('卸载后不再有定时器继续响', async () => {
  const api = loadPlugin({ settings: { events: { approval: { enabled: true, repeat: 3, intervalSec: 3 } } } })
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
  const api = loadPlugin()
  try {
    const handle = api.handle()
    ok(!!handle, 'debug handle exists')
    const before = api.env.records.oscillationStarts.length
    handle.testAlert('approval')
    ok(api.env.records.oscillationStarts.length > before, 'testAlert rings')
    eq(api.snapshot().alerts.length, 1, 'testAlert publishes a pending alert')
    const described = handle.describe()
    eq(described.pending.length, 1, 'describe() lists the pending alert')
    ok(Array.isArray(described.sessions), 'describe() lists the sessions being waited on')
    eq(described.focused, true, 'describe() reports the window focus')
    eq(described.permission, 'granted', 'describe() reports the notification permission')
    eq(api.env.records.permissionRequests, 1, 'self-test asks for the notification permission once')

    // 自检提醒会自己过期,不会一直挂在浮层里
    await sleep(12500)
    eq(api.snapshot().alerts.length, 0, 'self-test alert expires on its own')
  } finally {
    api.restoreGlobals()
  }
})

scenario('没有 sessionStatus 时退回到 approval/request 责任链', async () => {
  const api = loadPlugin({ noSessionStatus: true })
  try {
    const remote = api.remote
    ok(!!remote, 'fallback subscribed to remote when sessionStatus is missing')
    eq(remote.handlers.length, 1, 'one approval/request listener registered')
    const listener = remote.handlers[0]
    const soundsBefore = api.env.records.oscillationStarts.length
    let nextCalls = 0
    listener({ toolName: 'pwsh', callId: 'call-42', sessionId: 'session-remote', reason: '需要写入工作区以外的文件' }, () => {
      nextCalls += 1
    })
    eq(nextCalls, 1, 'fallback always delegates with next() so DSH still answers the approval')
    ok(api.env.records.oscillationStarts.length > soundsBefore, 'fallback also rings')
    eq(api.snapshot().alerts.length, 1, 'fallback publishes a pending alert')
    eq(api.snapshot().alerts[0].sessionId, 'session-remote', 'fallback keeps the session id when the request carries one')
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
