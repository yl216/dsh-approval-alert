/**
 * 把 profile/package.json 重新序列化成 DSH 自己的风格(2 空格缩进 + 结尾换行),
 * 让安装脚本改过的清单看起来和 DSH 写的一模一样。
 *
 * 用法:node scripts/normalize-manifest.mjs <源文件> <目标文件>
 */
import fs from 'node:fs'

const [source, target] = process.argv.slice(2)
if (!source || !target) {
  console.error('usage: node normalize-manifest.mjs <source> <target>')
  process.exit(2)
}

const text = fs.readFileSync(source, 'utf8')
let data
try {
  data = JSON.parse(text)
} catch (error) {
  console.error('invalid JSON in ' + source + ': ' + error.message)
  process.exit(1)
}

fs.writeFileSync(target, JSON.stringify(data, null, 2) + '\n', 'utf8')
