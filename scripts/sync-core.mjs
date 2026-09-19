#!/usr/bin/env node
/**
 * 核心同步器 —— 把 sunshine-run-client（协议测试客户端）里**已经核实过**的协议实现，
 * 原样复制到本项目的 `server/core/sunshine/`。
 *
 * 为什么是"复制"而不是"引用"：
 *   本项目的目标是「能整个打包发给同学，解压双击就能用」，
 *   所以它必须自包含，不能依赖 `../sunshine-run-client` 还在原位。
 *
 * 为什么复制不会导致两份代码各自漂移：
 *   这些文件是**生成的**，不是手抄的 —— 想改协议实现，改原项目里的那一份，
 *   然后回这里跑 `pnpm core:sync` 重新生成。`--check` 可以随时验有没有漂移。
 *
 * 用法：
 *   node scripts/sync-core.mjs            同步（默认）
 *   node scripts/sync-core.mjs --check    只检查是否与源一致，不一致退出码 1
 *   SUNSHINE_CORE_SRC=<dir> node scripts/sync-core.mjs   指定源目录
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEST_DIR = path.join(ROOT, 'server', 'core', 'sunshine');
const MANIFEST = path.join(DEST_DIR, 'CORE-VERSION.json');

const SOURCE_DIR = process.env.SUNSHINE_CORE_SRC
  ? path.resolve(process.env.SUNSHINE_CORE_SRC)
  : path.resolve(ROOT, '..', 'sunshine-run-client', 'src');

/** 需要同步的文件 —— 只搬协议实现，不搬 CLI / fuzz / 抓包那一套。 */
const FILES = [
  'request.mjs',   // 请求层：头部注入、响应信封、401/403/502 处理
  'api.mjs',       // 端点封装（32 个，全部已核实）
  'device.mjs',    // 设备身份 + FNV-1a 指纹（原样复刻小程序）
  'metrics.mjs',   // Haversine / 配速 / 卡路里 / 时间格式
  'trackgen.mjs',  // 轨迹生成 + 参数体检 + 打卡点判定 + GCJ-02
  'runtrack.mjs',  // RunTrack 状态机逐句复刻（提交前的重放验证）
];

const CHECK_ONLY = process.argv.includes('--check');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

if (!fs.existsSync(SOURCE_DIR)) {
  console.error(`✗ 找不到源目录：${SOURCE_DIR}`);
  console.error('  用 SUNSHINE_CORE_SRC=<dir> 指定，或确认 sunshine-run-client 与该项目同级。');
  process.exit(2);
}

const results = [];
let drift = 0;

for (const name of FILES) {
  const src = path.join(SOURCE_DIR, name);
  const dst = path.join(DEST_DIR, name);
  if (!fs.existsSync(src)) {
    console.error(`✗ 源文件缺失：${src}`);
    process.exit(2);
  }
  const srcBuf = fs.readFileSync(src);
  const srcHash = sha256(srcBuf);
  const dstHash = fs.existsSync(dst) ? sha256(fs.readFileSync(dst)) : null;

  let status;
  if (dstHash === srcHash) status = '一致';
  else if (dstHash === null) status = '新增';
  else status = '更新';
  if (status !== '一致') drift++;

  if (!CHECK_ONLY && status !== '一致') {
    fs.mkdirSync(DEST_DIR, { recursive: true });
    fs.writeFileSync(dst, srcBuf);
  }
  results.push({ name, status, sha256: srcHash });
}

console.log(`源目录  ${SOURCE_DIR}`);
console.log(`目标    ${DEST_DIR}`);
console.log('');
for (const r of results) console.log(`  ${r.status}  ${r.name.padEnd(14)} ${r.sha256.slice(0, 12)}`);
console.log('');

if (CHECK_ONLY) {
  if (drift) {
    console.error(`✗ 有 ${drift} 个文件与源不一致，跑 pnpm core:sync 同步。`);
    process.exit(1);
  }
  console.log('✓ 核心与源完全一致。');
  process.exit(0);
}

fs.mkdirSync(DEST_DIR, { recursive: true });
fs.writeFileSync(
  MANIFEST,
  `${JSON.stringify(
    {
      note: '本目录由 scripts/sync-core.mjs 生成，请勿手工修改；要改协议实现请改源项目再同步。',
      source: SOURCE_DIR,
      syncedAt: new Date().toISOString(),
      files: Object.fromEntries(results.map((r) => [r.name, r.sha256])),
    },
    null,
    2,
  )}\n`,
);
console.log(`✓ 已同步 ${results.length} 个文件${drift ? `（${drift} 个有更新）` : '（本来就一致）'}`);
console.log(`  清单写入 ${path.relative(ROOT, MANIFEST)}`);
