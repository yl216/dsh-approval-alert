/**
 * dsh-approval-alert —— 浏览器侧(Client)插件。
 *
 * 目标:当 DSH 因为“等你审批 / 等你回答”而停住时,不要让你错过它。
 *   · 声音提醒:按事件配置音效、音量与重复次数;
 *   · 应用内右下角浮层:点「去处理」直接跳到审批/提问所属的会话(不再只切窗口);
 *   · 窗口不在前台时,再补一条 Windows 系统通知(点通知同样会切到该会话)。
 *
 * 系统通知默认开、可关:DSH 自身没有审批类的系统通知,窗口在后台时只靠它才看得见。
 *
 * 机制:`uiSession.sessionStatus` 是宿主已经算好的“每个会话的状态快照”
 * (`{ running, pendingInteraction, completionUnread }`)。审批卡片出现的前提
 * 就是某个会话的 `pendingInteraction.kind === 'approval'`,所以订阅它就等于
 * “审批卡片出现的瞬间”,而且不参与 `approval/request` 责任链 —— 绝不会影响
 * 审批本身能否被回答。
 *
 * 本文件不需要构建:它就是一个 `window.__ModuleLoader__.load({...})` 工厂,
 * 只从平台模块表里取 `react`(基线模块),其余全部是原生 DOM / Web Audio。
 */
