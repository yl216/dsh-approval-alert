/**
 * dsh-approval-alert —— Host(Node)侧。
 *
 * 提醒功能全部在浏览器侧(lib/client.js):它通过 `uiSession.sessionStatus`
 * 观察“某个会话正挂着审批/提问”这一状态,再用 Web Audio 与系统通知提醒用户。
 * Host 侧只需要一个能被 Loader 挂载的空插件,`dsh.client` 声明才会进入
 * 客户端的模块加载图。
 *
 * 因此这里不注册任何服务、不监听任何 Host 事件、不读配置、不写文件:
 * 挂载失败的成本为零,卸载后也不留下任何 Host 侧痕迹。
 */

export const name = 'dsh-approval-alert'

/** 空实现:提醒逻辑在 Client 侧。 */
export function apply() {}
