/**
 * 演练全流程验收脚本（开发用，不随发布包分发）。
 *
 *   node scripts/verify-demo.mjs                 用默认参数（2km / 12:00）
 *   DURATION=480 node scripts/verify-demo.mjs    指定用时（480 = 学校允许的最短用时）
 *
 * 演练模式走的是**和真实完全一样**的校园跑路径，所以这个脚本会**真的等满时间**再提交 ——
 * 任何跳过等待的验证都是假的（服务端按会话起止计时，不等就一定被判无效）。
 */

const BASE = process.env.BASE || 'http://127.0.0.1:2727'
const DURATION = process.env.DURATION ? Number(process.env.DURATION) : null

async function call(path, body) {
  const res = await fetch(`${BASE}${path}`, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : { method: 'GET' })
  const json = await res.json()
  if (!json.ok) throw new Error(`${path} → ${json.error}`)
  return json.data
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const clock = () => new Date().toLocaleTimeString('zh-CN', { hour12: false })

console.log('① 切到演练模式（会顺带拉起本机假后端）')
const cfg = await call('/api/config', { mode: 'demo' })
console.log(`   后端 ${cfg.status.baseUrl}   mock: ${JSON.stringify(cfg.mock)}`)

console.log('\n② 读学校规则（顺便验证中文编码）')
const rules = await call('/api/rules')
console.log(`   ${rules.semesterName} · ${rules.lines[0]}`)
console.log(`   可跑 ${rules.distanceRange.minKm}~${rules.distanceRange.maxKm} km，用时 ${rules.minDurationSec}~${rules.maxDurationSec} 秒`)

console.log('\n③ 扫描路线')
const routes = await call('/api/routes')
for (const r of routes.items) console.log(`   ${r.id}. ${r.name} · ${r.checkpointCount} 打卡点 · 单圈 ${r.lapMeters ?? '-'}m`)
const routeId = routes.items[0].id

console.log('\n④ 预演（POST /api/run/plan，不发写请求）')
const plan = await call('/api/run/plan', { routeId, durationSec: DURATION })
console.log(`   ${plan.distanceKm}km / ${plan.durationSec}s，配速 ${plan.paceText}`)
console.log(`   轨迹 ${plan.track.pointCount} 点 / ${plan.track.laps} 圈；真机算法重放 入${plan.replay.input}→接受${plan.replay.accepted}（丢 ${plan.replay.dropped}）`)
console.log(`   打卡点 ${plan.checkpoints.passed}/${plan.checkpoints.total}（${plan.checkpoints.mode}，半径 ${plan.checkpoints.radius}m）`)
console.log(`   规则校验：${plan.issues.length ? plan.issues.map(i => i.text).join('；') : '通过'}`)
if (!plan.ok) throw new Error('预演未通过，后面的验证没有意义')

console.log(`\n⑤ 真的开始（${clock()}）—— 这次真的要等 ${plan.timing.submitAtText}`)
const started = await call('/api/run/start', { routeId, distanceKm: plan.distanceKm, durationSec: plan.durationSec, jitter: false })
console.log(`   sessionId=${started.sessionId}  phase=${started.phase}`)

/**
 * ⑤.5 提前提交回归探针（EARLY_AT=秒 时启用）。
 *
 * 这条探针守的是一个真踩过的坑：手动提前提交时，上报的 duration 如果还是原目标值，
 * 就会被服务端 v29 对账判「作弊」（实测：提前 71 秒交 → 记录作废且删不掉）。
 * 所以这里强行在不足最低时长时提交一次，必须被拒绝、计时必须继续。
 */
const EARLY_AT = process.env.EARLY_AT ? Number(process.env.EARLY_AT) : null
if (EARLY_AT) {
  console.log(`\n⑤.5 提前提交探针：等到 ${EARLY_AT}s 时强行点一次「提前提交」`)
  for (;;) {
    const st = await call('/api/run/state')
    if ((st.elapsedSec || 0) >= EARLY_AT || st.phase !== 'waiting') break
    await sleep(1000)
  }
  const before = await call('/api/run/state')
  const pv = before.submitPreview
  console.log(`   界面预览：按钮可点=${pv?.allowed} 上报会是 ${pv?.durationText}；不能提交的理由：${(pv?.issues || []).join('；') || '无'}`)
  const res = await fetch(`${BASE}/api/run/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force: false }),
  })
  const json = await res.json()
  const after = await call('/api/run/state')
  console.log(`   强行提交 → ok=${json.ok}  ${json.error || ''}`)
  console.log(`   提交后状态仍是 ${after.phase}（必须是 waiting：被拒绝，且计时没有中断）`)
  if (json.ok) throw new Error('提前提交没有被拒绝 —— 这个缺陷又回来了')
  if (after.phase !== 'waiting') throw new Error(`提前提交把状态改成了 ${after.phase}，会话可能已经脏了`)
}

let last = ''
for (;;) {
  const st = await call('/api/run/state')
  const line = `${st.phase}|${Math.floor((st.elapsedSec || 0) / 60)}`
  if (line !== last) {
    console.log(`   [${clock()}] ${st.phase}  已过 ${st.elapsedText}  剩 ${st.remainingText}`)
    last = line
  }
  if (['done', 'failed', 'cancelled'].includes(st.phase)) {
    console.log('\n⑥ 结果')
    console.log(`   phase=${st.phase}`)
    console.log(`   服务端返回：${JSON.stringify(st.result)}`)
    if (st.error) console.log(`   说明：${st.error}`)
    // 上报用时与服务端计时对不上就会被判作弊 —— 这里把它当成硬性失败
    if (Number(st.result?.status) !== 1) {
      throw new Error(`记录不是有效状态：${st.result?.invalidReason || st.error || '未知原因'}`)
    }
    console.log('\n⑦ 运行日志面板内容（网页上原样显示这些）')
    for (const l of st.log) console.log(`   ${l.t.slice(11, 19)} [${l.level}] ${l.text}`)
    break
  }
  await sleep(5000)
}

console.log('\n⑧ 假后端上的记录')
const rec = await call('/api/records?page=1&size=5')
console.log(`   共 ${rec.total} 条`)
for (const r of rec.records) {
  console.log(`   ${r.runDate} ${r.runType} ${r.distance}km ${r.duration}s ${r.pace} status=${r.status} 打卡 ${r.passedCheckpointCount}/${r.selectedCheckpointCount}`)
}

const stats = await call('/api/stats')
const std = stats.standards?.[0]
console.log(`\n⑨ 达标统计：${std?.label} → ${std?.currentValue}/${std?.standardValue}（${std?.details}）`)

console.log('\n⑩ 本机流水（含失败与被撤销的尝试）')
for (const l of await call('/api/runs-log')) {
  console.log(`   ${l.at.slice(0, 19)} ${l.outcome} ${l.routeName || '-'} ${l.distanceKm ?? '-'}km`)
}

console.log('\n⑪ 诊断（只读）')
const diag = await call('/api/diagnose')
for (const c of diag.checks) console.log(`   ${c.ok ? '✓' : '✗'} ${c.name}`)
console.log(`   数据目录 ${diag.dataDir}`)
console.log('\n切回真实后端：POST /api/config {"mode":"real"}')