window.__ModuleLoader__.load({
  id: 'dsh-approval-alert',
  factory: (require) => {
    'use strict'

    const React = require('react')
    const h = React.createElement

    // ========================================================================
    // 常量
    // ========================================================================

    const PKG = 'dsh-approval-alert'
    const SETTINGS_KEY = 'dsh-approval-alert:settings:v1'
    const CSS_ID = 'dsh-approval-alert/styles'
    const NOTIFICATION_TAG = 'dsh-approval-alert'
    const MAX_CUSTOM_BYTES = 1.5 * 1024 * 1024

    /** 内置音效:全部用 Web Audio 现场合成,不随包带音频文件。 */
    const PRESETS = [
      { id: 'chime', zh: '清脆叮咚', en: 'Chime' },
      { id: 'bell', zh: '铃音', en: 'Bell' },
      { id: 'double', zh: '双响', en: 'Double' },
      { id: 'pulse', zh: '短促三连', en: 'Triple pulse' },
      { id: 'rise', zh: '升调提醒', en: 'Rising' },
      { id: 'soft', zh: '柔和轻响', en: 'Soft' },
      { id: 'drop', zh: '水滴', en: 'Water drop' },
      { id: 'urgent', zh: '紧急提醒', en: 'Urgent' },
    ]

    /** 每个事件的默认设置。`sound` 形如 `preset:<id>` / `custom:<id>` / `none`。 */
    function defaultSettings() {
      return {
        enabled: true,
        events: {
          approval: { enabled: true, sound: 'preset:chime', volume: 0.85, repeat: 2, intervalSec: 10 },
          question: { enabled: true, sound: 'preset:chime', volume: 0.85, repeat: 2, intervalSec: 10 },
          completion: { enabled: false, sound: 'preset:soft', volume: 0.7, repeat: 1, intervalSec: 10 },
        },
        notify: {
          inAppToast: true,
          backgroundNotification: true,
        },
        customSounds: [],
      }
    }

    // ========================================================================
    // 文案(按界面语言选中文/英文;不依赖 locale 服务,少一个挂载前提)
    // ========================================================================

    function preferredLanguage() {
      try {
        const list = navigator.languages
        const first = (list && list.length ? list[0] : navigator.language) || 'en'
        return String(first).toLowerCase()
      } catch {
        return 'en'
      }
    }
    const ZH = preferredLanguage().indexOf('zh') === 0
    function L(zh, en) {
      return ZH ? zh : en
    }

    const COPY = {
      approvalTitle: L('需要你的审批 · DSH', 'Approval needed · DSH'),
      questionTitle: L('AI 在等你回答 · DSH', 'AI is waiting · DSH'),
      completionTitle: L('任务已完成 · DSH', 'Task finished · DSH'),
      approvalFallback: L('有工具请求越权执行,DSH 已暂停等你决定。', 'A tool is asking for privileged execution.'),
      questionFallback: L('AI 提出了一个问题,正在等你回答。', 'The assistant asked you a question.'),
      completionFallback: L('本轮已结束。', 'This turn has finished.'),
      toastAction: L('去处理', 'Open'),
      toastClose: L('关闭', 'Dismiss'),
      settingsShort: L('设置', 'Settings'),
      pendingCount: L('还有 {n} 个等待', '{n} more waiting'),
      settingsTitle: L('审批 · 提问提醒', 'Approval & question alerts'),
      settingsSubtitle: L(
        'DSH 等你审批或回答时响提示音 + 右下角浮层;窗口在后台时再补一条系统通知,点哪一条都直接跳到对应会话。',
        'Sound plus a bottom-right toast when DSH waits for you, a Windows toast while the window is in the background, and both jump straight to that session.',
      ),
      general: L('总开关', 'General'),
      enabled: L('启用提醒', 'Enable alerts'),
      soundSection: L('声音与重复', 'Sound & repeat'),
      sound: L('提示音', 'Sound'),
      volume: L('音量', 'Volume'),
      repeat: L('重复次数', 'Repeats'),
      interval: L('重复间隔', 'Interval'),
      preview: L('试听', 'Preview'),
      test: L('立即测试', 'Test now'),
      notifySection: L('提醒方式', 'Alert channels'),
      inAppToast: L('右下角浮层提示', 'Bottom-right toast'),
      inAppToastHint: L(
        '浮层里的「去处理」会直接切到审批 / 提问所在的会话,不只把窗口提到前台。',
        'The toast’s Open button switches to the session that is waiting, not just the window.',
      ),
      backgroundNotification: L('窗口在后台时弹系统通知', 'System notification while the window is in the background'),
      backgroundNotificationHint: L(
        'DSH 自己没有审批类的系统通知,所以插件在窗口失去焦点时补一条 Windows 通知;点通知会切到对应会话。',
        'DSH does not raise approval notifications by itself, so the plugin adds a Windows toast while the window is unfocused; clicking it switches to that session.',
      ),
      permissionGranted: L('已授权', 'granted'),
      permissionDenied: L('被拒绝(只能靠声音与浮层)', 'denied (sound and in-app toast only)'),
      permissionDefault: L('尚未授权(在页面里点一下即可申请)', 'not granted yet — click anywhere once'),
      permissionUnsupported: L('当前环境不支持', 'unsupported here'),
      permission: L('系统通知权限', 'Notification permission'),
      customSection: L('自定义音效', 'Custom sounds'),
      customHint: L(
        '导入 wav / mp3 / ogg(≤1.5MB),保存在本机浏览器存储里;选中后可作为任意事件的提示音。',
        'Import wav / mp3 / ogg (≤1.5MB); stored in this browser profile and usable as any event sound.',
      ),
      importSound: L('导入音频…', 'Import audio…'),
      use: L('使用', 'Use'),
      remove: L('删除', 'Remove'),
      reset: L('恢复默认设置', 'Restore defaults'),
      silent: L('静音', 'Silent'),
      sec: L('秒', 's'),
      times: L('次', '×'),
      statusSection: L('运行状态', 'Status'),
      audioReady: L('音频已就绪', 'Audio ready'),
      audioLocked: L('音频待解锁(在页面里点一下即可)', 'Audio locked — click anywhere once'),
      tooLarge: L('文件过大,请选择 ≤1.5MB 的音频。', 'File too large; pick an audio file ≤1.5MB.'),
      badFile: L('无法读取该文件。', 'Could not read that file.'),
      saveFailed: L('保存失败:浏览器存储可能已满。', 'Save failed: browser storage may be full.'),
      approvalEvent: L('审批提醒', 'Approval'),
      questionEvent: L('提问 / 计划评审提醒', 'Question / plan review'),
      completionEvent: L('任务完成提醒', 'Turn finished'),
      about: L(
        '从「设置 → 插件」里也能找到本页;审批本身仍然由 DSH 自己的卡片负责回答,本插件只负责提醒。',
        'This page also lives in Settings → Plugins. Answering the approval stays with DSH itself; this plugin only reminds you.',
      ),
    }

    // ========================================================================
    // 设置:读取 / 归一化 / 保存
    // ========================================================================

    function clampNumber(value, min, max, fallback) {
      const n = Number(value)
      if (!isFinite(n)) return fallback
      return Math.min(max, Math.max(min, n))
    }

    function isPlainObject(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    }

    function normalizeSoundSelection(value, customSounds) {
      const raw = typeof value === 'string' ? value : ''
      if (raw === 'none') return 'none'
      if (raw.indexOf('preset:') === 0) {
        const id = raw.slice('preset:'.length)
        return PRESETS.some((p) => p.id === id) ? raw : 'preset:chime'
      }
      if (raw.indexOf('custom:') === 0) {
        const id = raw.slice('custom:'.length)
        return customSounds.some((s) => s.id === id) ? raw : 'preset:chime'
      }
      return 'preset:chime'
    }

    function normalizeEventConfig(raw, fallback, customSounds) {
      const src = isPlainObject(raw) ? raw : {}
      return {
        // 缺省时必须继承 fallback 的开关:否则“未配置”会被当成 true,
        // 让默认关闭的任务完成提醒在第一次加载后自己打开。
        enabled: src.enabled === undefined ? fallback.enabled !== false : src.enabled !== false,
        sound: normalizeSoundSelection(src.sound === undefined ? fallback.sound : src.sound, customSounds),
        volume: clampNumber(src.volume, 0, 1, fallback.volume),
        repeat: Math.round(clampNumber(src.repeat, 1, 5, fallback.repeat)),
        intervalSec: Math.round(clampNumber(src.intervalSec, 3, 120, fallback.intervalSec)),
      }
    }

    function normalizeCustomSounds(raw) {
      if (!Array.isArray(raw)) return []
      const out = []
      for (const item of raw) {
        if (!isPlainObject(item)) continue
        const dataUrl = typeof item.dataUrl === 'string' ? item.dataUrl : ''
        if (dataUrl.indexOf('data:audio/') !== 0) continue
        const name = String(item.name || '').slice(0, 80) || 'audio'
        const id = String(item.id || '').slice(0, 60)
        if (!/^[a-zA-Z0-9_-]{1,60}$/.test(id)) continue
        out.push({ id, name, dataUrl })
        if (out.length >= 12) break
      }
      return out
    }

    function normalizeSettings(raw) {
      const defaults = defaultSettings()
      const src = isPlainObject(raw) ? raw : {}
      const customSounds = normalizeCustomSounds(src.customSounds)
      const events = isPlainObject(src.events) ? src.events : {}
      const notify = isPlainObject(src.notify) ? src.notify : {}
      return {
        enabled: src.enabled !== false,
        events: {
          approval: normalizeEventConfig(events.approval, defaults.events.approval, customSounds),
          question: normalizeEventConfig(events.question, defaults.events.question, customSounds),
          completion: normalizeEventConfig(events.completion, defaults.events.completion, customSounds),
        },
        notify: {
          inAppToast: notify.inAppToast !== false,
          // 0.2.0 曾把这一项删掉过;读老设置时缺省即视为开启,用户不必重设
          backgroundNotification: notify.backgroundNotification !== false,
        },
        customSounds,
      }
    }

    function readStorage() {
      try {
        const text = window.localStorage.getItem(SETTINGS_KEY)
        if (!text) return null
        return JSON.parse(text)
      } catch {
        return null
      }
    }

    function writeStorage(settings) {
      try {
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
        return true
      } catch {
        return false
      }
    }

    let settings = normalizeSettings(readStorage())

    // ========================================================================
    // 状态仓库(给 React 用的 snapshot source)
    // ========================================================================

    const listeners = new Set()
    let version = 0
    let snapshot = null

    /** 已挂起、等待用户处理的提醒:`key -> entry`。 */
    const pendingAlerts = new Map()
    /** 任务完成这类“一次性”提醒只做一个短暂浮层。 */
    let flashAlert = null
    let flashTimer = null

    let settingsOpen = false
    let toastKey = null
    let toastDismissed = false
    let audioUnlocked = null
    let lastPlayedAt = 0

    function buildSnapshot() {
      const alerts = []
      for (const entry of pendingAlerts.values()) alerts.push(entry)
      alerts.sort((a, b) => a.at - b.at)
      const toast = resolveToast(alerts)
      return {
        version,
        settings,
        alerts,
        toast,
        settingsOpen,
        audioUnlocked: audioUnlocked === true,
        permission: notificationPermission(),
      }
    }

    function resolveToast(alerts) {
      if (!settings.notify.inAppToast) return null
      if (toastDismissed) return null
      if (alerts.length > 0) {
        const chosen = toastKey ? alerts.find((a) => a.key === toastKey) : null
        return chosen || alerts[alerts.length - 1]
      }
      return flashAlert
    }

    /** 任务栏图标上的数字角标(Chromium 支持时才有;失败就算了)。 */
    function updateAppBadge() {
      try {
        const nav = navigator
        if (!nav) return
        const count = pendingAlerts.size
        if (count > 0) {
          if (typeof nav.setAppBadge === 'function') {
            const started = nav.setAppBadge(count)
            if (started && typeof started.catch === 'function') started.catch(() => {})
          }
        } else if (typeof nav.clearAppBadge === 'function') {
          const cleared = nav.clearAppBadge()
          if (cleared && typeof cleared.catch === 'function') cleared.catch(() => {})
        }
      } catch {
        /* 忽略:角标只是加分项 */
      }
    }

    function publish() {
      version += 1
      snapshot = null
      updateAppBadge()
      for (const listener of listeners) {
        try {
          listener()
        } catch {
          /* 单个订阅者出错不影响其它订阅者 */
        }
      }
    }

    function getSnapshot() {
      if (snapshot === null) snapshot = buildSnapshot()
      return snapshot
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }

    // ========================================================================
    // 音频:内置合成音 + 自定义音频文件
    // ========================================================================

    let audioCtx = null

    function audioSupported() {
      return typeof window !== 'undefined' && !!(window.AudioContext || window.webkitAudioContext)
    }

    function ensureAudioContext() {
      if (audioCtx) {
        if (audioCtx.state === 'suspended') {
          try {
            audioCtx.resume()
          } catch {
            /* 忽略:下次手势再试 */
          }
        }
        return audioCtx
      }
      if (!audioSupported()) return null
      try {
        const Ctor = window.AudioContext || window.webkitAudioContext
        audioCtx = new Ctor()
      } catch {
        return null
      }
      if (audioCtx.state === 'running') audioUnlocked = true
      return audioCtx
    }

    /** 浏览器要求先有用户手势才能出声:解锁一次即可长期有效。 */
    function unlockAudio() {
      const ctx = ensureAudioContext()
      if (!ctx) return
      if (ctx.state === 'running') {
        if (audioUnlocked !== true) {
          audioUnlocked = true
          publish()
        }
        return
      }
      try {
        const p = ctx.resume()
        if (p && typeof p.then === 'function') {
          p.then(() => {
            audioUnlocked = ctx.state === 'running'
            publish()
          }).catch(() => {})
        }
      } catch {
        /* 忽略 */
      }
    }

    /** 各内置音效的音符表:`f` 频率、`t` 起始偏移、`d` 时长、`g` 相对增益。 */
    const VOICES = {
      chime: [
        { f: 880, t: 0, d: 0.16, g: 1 },
        { f: 1320, t: 0.13, d: 0.3, g: 0.85 },
      ],
      bell: [
        { f: 1046.5, t: 0, d: 1.0, g: 0.9 },
        { f: 2093, t: 0, d: 0.7, g: 0.28 },
        { f: 1568, t: 0.02, d: 0.6, g: 0.2 },
      ],
      double: [
        { f: 784, t: 0, d: 0.18, g: 1 },
        { f: 784, t: 0.26, d: 0.22, g: 0.9 },
      ],
      pulse: [
        { f: 920, t: 0, d: 0.08, g: 0.9, type: 'triangle' },
        { f: 920, t: 0.12, d: 0.08, g: 0.9, type: 'triangle' },
        { f: 920, t: 0.24, d: 0.1, g: 0.9, type: 'triangle' },
      ],
      rise: [
        { f: 587, t: 0, d: 0.12, g: 0.9 },
        { f: 740, t: 0.12, d: 0.12, g: 0.95 },
        { f: 880, t: 0.24, d: 0.24, g: 1 },
      ],
      soft: [
        { f: 660, t: 0, d: 0.5, g: 0.6 },
        { f: 990, t: 0.02, d: 0.4, g: 0.18 },
      ],
      drop: [{ f: 1200, f2: 420, t: 0, d: 0.3, g: 1 }],
      urgent: [
        { f: 1000, t: 0, d: 0.1, g: 0.8, type: 'square' },
        { f: 1000, t: 0.18, d: 0.1, g: 0.8, type: 'square' },
        { f: 1000, t: 0.36, d: 0.1, g: 0.8, type: 'square' },
        { f: 1339, t: 0.56, d: 0.26, g: 0.8, type: 'square' },
      ],
    }

    function playPreset(id, volume) {
      const voice = VOICES[id] || VOICES.chime
      const ctx = ensureAudioContext()
      if (!ctx) return false
      const level = Math.max(0, Math.min(1, Number(volume) || 0))
      if (level <= 0) return false
      try {
        const master = ctx.createGain()
        master.gain.value = level * 0.45
        master.connect(ctx.destination)
        const start = ctx.currentTime
        for (const note of voice) {
          const osc = ctx.createOscillator()
          const gain = ctx.createGain()
          osc.type = note.type || 'sine'
          const at = start + note.t
          osc.frequency.setValueAtTime(note.f, at)
          if (note.f2) {
            osc.frequency.exponentialRampToValueAtTime(note.f2, at + note.d)
          }
          const peak = Math.max(0.0001, note.g === undefined ? 1 : note.g)
          gain.gain.setValueAtTime(0.0001, at)
          gain.gain.exponentialRampToValueAtTime(peak, at + 0.012)
          gain.gain.exponentialRampToValueAtTime(0.0001, at + note.d)
          osc.connect(gain)
          gain.connect(master)
          osc.start(at)
          osc.stop(at + note.d + 0.05)
        }
        return true
      } catch {
        return false
      }
    }

    function customSoundById(id) {
      for (const sound of settings.customSounds) {
        if (sound.id === id) return sound
      }
      return null
    }

    function playCustom(id, volume) {
      const sound = customSoundById(id)
      if (!sound) return playPreset('chime', volume)
      const level = Math.max(0, Math.min(1, Number(volume) || 0))
      if (level <= 0) return false
      try {
        const audio = new window.Audio(sound.dataUrl)
        audio.volume = level
        const started = audio.play()
        if (started && typeof started.catch === 'function') started.catch(() => {})
        return true
      } catch {
        return false
      }
    }

    function playSelection(selection, volume) {
      lastPlayedAt = Date.now()
      if (!selection || selection === 'none') return false
      if (selection.indexOf('custom:') === 0) return playCustom(selection.slice('custom:'.length), volume)
      const presetId = selection.indexOf('preset:') === 0 ? selection.slice('preset:'.length) : selection
      return playPreset(presetId, volume)
    }

    // ========================================================================
    // 提醒的触发、重复与结束
    // ========================================================================

    function eventConfig(kind) {
      if (kind === 'question') return settings.events.question
      if (kind === 'completion') return settings.events.completion
      return settings.events.approval
    }

    function eventEnabled(kind) {
      return settings.enabled !== false && eventConfig(kind).enabled !== false
    }

    function titleOf(kind) {
      if (kind === 'question') return COPY.questionTitle
      if (kind === 'completion') return COPY.completionTitle
      return COPY.approvalTitle
    }

    /** 从 pendingInteraction 上取一句人能读的话;取不到就用固定文案。 */
    function describeInteraction(kind, interaction) {
      if (!interaction) return kind === 'approval' ? COPY.approvalFallback : COPY.questionFallback
      if (kind === 'approval') {
        if (typeof interaction.reason === 'string' && interaction.reason.trim()) {
          return interaction.reason.trim().slice(0, 300)
        }
        const tool = interaction.toolName ? String(interaction.toolName) : ''
        return tool ? L('工具 ' + tool + ' 请求越权执行。', 'Tool ' + tool + ' requests privileged execution.') : COPY.approvalFallback
      }
      const questions = interaction.questions
      if (Array.isArray(questions) && questions.length > 0) {
        const first = questions[0]
        if (isPlainObject(first)) {
          for (const key of ['question', 'title', 'header', 'prompt']) {
            const value = first[key]
            if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 300)
          }
        }
      }
      return COPY.questionFallback
    }

    // ========================================================================
    // 窗口在后台时的系统通知
    // ========================================================================

    /** 用 DOM 焦点判断“窗口在不在前台”:最小化、切到别的应用都算不在。 */
    function appFocused() {
      try {
        if (document.visibilityState === 'hidden') return false
        return typeof document.hasFocus === 'function' ? document.hasFocus() : true
      } catch {
        return true
      }
    }

    function notificationSupported() {
      return typeof window !== 'undefined' && typeof window.Notification === 'function'
    }

    function notificationPermission() {
      if (!notificationSupported()) return 'unsupported'
      try {
        return window.Notification.permission || 'default'
      } catch {
        return 'unsupported'
      }
    }

    let permissionRequested = false
    /** 只在用户手势里调用:部分 Chromium 版本弹权限框需要手势。 */
    function requestNotificationPermission() {
      if (!notificationSupported() || permissionRequested) return
      permissionRequested = true
      try {
        const result = window.Notification.requestPermission()
        if (result && typeof result.then === 'function') {
          result.then(() => publish()).catch(() => {})
        } else {
          publish()
        }
      } catch {
        /* 拿不到权限就安静降级 */
      }
    }

    /** 后台时补一条系统通知;点它切到对应会话。失败绝不影响提示音与浮层。 */
    function showSystemNotification(kind, body, sessionId) {
      if (!settings.notify.backgroundNotification) return
      if (!eventEnabled(kind)) return
      if (!notificationSupported()) return
      if (notificationPermission() !== 'granted') return
      if (appFocused()) return
      try {
        const note = new window.Notification(titleOf(kind), {
          body: body || COPY.approvalFallback,
          tag: NOTIFICATION_TAG,
          renotify: true,
          silent: true, // 声音由插件自己放,避免和系统提示音双响
        })
        note.onclick = () => {
          try {
            if (sessionId) openSession(sessionId)
            window.focus()
          } catch {
            /* 忽略 */
          }
          try {
            note.close()
          } catch {
            /* 忽略 */
          }
        }
      } catch {
        /* 通知创建失败不能影响提醒 */
      }
    }

    /** 真正“提醒一次”:提示音 + (后台时)系统通知。浮层由 snapshot 驱动。 */
    function ring(kind, body, sessionId) {
      const cfg = eventConfig(kind)
      if (!eventEnabled(kind)) return
      playSelection(cfg.sound, cfg.volume)
      showSystemNotification(kind, body, sessionId)
    }

    function clearEntryTimer(entry) {
      if (entry.timer) {
        clearTimeout(entry.timer)
        entry.timer = null
      }
    }
    function scheduleRepeat(entry) {
      const cfg = eventConfig(entry.kind)
      const max = Math.round(clampNumber(cfg.repeat, 1, 5, 1))
      if (entry.fired >= max) return
      const wait = Math.round(clampNumber(cfg.intervalSec, 3, 120, 10)) * 1000
      entry.timer = setTimeout(() => {
        entry.timer = null
        const live = pendingAlerts.get(entry.key)
        if (!live || live !== entry) return
        if (!eventEnabled(entry.kind)) return
        entry.fired += 1
        entry.at = Date.now()
        ring(entry.kind, entry.body, entry.sessionId)
        publish()
        scheduleRepeat(entry)
      }, wait)
    }

    function raisePendingAlert(key, kind, body, ttlMs, sessionId) {
      const entry = {
        key,
        kind,
        body,
        sessionId: typeof sessionId === 'string' && sessionId ? sessionId : null,
        at: Date.now(),
        fired: 1,
        pending: true,
        timer: null,
        ttlTimer: null,
      }
      pendingAlerts.set(key, entry)
      toastKey = key
      toastDismissed = false
      ring(kind, body, entry.sessionId)
      scheduleRepeat(entry)
      if (ttlMs > 0) {
        entry.ttlTimer = setTimeout(() => dropPendingAlert(key), ttlMs)
      }
      publish()
    }

    function dropPendingAlert(key) {
      const entry = pendingAlerts.get(key)
      if (!entry) return false
      clearEntryTimer(entry)
      if (entry.ttlTimer) {
        clearTimeout(entry.ttlTimer)
        entry.ttlTimer = null
      }
      pendingAlerts.delete(key)
      if (toastKey === key) toastKey = null
      publish()
      return true
    }

    function raiseFlash(kind, body) {
      if (flashTimer) {
        clearTimeout(flashTimer)
        flashTimer = null
      }
      flashAlert = {
        key: 'flash:' + Date.now().toString(36),
        kind,
        body,
        sessionId: null,
        at: Date.now(),
        fired: 1,
        pending: false,
        timer: null,
      }
      toastKey = flashAlert.key
      toastDismissed = false
      ring(kind, body, null)
      publish()
      flashTimer = setTimeout(() => {
        flashTimer = null
        if (flashAlert) {
          flashAlert = null
          publish()
        }
      }, 8000)
    }

    // ========================================================================
    // 观察会话状态:审批 / 提问 / 本轮结束
    // ========================================================================

    /** 最近一次观察到的“会话是否在跑”,用于识别“跑完了”的那一跳。 */
    const runningSince = new Map()
    let firstSnapshotSeen = false

    function interactionKindOf(interaction) {
      if (!interaction || typeof interaction !== 'object') return null
      if (interaction.kind === 'approval') return 'approval'
      if (interaction.kind === 'question' || interaction.kind === 'plan-review') return 'question'
      return null
    }

    function isSubagentSession(sessionId) {
      try {
        const sessions = typeof ctxRef === 'object' && ctxRef !== null ? ctxRef.get && ctxRef.get('sessions') : null
        if (!sessions || !sessions.list) return false
        const row = sessions.list.getSnapshot().byId[sessionId]
        return !!(row && row.subagent)
      } catch {
        return false
      }
    }

    let ctxRef = null

    function syncFromStatus() {
      if (!ctxRef) return
      let status = null
      try {
        const uiSession = ctxRef.uiSession
        if (!uiSession || !uiSession.sessionStatus) return
        status = uiSession.sessionStatus.getSnapshot()
      } catch {
        return
      }
      if (!status || typeof status.forEach !== 'function') return

      const live = new Map()

      status.forEach((state, sessionId) => {
        if (!state || typeof state !== 'object') return
        const kind = interactionKindOf(state.pendingInteraction)
        if (kind) {
          const interaction = state.pendingInteraction
          const key = typeof interaction.key === 'string' && interaction.key ? interaction.key : sessionId + '|' + kind
          live.set(key, { kind, sessionId, body: describeInteraction(kind, interaction) })
        }
        // 本轮结束:上一帧在跑、这一帧不跑。子智能体的轮次不提示(噪音太大)。
        const running = state.running === true
        const since = runningSince.get(sessionId)
        if (running) {
          if (since === undefined) runningSince.set(sessionId, Date.now())
        } else if (since !== undefined) {
          runningSince.delete(sessionId)
          if (firstSnapshotSeen && settings.events.completion.enabled && !isSubagentSession(sessionId)) {
            raiseFlash('completion', COPY.completionFallback)
          }
        }
      })

      if (pendingAlerts.size > 0) {
        for (const key of Array.from(pendingAlerts.keys())) {
          if (!live.has(key)) dropPendingAlert(key)
        }
      }

      if (live.size > 0) {
        for (const [key, info] of live) {
          const existing = pendingAlerts.get(key)
          if (existing) {
            existing.body = info.body
            existing.sessionId = info.sessionId
            continue
          }
          if (!eventEnabled(info.kind)) continue
          raisePendingAlert(key, info.kind, info.body, 0, info.sessionId)
        }
      }

      // 会话被销毁时清掉它的 running 记录,避免内存里留下旧会话
      for (const sessionId of Array.from(runningSince.keys())) {
        if (!status.has(sessionId)) runningSince.delete(sessionId)
      }

      firstSnapshotSeen = true
      publish()
    }

    // ========================================================================
    // 设置读写(React 侧调用)
    // ========================================================================

    function cloneSettings(value) {
      return JSON.parse(JSON.stringify(value))
    }

    let saveFailed = false

    function commitSettings(next) {
      settings = normalizeSettings(next)
      saveFailed = !writeStorage(settings)
      publish()
    }

    function updateSettings(mutator) {
      const draft = cloneSettings(settings)
      try {
        mutator(draft)
      } catch {
        return
      }
      commitSettings(draft)
    }

    function updateEvent(kind, patch) {
      updateSettings((draft) => {
        const target = kind === 'question' || kind === 'completion' ? draft.events[kind] : draft.events.approval
        Object.assign(target, patch)
      })
    }

    function updateNotify(patch) {
      updateSettings((draft) => {
        Object.assign(draft.notify, patch)
      })
    }

    function addCustomSound(name, dataUrl) {
      const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
      updateSettings((draft) => {
        draft.customSounds.push({ id, name, dataUrl })
      })
      return id
    }

    function removeCustomSound(id) {
      updateSettings((draft) => {
        draft.customSounds = draft.customSounds.filter((sound) => sound.id !== id)
        for (const kind of ['approval', 'question', 'completion']) {
          if (draft.events[kind].sound === 'custom:' + id) draft.events[kind].sound = 'preset:chime'
        }
      })
    }

    function resetSettings() {
      commitSettings(defaultSettings())
    }

    function openSettings(next) {
      settingsOpen = next !== false
      publish()
    }

    function dismissToast() {
      toastDismissed = true
      if (flashAlert) flashAlert = null
      publish()
    }

    /**
     * 只探测、不硬读:宿主版本不同,服务可能挂在 reflect / get / 属性三种入口上,
     * 读不到就返回 null,绝不让插件因为缺服务而挂掉。
     */
    function probeService(name) {
      const ctx = ctxRef
      if (!ctx) return null
      try {
        if (ctx.reflect && typeof ctx.reflect.get === 'function') {
          const found = ctx.reflect.get(name)
          if (found !== undefined) return found
        }
      } catch {
        /* 忽略 */
      }
      try {
        if (typeof ctx.get === 'function') {
          const found = ctx.get(name)
          if (found !== undefined) return found
        }
      } catch {
        return null
      }
      try {
        return ctx[name] === undefined ? null : ctx[name]
      } catch {
        return null
      }
    }

    /** 把主视图切到该会话:优先 uiWorkspace.openSession(),新版宿主也认 sessions.open()。 */
    function openSession(sessionId) {
      if (!sessionId) return false
      const workspace = probeService('uiWorkspace')
      if (workspace && typeof workspace.openSession === 'function') {
        try {
          workspace.openSession(sessionId)
          return true
        } catch {
          /* 会话可能已被删除/还没加载,继续尝试下一条路 */
        }
      }
      const sessions = probeService('sessions')
      if (sessions && typeof sessions.open === 'function') {
        try {
          sessions.open(sessionId)
          return true
        } catch {
          /* 同上 */
        }
      }
      return false
    }

    /** 「去处理」:切到审批所属会话;切不动时至少把窗口提到前台。 */
    function focusAlert(alert) {
      const sessionId = alert && typeof alert.sessionId === 'string' ? alert.sessionId : ''
      if (sessionId) openSession(sessionId)
      try {
        window.focus()
      } catch {
        /* 忽略 */
      }
      dismissToast()
    }

    /** 立即演示一次提醒:用于自检,不需要真的触发审批。 */
    function testAlert(kind) {
      const which = kind === 'question' || kind === 'completion' ? kind : 'approval'
      const body = which === 'approval' ? COPY.approvalFallback : which === 'question' ? COPY.questionFallback : COPY.completionFallback
      unlockAudio()
      requestNotificationPermission()
      if (which === 'completion') raiseFlash('completion', body)
      else raisePendingAlert('test:' + Date.now().toString(36), which, body, 12000)
      publish()
    }

    // ========================================================================
    // 样式
    // ========================================================================

    function css() {
      return [
        // 淡蓝色强调色:和页面主题一致(所有提醒界面共用同一组变量,带兜底色)
        '.daa-toast,.daa-modal,.daa-card{--daa-accent:#4d8dff;--daa-accent-hover:#3d7df5;',
        '--daa-accent-soft:rgba(77,141,255,.14);--daa-accent-border:rgba(77,141,255,.42)}',
        '.daa-toast{position:fixed;right:16px;bottom:16px;z-index:2147482000;width:340px;max-width:calc(100vw - 32px);',
        'border-radius:16px;padding:14px 14px 12px;box-sizing:border-box;',
        'background:var(--dsw-specific-input-major,#1e2126);color:var(--dsw-alias-label-primary,#e9eaec);',
        'border:1px solid var(--daa-accent-border,rgba(77,141,255,.42));',
        'box-shadow:0 12px 32px rgba(0,0,0,.32);font-size:13px;line-height:1.5;',
        'animation:daa-in .16s ease-out}',
        '.daa-toast[data-kind="completion"]{border-color:var(--dsw-alias-divider,rgba(127,127,127,.35))}',
        '.daa-toast-head{display:flex;align-items:center;gap:8px;font-weight:600;font-size:13px;margin-bottom:4px}',
        '.daa-dot{width:8px;height:8px;border-radius:50%;background:var(--daa-accent,#4d8dff);flex:0 0 auto}',
        '.daa-toast[data-kind="completion"] .daa-dot{background:var(--dsw-alias-label-tertiary,#a7abb0)}',
        '.daa-toast-body{color:var(--dsw-alias-label-tertiary,#a7abb0);word-break:break-word;max-height:120px;overflow:auto}',
        '.daa-toast-foot{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:10px}',
        '.daa-btn{appearance:none;border:1px solid var(--dsw-alias-divider,rgba(127,127,127,.35));background:transparent;',
        'color:inherit;font:inherit;padding:5px 12px;border-radius:999px;cursor:pointer;transition:background .12s,color .12s}',
        '.daa-btn:hover{background:rgba(127,127,127,.14)}',
        '.daa-btn[data-primary="1"]{background:var(--daa-accent,#4d8dff);border-color:transparent;color:#fff;font-weight:600}',
        '.daa-btn[data-primary="1"]:hover{background:var(--daa-accent-hover,#3d7df5)}',
        '.daa-btn[data-ghost="1"]{border-color:transparent;background:transparent;color:var(--dsw-alias-label-tertiary,#a7abb0);padding:5px 8px}',
        '.daa-btn[data-ghost="1"]:hover{background:var(--daa-accent-soft,rgba(77,141,255,.14));color:var(--daa-accent,#4d8dff)}',
        '.daa-modal{position:fixed;inset:0;z-index:2147482100;display:flex;align-items:center;justify-content:center;',
        'background:rgba(0,0,0,.42);padding:24px;animation:daa-fade .12s ease-out}',
        '.daa-card{width:min(640px,100%);max-height:min(82vh,760px);display:flex;flex-direction:column;border-radius:18px;',
        'background:var(--dsw-specific-input-major,#1e2126);color:var(--dsw-alias-label-primary,#e9eaec);',
        'border:1px solid var(--daa-accent-border,rgba(77,141,255,.42));box-shadow:0 24px 64px rgba(0,0,0,.42)}',
        '.daa-card-head{display:flex;align-items:flex-start;gap:12px;padding:18px 20px 12px;border-bottom:1px solid var(--dsw-alias-divider,rgba(127,127,127,.22))}',
        '.daa-card-title{font-size:15px;font-weight:600}',
        '.daa-card-sub{font-size:12px;color:var(--dsw-alias-label-tertiary,#a7abb0);margin-top:4px;line-height:1.5}',
        '.daa-close{margin-left:auto;appearance:none;border:0;background:transparent;color:inherit;cursor:pointer;font-size:18px;line-height:1;opacity:.6;padding:2px 4px}',
        '.daa-close:hover{opacity:1}',
        '.daa-body{padding:8px 20px 20px;overflow:auto}',
        '.daa-section{margin-top:16px}',
        '.daa-section-title{font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#a7abb0);margin-bottom:8px}',
        '.daa-row{display:flex;align-items:center;gap:12px;padding:7px 0;min-height:30px}',
        '.daa-row-label{flex:1 1 auto;min-width:0}',
        '.daa-row-label b{font-weight:600;font-size:13px}',
        '.daa-hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#a7abb0);line-height:1.45;margin-top:2px}',
        '.daa-switch{flex:0 0 auto;width:38px;height:22px;border-radius:999px;border:1px solid var(--dsw-alias-divider,rgba(127,127,127,.4));',
        'background:rgba(127,127,127,.22);position:relative;cursor:pointer;appearance:none;padding:0;transition:background .14s}',
        '.daa-switch[data-on="1"]{background:var(--daa-accent,#4d8dff);border-color:transparent}',
        '.daa-switch span{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .14s;display:block}',
        '.daa-switch[data-on="1"] span{transform:translateX(16px)}',
        '.daa-field{display:flex;align-items:center;gap:8px;flex:0 0 auto}',
        '.daa-select{appearance:none;background:var(--dsw-alias-bg-secondary,rgba(127,127,127,.14));color:inherit;border:1px solid var(--dsw-alias-divider,rgba(127,127,127,.35));',
        'border-radius:8px;padding:4px 8px;font:inherit;font-size:12px;max-width:190px}',
        '.daa-input{width:64px;background:var(--dsw-alias-bg-secondary,rgba(127,127,127,.14));color:inherit;border:1px solid var(--dsw-alias-divider,rgba(127,127,127,.35));',
        'border-radius:8px;padding:4px 6px;font:inherit;font-size:12px;text-align:center}',
        '.daa-range{width:120px;accent-color:var(--daa-accent,#4d8dff)}',
        '.daa-value{font-size:12px;color:var(--dsw-alias-label-tertiary,#a7abb0);min-width:38px;text-align:right}',
        '.daa-list{display:flex;flex-direction:column;gap:6px}',
        '.daa-item{display:flex;align-items:center;gap:8px;font-size:12px;padding:6px 8px;border-radius:8px;background:rgba(127,127,127,.1)}',
        '.daa-item-name{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.daa-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:18px;padding-top:14px;border-top:1px solid var(--dsw-alias-divider,rgba(127,127,127,.22))}',
        '.daa-about{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#a7abb0);line-height:1.5;margin-top:12px}',
        '.daa-embedded{padding:0}',
        '@keyframes daa-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}',
        '@keyframes daa-fade{from{opacity:0}to{opacity:1}}',
      ].join('')
    }

    function injectStyles() {
      try {
        if (document.querySelector('style[data-plugin-css="' + CSS_ID + '"]') !== null) return
        const tag = document.createElement('style')
        tag.dataset.plugin = PKG
        tag.dataset.pluginCss = CSS_ID
        tag.textContent = css()
        document.head.appendChild(tag)
      } catch {
        /* 忽略 */
      }
    }

    // ========================================================================
    // React 组件
    // ========================================================================

    function useStoreState() {
      const [state, setState] = React.useState(getSnapshot())
      React.useEffect(() => subscribe(() => setState(getSnapshot())), [])
      return state
    }

    function Switch(props) {
      const on = props.checked === true
      return h('button', {
        type: 'button',
        className: 'daa-switch',
        'data-on': on ? '1' : '0',
        role: 'switch',
        'aria-checked': on ? 'true' : 'false',
        title: props.title || undefined,
        onClick: () => props.onChange(!on),
      }, h('span', null))
    }

    function Row(props) {
      return h(
        'div',
        { className: 'daa-row' },
        h('div', { className: 'daa-row-label' }, h('b', null, props.label), props.hint ? h('div', { className: 'daa-hint' }, props.hint) : null),
        props.children,
      )
    }

    function Section(props) {
      return h(
        'div',
        { className: 'daa-section' },
        h('div', { className: 'daa-section-title' }, props.title),
        props.children,
      )
    }

    function soundOptions(customSounds) {
      const options = [{ value: 'none', label: COPY.silent }]
      for (const preset of PRESETS) options.push({ value: 'preset:' + preset.id, label: L(preset.zh, preset.en) })
      for (const sound of customSounds) options.push({ value: 'custom:' + sound.id, label: L('自定义: ', 'Custom: ') + sound.name })
      return options
    }

    function SoundRow(props) {
      const cfg = props.config
      const options = soundOptions(props.customSounds)
      const known = options.some((option) => option.value === cfg.sound)
      return h(
        Row,
        { label: props.label, hint: props.hint },
        h(
          'div',
          { className: 'daa-field' },
          h(
            'select',
            {
              className: 'daa-select',
              value: known ? cfg.sound : 'preset:chime',
              onChange: (event) => props.onEventChange({ sound: event.target.value }),
              title: COPY.sound,
            },
            options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
          ),
          h('button', {
            type: 'button',
            className: 'daa-btn',
            onClick: () => {
              unlockAudio()
              playSelection(cfg.sound, cfg.volume)
            },
          }, COPY.preview),
        ),
      )
    }

    function VolumeRow(props) {
      const percent = Math.round(props.config.volume * 100)
      return h(
        Row,
        { label: COPY.volume },
        h(
          'div',
          { className: 'daa-field' },
          h('input', {
            className: 'daa-range',
            type: 'range',
            min: 0,
            max: 100,
            step: 5,
            value: percent,
            onChange: (event) => props.onEventChange({ volume: Number(event.target.value) / 100 }),
            onMouseUp: () => playSelection(props.config.sound, props.config.volume),
          }),
          h('div', { className: 'daa-value' }, percent + '%'),
        ),
      )
    }

    function RepeatRow(props) {
      return h(
        Row,
        { label: COPY.repeat, hint: L('等待一直没人处理时,每隔一段时间再提醒一次。', 'Keep re-alerting while the request stays unanswered.') },
        h(
          'div',
          { className: 'daa-field' },
          h('input', {
            className: 'daa-input',
            type: 'number',
            min: 1,
            max: 5,
            value: props.config.repeat,
            onChange: (event) => props.onEventChange({ repeat: Number(event.target.value) }),
          }),
          h('div', { className: 'daa-value' }, COPY.times),
          h('input', {
            className: 'daa-input',
            type: 'number',
            min: 3,
            max: 120,
            value: props.config.intervalSec,
            onChange: (event) => props.onEventChange({ intervalSec: Number(event.target.value) }),
            title: COPY.interval,
          }),
          h('div', { className: 'daa-value' }, COPY.sec),
        ),
      )
    }

    function EventSection(props) {
      const cfg = props.config
      return h(
        Section,
        { title: props.title },
        h(
          Row,
          { label: props.title },
          h(Switch, {
            checked: cfg.enabled,
            onChange: (on) => props.onEventChange({ enabled: on }),
          }),
        ),
        cfg.enabled
          ? h(
            React.Fragment,
            null,
            h(SoundRow, { config: cfg, label: COPY.sound, customSounds: props.customSounds, onEventChange: props.onEventChange }),
            h(VolumeRow, { config: cfg, onEventChange: props.onEventChange }),
            props.withRepeat ? h(RepeatRow, { config: cfg, onEventChange: props.onEventChange }) : null,
          )
          : null,
      )
    }

    function CustomSoundSection(props) {
      const inputRef = React.useRef(null)
      const [error, setError] = React.useState('')
      const sounds = props.settings.customSounds

      function pick(event) {
        const file = event.target.files && event.target.files[0]
        event.target.value = ''
        if (!file) return
        setError('')
        if (file.size > MAX_CUSTOM_BYTES) {
          setError(COPY.tooLarge)
          return
        }
        const reader = new FileReader()
        reader.onload = () => {
          const dataUrl = typeof reader.result === 'string' ? reader.result : ''
          if (dataUrl.indexOf('data:audio/') !== 0) {
            setError(COPY.badFile)
            return
          }
          const id = addCustomSound(file.name || 'audio', dataUrl)
          if (saveFailed) setError(COPY.saveFailed)
          else playCustom(id, 0.9)
        }
        reader.onerror = () => setError(COPY.badFile)
        try {
          reader.readAsDataURL(file)
        } catch {
          setError(COPY.badFile)
        }
      }

      return h(
        Section,
        { title: COPY.customSection },
        h('div', { className: 'daa-hint', style: { marginBottom: '8px' } }, COPY.customHint),
        sounds.length > 0
          ? h(
            'div',
            { className: 'daa-list' },
            sounds.map((sound) =>
              h(
                'div',
                { className: 'daa-item', key: sound.id },
                h('div', { className: 'daa-item-name', title: sound.name }, sound.name),
                h('button', {
                  type: 'button',
                  className: 'daa-btn',
                  onClick: () => playCustom(sound.id, 0.9),
                }, COPY.preview),
                h('button', {
                  type: 'button',
                  className: 'daa-btn',
                  onClick: () => removeCustomSound(sound.id),
                }, COPY.remove),
              ),
            ),
          )
          : null,
        h(
          'div',
          { style: { marginTop: '8px' } },
          h('input', {
            ref: inputRef,
            type: 'file',
            accept: 'audio/*',
            style: { display: 'none' },
            onChange: pick,
          }),
          h('button', {
            type: 'button',
            className: 'daa-btn',
            onClick: () => {
              unlockAudio()
              if (inputRef.current) inputRef.current.click()
            },
          }, COPY.importSound),
        ),
        error ? h('div', { className: 'daa-hint', style: { color: 'var(--dsw-alias-state-error-primary,#e5484d)' } }, error) : null,
      )
    }

    function permissionText(permission) {
      if (permission === 'granted') return COPY.permissionGranted
      if (permission === 'denied') return COPY.permissionDenied
      if (permission === 'unsupported') return COPY.permissionUnsupported
      return COPY.permissionDefault
    }

    function SettingsForm(props) {
      const state = useStoreState()
      const current = state.settings

      return h(
        'div',
        { className: props.embedded ? 'daa-embedded' : null },
        h(
          Section,
          { title: COPY.general },
          h(
            Row,
            { label: COPY.enabled, hint: COPY.settingsSubtitle },
            h(Switch, {
              checked: current.enabled,
              onChange: (on) => updateSettings((draft) => {
                draft.enabled = on
              }),
            }),
          ),
        ),
        current.enabled
          ? h(
            React.Fragment,
            null,
            h(EventSection, {
              title: COPY.approvalEvent,
              config: current.events.approval,
              customSounds: current.customSounds,
              withRepeat: true,
              onEventChange: (patch) => updateEvent('approval', patch),
            }),
            h(EventSection, {
              title: COPY.questionEvent,
              config: current.events.question,
              customSounds: current.customSounds,
              withRepeat: true,
              onEventChange: (patch) => updateEvent('question', patch),
            }),
            h(EventSection, {
              title: COPY.completionEvent,
              config: current.events.completion,
              customSounds: current.customSounds,
              withRepeat: false,
              onEventChange: (patch) => updateEvent('completion', patch),
            }),
            h(
              Section,
              { title: COPY.notifySection },
              h(
                Row,
                { label: COPY.inAppToast, hint: COPY.inAppToastHint },
                h(Switch, {
                  checked: current.notify.inAppToast,
                  onChange: (on) => updateNotify({ inAppToast: on }),
                }),
              ),
              h(
                Row,
                { label: COPY.backgroundNotification, hint: COPY.backgroundNotificationHint },
                h(Switch, {
                  checked: current.notify.backgroundNotification,
                  onChange: (on) => {
                    if (on) requestNotificationPermission()
                    updateNotify({ backgroundNotification: on })
                  },
                }),
              ),
            ),
            h(CustomSoundSection, { settings: current }),
            h(
              Section,
              { title: COPY.statusSection },
              h(Row, { label: COPY.permission, hint: permissionText(state.permission) }, null),
              h(Row, { label: COPY.audioReady, hint: state.audioUnlocked ? COPY.audioReady : COPY.audioLocked }, null),
            ),
          )
          : null,
        h(
          'div',
          { className: 'daa-actions' },
          h('button', {
            type: 'button',
            className: 'daa-btn',
            'data-primary': '1',
            onClick: () => testAlert('approval'),
          }, COPY.test),
          h('button', {
            type: 'button',
            className: 'daa-btn',
            onClick: () => resetSettings(),
          }, COPY.reset),
        ),
        h('div', { className: 'daa-about' }, COPY.about),
      )
    }
    function Toast(props) {
      const alert = props.alert
      const more = props.more
      return h(
        'div',
        { className: 'daa-toast', 'data-kind': alert.kind, role: 'status', 'aria-live': 'polite' },
        h(
          'div',
          { className: 'daa-toast-head' },
          h('span', { className: 'daa-dot' }),
          h('span', null, titleOf(alert.kind)),
        ),
        h('div', { className: 'daa-toast-body' }, alert.body || COPY.approvalFallback),
        more > 0 ? h('div', { className: 'daa-hint' }, COPY.pendingCount.replace('{n}', String(more))) : null,
        h(
          'div',
          { className: 'daa-toast-foot' },
          h('button', {
            type: 'button',
            className: 'daa-btn',
            'data-ghost': '1',
            title: COPY.settingsTitle,
            onClick: () => {
              unlockAudio()
              openSettings(true)
            },
          }, COPY.settingsShort),
          h('button', { type: 'button', className: 'daa-btn', onClick: dismissToast }, COPY.toastClose),
          h('button', { type: 'button', className: 'daa-btn', 'data-primary': '1', onClick: () => focusAlert(alert) }, COPY.toastAction),
        ),
      )
    }

    function Modal(props) {
      const onClose = props.onClose
      React.useEffect(() => {
        function onKey(event) {
          if (event.key === 'Escape') onClose()
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [onClose])
      return h(
        'div',
        {
          className: 'daa-modal',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) onClose()
          },
        },
        h(
          'div',
          { className: 'daa-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': COPY.settingsTitle },
          h(
            'div',
            { className: 'daa-card-head' },
            h(
              'div',
              null,
              h('div', { className: 'daa-card-title' }, COPY.settingsTitle),
              h('div', { className: 'daa-card-sub' }, COPY.settingsSubtitle),
            ),
            h('button', { type: 'button', className: 'daa-close', onClick: onClose, title: COPY.toastClose, 'aria-label': COPY.toastClose }, '\u00d7'),
          ),
          h('div', { className: 'daa-body' }, h(SettingsForm, null)),
        ),
      )
    }

    function ShellOverlay() {
      const state = useStoreState()
      const alerts = state.alerts
      const toast = state.toast
      const pendingCount = alerts.length
      return h(
        React.Fragment,
        null,
        toast ? h(Toast, { alert: toast, more: Math.max(0, pendingCount - (toast.pending ? 1 : 0)) }) : null,
        state.settingsOpen ? h(Modal, { onClose: () => openSettings(false) }) : null,
      )
    }

    /** 「设置 → 插件 → 本插件」页里的配置卡片(keyed 槽:`plugins.bundle.config`)。 */
    function ConfigPage(ownerProps) {
      const view = ownerProps && typeof ownerProps === 'object' ? ownerProps.view : undefined
      if (view === 'summary') return null
      return h(
        'div',
        { className: 'daa-card', style: { boxShadow: 'none', width: '100%', maxHeight: 'none', background: 'transparent', border: '0' } },
        h('div', { className: 'daa-body', style: { padding: '0' } }, h(SettingsForm, { embedded: true })),
      )
    }

    // ========================================================================
    // 插件入口
    // ========================================================================

    /** 只要 UI 槽与会话状态源;其余能力全部可选、缺了也不影响主功能。 */
    const inject = ['slots', 'uiSession']

    function apply(ctx) {
      ctxRef = ctx
      injectStyles()

      // 会话状态订阅:审批/提问出现 → 提醒;消失 → 收起
      ctx.effect(() => {
        const status = ctx.uiSession ? ctx.uiSession.sessionStatus : null
        if (!status || typeof status.subscribe !== 'function' || typeof status.getSnapshot !== 'function') {
          // 宿主没有这个状态源:交给下面的 approval/request 兜底分支,不在这里炸掉整个插件
          return () => {}
        }
        const unsubscribe = status.subscribe(() => {
          syncFromStatus()
        })
        syncFromStatus()
        return () => {
          unsubscribe()
          for (const entry of pendingAlerts.values()) clearEntryTimer(entry)
          pendingAlerts.clear()
          if (flashTimer) {
            clearTimeout(flashTimer)
            flashTimer = null
          }
          flashAlert = null
          runningSince.clear()
        }
      }, 'dsh-approval-alert: watch session status')

      // 兜底:万一这个宿主版本没有 sessionStatus,就退回 `approval/request` 责任链。
      // 只观听、不拦截 —— 永远把 `next()` 交回去,审批仍然由 DSH 自己的卡片回答。
      ctx.effect(() => {
        const status = ctx.uiSession ? ctx.uiSession.sessionStatus : null
        const hasStatus = !!status && typeof status.subscribe === 'function' && typeof status.getSnapshot === 'function'
        if (hasStatus) return () => {}
        let remote = null
        try {
          remote = typeof ctx.get === 'function' ? ctx.get('remote') : null
        } catch {
          remote = null
        }
        if (!remote || typeof remote.$on !== 'function') return () => {}
        let dispose = null
        try {
          dispose = remote.$on('approval/request', function (request, next) {
            try {
              if (eventEnabled('approval')) {
                const id = request && request.callId ? String(request.callId) : Date.now().toString(36)
                const sessionId = request && typeof request.sessionId === 'string' ? request.sessionId : null
                raisePendingAlert('remote-approval:' + id, 'approval', describeInteraction('approval', request), 30000, sessionId)
              }
            } catch {
              /* 提醒失败绝不影响审批本身 */
            }
            return next()
          })
        } catch (error) {
          console.error('[dsh-approval-alert] approval/request fallback unavailable:', error)
          return () => {}
        }
        return () => {
          if (typeof dispose === 'function') dispose()
        }
      }, 'dsh-approval-alert: approval/request fallback')

      // 手势解锁音频(浏览器要求先有用户手势才允许出声),顺便申请一次通知权限
      ctx.effect(() => {
        const onGesture = () => {
          unlockAudio()
          requestNotificationPermission()
        }
        window.addEventListener('pointerdown', onGesture, { once: true })
        window.addEventListener('keydown', onGesture, { once: true })
        return () => {
          window.removeEventListener('pointerdown', onGesture)
          window.removeEventListener('keydown', onGesture)
        }
      }, 'dsh-approval-alert: unlock audio on first gesture')

      // 应用内浮层:右下角提示 + 设置弹窗
      try {
        ctx.slots.inject('shell.overlay', () => {
          try {
            return ctx.slots.register({
              name: 'shell.overlay',
              id: PKG,
              label: () => PKG,
              order: 50,
            }, ShellOverlay)
          } catch (error) {
            console.error('[dsh-approval-alert] shell.overlay registration failed:', error)
            return undefined
          }
        })
      } catch (error) {
        console.error('[dsh-approval-alert] cannot watch shell.overlay:', error)
      }

      // 设置页:插件自己的配置卡片(宿主版本没有这个槽时自动跳过)。
      // 这是加分项 —— 注册失败不能影响上面的提醒浮层,所以逐层兜错。
      try {
        ctx.slots.inject('plugins.bundle.config', () => {
          try {
            return ctx.slots.register({
              name: 'plugins.bundle.config',
              key: PKG,
            }, ConfigPage)
          } catch (error) {
            console.error('[dsh-approval-alert] plugins.bundle.config registration failed:', error)
            return undefined
          }
        })
      } catch (error) {
        console.error('[dsh-approval-alert] cannot watch plugins.bundle.config:', error)
      }

      // 调试/自检入口:在开发者工具控制台里可以 `__dshApprovalAlert.testAlert()`。
      try {
        window.__dshApprovalAlert = {
          version: 1,
          getSnapshot,
          testAlert,
          openSettings,
          dismissToast,
          play: (selection, volume) => playSelection(selection, volume === undefined ? 0.9 : volume),
          focusAlert,
          describe: () => ({
            focused: appFocused(),
            permission: notificationPermission(),
            audioUnlocked: audioUnlocked === true,
            pending: Array.from(pendingAlerts.keys()),
            sessions: Array.from(pendingAlerts.values()).map((entry) => entry.sessionId).filter(Boolean),
          }),
        }
      } catch {
        /* 只读的 window 上挂不上就算了 */
      }
    }

    return { name: PKG, inject, apply }
  },
})
