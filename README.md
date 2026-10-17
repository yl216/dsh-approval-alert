# dsh-approval-alert · DSH 审批提醒

DSH 需要你审批/回答时,如果你的人不在这个窗口前,它会一直干等。
这个插件把"它在等你"变成听得见、看得见的提醒:

| 你的焦点在哪 | 会发生什么 |
| --- | --- |
| **在 DSH 上** | 只响提示音(审批卡片本来就在你眼前)。 |
| **不在 DSH 上**(切到别的应用、最小化) | 提示音 **+ 屏幕右下角的系统通知** **+** 应用内右下角浮层;任务栏图标带数字角标。 |

声音可以按事件分别选择(8 种内置音效 + 自己导入的音频)、调音量、设定重复提醒的次数与间隔;
审批、提问/计划评审、任务完成三类事件各有开关。

---

## 安装

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

安装脚本会做三件事(幂等,可重复运行):

1. 在 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 的 `dependencies` 里加
   `"dsh-approval-alert": "link:<本目录>"`;
2. 把 `dsh-approval-alert` 追加进同文件的 `dsh.profile.bundles`;
3. 在 profile 的 `node_modules` 下建一个指向本目录的目录联接。

然后 **完全退出并重新启动 DeepSeek Harness**(只刷新网页不够:插件的浏览器 bundle 在启动时进入加载图)。

> 想装进 `web` profile 用 `-Profile web`;想走官方 pnpm 流程(顺便维护
> `pnpm-lock.yaml`)在 DSH 完全退出后加 `-UsePnpm`。

卸载:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1
```

## 用起来

启动后:

- **右下角浮层** —— 有审批时贴在窗口最右下角出现:点「去处理」切回 DSH 窗口,点「设置」打开本插件设置,点「关闭」收起本次浮层。
- **设置 → 插件 → dsh-approval-alert** —— 同样的完整设置页。

> 界面上没有常驻的悬浮按钮:提醒只在真正需要你的时候出现,配色沿用页面的淡蓝色主题色。

设置项一览:

- **总开关**
- **审批提醒** / **提问 / 计划评审提醒**:开关、提示音、音量、重复次数(1–5)、重复间隔(3–120 秒)
- **任务完成提醒**(默认关闭):本轮结束时给一次性提示
- **通知方式**:
  - 焦点不在 DSH 时弹系统通知(默认开)
  - 焦点在 DSH 时也弹系统通知(默认关)
  - 让系统通知自带提示音(默认关 —— 否则会和自定义音效一起响)
  - 应用内右下角浮层(默认开)
- **自定义音效**:导入 wav / mp3 / ogg(≤1.5MB),保存在本机浏览器存储里,可试听、删除,并选给任意事件

## 自检 / 排查

- 设置页里的 **「立即测试」** 立刻演示一次审批提醒(声音 + 通知 + 浮层),不用真的触发审批。
- 开发者工具控制台里也可以:

  ```js
  __dshApprovalAlert.testAlert()      // 演示审批提醒
  __dshApprovalAlert.testAlert('question')
  __dshApprovalAlert.describe()       // 焦点 / 通知权限 / 音频解锁 / 当前挂起的提醒
  __dshApprovalAlert.getSnapshot()    // 完整状态
  ```

- **听不到声音**:浏览器要求先有用户手势才允许出声。在 DSH 里随便点一下/敲一下键就会解锁(设置页的「运行状态」会显示音频是否已就绪)。
- **看不到系统通知**:Windows 的 toast 需要系统通知权限。若被拒绝,插件会安静降级为「提示音 + 应用内浮层 + 任务栏角标」;可在 `设置 → 系统 → 通知` 里给 DeepSeek Harness 打开通知。
- **完全没反应**:确认重启过 DSH,并确认 profile 里确实接好了线:

  ```powershell
  $env:ELECTRON_RUN_AS_NODE='1'
  & 'D:\Software\dsh\DeepSeek Harness.exe' test\verify-host.mjs
  Remove-Item Env:\ELECTRON_RUN_AS_NODE
  ```

  它会打印 profile 的 bundle 层、合成后的配置条目,以及客户端 bundle 的形态。

## 工作原理(给维护者)

- **Host 侧**(`lib/index.js`)是一个空插件。它存在的唯一理由是:只有 Loader 挂载的插件才会被
  `dsh.client` 扫描,从而让浏览器 bundle 进入加载图。
- **浏览器侧**(`lib/client.js`)订阅 `uiSession.sessionStatus`
  (`Map<sessionId, { running, pendingInteraction, completionUnread }>`)。
  审批卡片出现的前提就是某个会话的 `pendingInteraction.kind === 'approval'`,
  所以订阅它 = "审批出现的瞬间",并且 **完全不参与** `approval/request` 责任链 ——
  提醒插件再怎么写坏,也不会让审批无法被回答。
- **声音**:内置音效全部用 Web Audio 现场合成(不随包带音频文件);自定义音效以 data URL
  存在 `localStorage`。
- **系统通知**:渲染进程的 `new Notification(...)`(Electron 里就是 Windows 右下角 toast),
  默认 `silent: true`,由插件自己播自定义音效。
- **持久化**:设置存在 `localStorage['dsh-approval-alert:settings:v1']`,按 schema 归一化
  (越界值、失效的音效引用都会被修正),读失败/写失败都不会让插件中断。
- 依赖极小:`inject = ['slots', 'uiSession']`,只从平台模块表取 `react`,其余是原生 DOM / Web Audio。

## 卸载与回滚

`scripts/uninstall.ps1` 会把三条接线全部撤回(并把原 `package.json` 的备份留在
`package.json.bak`)。插件自己不写任何 Host 侧状态,删掉即干净。

## 已知边界

- 需要重启 DSH 才能生效(新 bundle 进入加载图发生在启动时)。
- 系统通知的最终呈现由 Windows 与 Electron 决定;被系统静音/专注助手拦截时只剩提示音与浮层。
- 任务完成提醒默认关闭:子智能体的一轮结束也会让"正在运行"翻转,默认开着会很吵(代码里已尽量过滤子会话)。
- 手工接线不会更新 `pnpm-lock.yaml`;若之后在插件管理器里增删插件导致 pnpm 重装 profile,
  重跑一次 `scripts/install.ps1` 即可(或用 `-UsePnpm`)。
