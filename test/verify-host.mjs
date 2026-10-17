/**
 * dsh-approval-alert —— Host 侧接线校验(需要 DSH 自带的 Electron 运行时)。
 *
 * CLI 不允许直接 `--dump-config` 桌面 profile("managed exclusively by the
 * Electron application"),但桌面宿主自己用的就是 `loadProfileDirectory()`。
 * 这个脚本调用同一组函数,回答两个问题:
 *   1. profile 的 bundle 层能不能被解析(我的 cordis.patch.yml 是否合法、
 *      包是否能从 profile 的 node_modules 解析到);
 *   2. 合成后的配置树里有没有那条 `dsh-approval-alert` 条目。
 *
 * 用法(在仓库根目录):
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & 'D:\Software\dsh\DeepSeek Harness.exe' test\verify-host.mjs
 *   Remove-Item Env:\ELECTRON_RUN_AS_NODE
 */
import path from 'node:path'
import os from 'node:os'

const APP_ASAR = 'D:\\Software\\dsh\\resources\\app.asar'
const RUNTIME_DIR = path.join(APP_ASAR, 'dsh')
const INSTALL_ANCHOR = path.join(RUNTIME_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
const PROFILE_NAME = process.argv[2] || 'desktop'
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PROFILE_DIR = path.join(DSH_HOME, 'profiles', PROFILE_NAME)

const bootUrl = 'file:///' + path.join(RUNTIME_DIR, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js').replace(/\\/g, '/')
const boot = await import(bootUrl)

const profile = boot.loadProfileDirectory('dsh', PROFILE_DIR, INSTALL_ANCHOR)

const skipped = Array.isArray(profile.skippedBundles) ? profile.skippedBundles : []
const mine = profile.layers.find((layer) => layer.packageName === 'dsh-approval-alert')
const mySkip = skipped.find((item) => item.packageName === 'dsh-approval-alert')

console.log('profile        :', PROFILE_DIR)
console.log('bundle layers  :', profile.layers.length + ' loaded, ' + skipped.length + ' skipped')
console.log('my layer       :', mine ? 'LOADED from ' + mine.packageDir : 'NOT LOADED')

if (skipped.length > 0) {
  console.log('skipped bundles:')
  for (const item of skipped) console.log('  ·', item.packageName, '->', item.reason)
}

if (mySkip) {
  console.log('\nFAIL: my bundle was skipped ->', mySkip.reason)
  process.exit(1)
}
if (!mine) {
  console.log('\nFAIL: dsh-approval-alert is not among the profile bundles (check dsh.profile.bundles)')
  process.exit(1)
}

const entries = boot.composeEntries([...profile.layers.flatMap((layer) => layer.patches), ...profile.patches])
const myEntry = entries.find((entry) => entry && entry.id === 'dsh-approval-alert')
const nameMatches = entries.filter((entry) => entry && entry.name === 'dsh-approval-alert')

console.log('composed entries:', entries.length)
console.log('my entry       :', myEntry ? JSON.stringify(myEntry) : 'MISSING')
console.log('name matches   :', nameMatches.length)

if (!myEntry) {
  console.log('\nFAIL: the composed tree has no dsh-approval-alert entry (cordis.patch.yml insert failed)')
  process.exit(1)
}

// 客户端 bundle 必须就在那里,且是加载器认得的工厂
const fs = await import('node:fs')
const clientFile = path.join(mine.packageDir, 'lib', 'client.js')
const clientText = fs.readFileSync(clientFile, 'utf8')
const looksLikeFactory = clientText.includes('__ModuleLoader__.load') && clientText.includes('dsh-approval-alert')
console.log('client bundle  :', clientFile, looksLikeFactory ? '(factory format OK)' : '(UNEXPECTED FORMAT)')

const manifest = JSON.parse(fs.readFileSync(path.join(mine.packageDir, 'package.json'), 'utf8'))
const declaresClient = !!(manifest.dsh && manifest.dsh.client && manifest.dsh.client.platform === 'web')
const exportsClient = !!(manifest.exports && manifest.exports['./client'])
console.log('dsh.client     :', declaresClient ? 'platform=web' : 'MISSING')
console.log('exports ./client:', exportsClient ? 'present' : 'MISSING')

if (!looksLikeFactory || !declaresClient || !exportsClient) {
  console.log('\nFAIL: client-side declaration is incomplete')
  process.exit(1)
}

console.log('\nOK: host-side composition is wired.')
