#!/usr/bin/env node
/**
 * 自检 —— 证明「照搬过来的协议实现没被改坏，新写的规则层也对」。
 *
 *   node scripts/selftest.mjs
 *
 * 覆盖：
 *   设备指纹（必须与小程序逐字节一致，包括它那个浮点精度行为）
 *   度量公式（Haversine / 配速 / 卡路里 / 时间格式）
 *   轨迹生成（里程命中 ±0.5%、相邻点间距、时间戳递增）
 *   真机算法重放（RunTrack 不丢点）
 *   打卡点判定（ORDERED / ANY）
 *   规则换算（合法区间、违规识别、默认参数）
 *   随机浮动（浮动后仍在规则内）
 *   落盘（写-读一致）
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CORE = path.join(ROOT, 'server', 'core', 'sunshine')
/** Windows 上动态 import 必须用 file:// URL，不能直接给绝对路径 */
const core = (name) => pathToFileURL(path.join(CORE, name)).href

// 落盘测试用独立的临时目录，绝不碰真实的 .data
process.env.SUNSHINE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshine-selftest-'))

const { fnv1a32, getDeviceIdentity, makeDeviceId } = await import(core('device.mjs'))
const { haversineMeters, polylineLengthMeters, formatPace, calcCalories, formatDateTime, formatDuration } = await import(core('metrics.mjs'))
const { generateTrack, verifyTrack, verifyCheckpoints, normalizeRoutePoints, DEFAULT_TRACK_OPTIONS } = await import(core('trackgen.mjs'))
const { simulateTrack } = await import(core('runtrack.mjs'))
const { feasibleDistanceRange, checkAgainstRules, planRun, describeRules, durationWindow, DEFAULT_TARGET_PACE } = await import(core('rules.mjs'))
const { hasRuleFields, deriveRulesFromStandards, resolveRunRules } = await import(core('rules-fallback.mjs'))
const { applyJitter } = await import(core('jitter.mjs'))
const store = await import(core('store.mjs'))

let passed = 0
const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    passed++
  } else {
    failures.push(`${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

function near(a, b, tol) {
  return Math.abs(a - b) <= tol
}

// ---------------------------------------------------------------- 1. 设备指纹

check('fnv1a32 空串', fnv1a32('') === '811c9dc5', fnv1a32(''))
// 注意：这不是教科书版 FNV-1a（原实现没用 Math.imul，乘积超过 2^53 会丢精度），
// 必须原样保留，否则和服务端记录的指纹对不上。
check('fnv1a32 hello（保留原浮点行为）', fnv1a32('hello') === 'a82fb4a1', fnv1a32('hello'))
check('默认设备指纹固定', getDeviceIdentity({}).deviceFingerprint === 'c1ed1c62', getDeviceIdentity({}).deviceFingerprint)
check('指定 deviceId 会被复用', getDeviceIdentity({ deviceId: 'dev_x' }).deviceId === 'dev_x')
check('deviceId 形如 dev_+base36+hex', /^dev_[0-9a-z]+[0-9a-f]{12}$/.test(makeDeviceId()), makeDeviceId())

// ---------------------------------------------------------------- 2. 度量公式

// 某高校操场起点到 100m 外（约 0.0009 纬度）
check('Haversine 100m 量级', near(haversineMeters(30.0000000, 120.0000000, 30.0009000, 120.0000000), 100, 1.5),
  String(haversineMeters(30.0000000, 120.0000000, 30.0009000, 120.0000000)))
check('Haversine 同点为 0', haversineMeters(30.89, 121.88, 30.89, 121.88) === 0)
check('配速 1167s/2km = 9\'43"（客户端算法，向下取整）', formatPace(1167, 2) === '9\'43"', formatPace(1167, 2))
check('卡路里 = floor(60 × km)', calcCalories(2) === 120 && calcCalories(0.35) === 21, `${calcCalories(2)}/${calcCalories(0.35)}`)
check('时间格式本地无时区', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(formatDateTime(new Date('2026-09-19T18:38:00'))),
  formatDateTime(new Date('2026-09-19T18:38:00')))
check('时长格式', formatDuration(480) === '08:00' && formatDuration(3725) === '01:02:05', `${formatDuration(480)}/${formatDuration(3725)}`)

// ---------------------------------------------------------------- 3. 轨迹生成

const CENTER = { latitude: 30.0000000, longitude: 120.0000000 }
const cosLat = Math.cos((CENTER.latitude * Math.PI) / 180)
const loop = []
for (let i = 0; i < 60; i++) {
  const th = (i / 60) * Math.PI * 2
  loop.push({
    latitude: Number((CENTER.latitude + (35 * Math.sin(th)) / 111320).toFixed(7)),
    longitude: Number((CENTER.longitude + (55 * Math.cos(th)) / (111320 * cosLat)).toFixed(7)),
  })
}
const lapMeters = polylineLengthMeters([...loop, loop[0]])
check('合成跑道单圈 250~350m', lapMeters > 250 && lapMeters < 350, lapMeters.toFixed(0))

const track = generateTrack({ route: loop, distanceKm: 2, durationSec: 720, startTime: new Date('2026-09-19T18:38:00') })
const hitRatio = Math.abs(track.stats.actualMeters / 2000 - 1)
check('里程命中目标 ±0.5%', hitRatio < 0.005, `${(hitRatio * 100).toFixed(2)}%`)
check('点数不超过 maxPoints', track.routeData.length <= DEFAULT_TRACK_OPTIONS.maxPoints, String(track.routeData.length))

let minStep = Infinity
let monotonic = true
for (let i = 1; i < track.routeData.length; i++) {
  const a = track.routeData[i - 1]
  const b = track.routeData[i]
  minStep = Math.min(minStep, haversineMeters(a.latitude, a.longitude, b.latitude, b.longitude))
  if (!(b.timestamp > a.timestamp)) monotonic = false
}
check('相邻点间距 > minDistance(6m)', minStep > DEFAULT_TRACK_OPTIONS.minDistance, minStep.toFixed(2))
check('时间戳严格递增', monotonic)
check('轨迹体检无错误项', verifyTrack(track.routeData).every((i) => i.level !== 'error'))

const replay = simulateTrack(track.routeData)
check('RunTrack 重放不丢点', replay.dropped === 0, `入点 ${replay.input} → 接受 ${replay.accepted}`)
/**
 * 重放后的里程会**略短于**轨迹本身的长度：RunTrack 里有个 5 点中值滤波（smooth()），
 * 在圆弧形跑道上会削角。这是小程序算法的真实行为，不是缺陷。
 *
 * 注意由此推出的一条重要结论：**申报给服务端的里程必须用未重放的几何长度**，
 * 否则 2.0km 的目标重放后只剩 1.94km，会掉到学校要求的 2km 以下被判无效。
 * 所以这里断言的是「偏差在削角量级内」，而不是「完全相等」。
 */
const smoothingLoss = Math.abs(replay.totalDistanceMeters / track.stats.actualMeters - 1)
check('重放里程与轨迹长度偏差 < 8%（中值滤波削角）', smoothingLoss < 0.08,
  `${(replay.totalDistanceMeters / 1000).toFixed(3)}km vs ${(track.stats.actualMeters / 1000).toFixed(3)}km（差 ${(smoothingLoss * 100).toFixed(1)}%）`)
check('申报里程取未重放长度，取两位小数后仍满足 minDistance',
  Number((track.stats.actualMeters / 1000).toFixed(2)) >= 2,
  (track.stats.actualMeters / 1000).toFixed(4))

const checkpoints = loop.filter((_, i) => i % 5 === 0).map((p, i) => ({ ...p, seqNo: i, pointName: `点${i}`, startPoint: i === 0 }))
check('打卡点 ORDERED 全中', verifyCheckpoints(track.routeData, checkpoints, { checkpointHitRadiusM: 30, passMode: 'ORDERED' }).passed === checkpoints.length)
check('打卡点 ANY 全中', verifyCheckpoints(track.routeData, checkpoints, { checkpointHitRadiusM: 30, passMode: 'ANY' }).passed === checkpoints.length)
const farAway = [{ latitude: 31.5, longitude: 122.5, pointName: '很远的点' }]
check('离得远的打卡点判不中', verifyCheckpoints(track.routeData, farAway, { checkpointHitRadiusM: 30 }).passed === 0)
check('normalizeRoutePoints 兼容多种形状',
  normalizeRoutePoints([{ lat: 1, lng: 2 }]).length === 1
  && normalizeRoutePoints({ points: [[2, 1]] }).length === 1
  && normalizeRoutePoints([[2, 1]]).length === 1)

// ---------------------------------------------------------------- 4. 规则换算

/** 实测规则（某高校 2026 秋季学期） */
const RULES = { minDistance: 2, minDuration: 480, maxDuration: 1200, minPace: 200, maxPace: 600, semesterName: '2026 秋季学期' }

const range = feasibleDistanceRange(RULES)
check('合法里程下限 = minDistance', range.minKm === 2, String(range.minKm))
check('合法里程上限 = maxDuration/minPace', range.maxKm === 6, String(range.maxKm))
check('推荐上限 = maxDuration/慢跑配速 ≈ 3.3km', range.recommendMaxKm === 3.3, String(range.recommendMaxKm))

const w = durationWindow(RULES, 2)
check('2km 的用时窗口 = 480~1200', w.lo === 480 && w.hi === 1200, `${w.lo}~${w.hi}`)
// 5km：配速下限 200s/km 意味着至少 1000 秒；上限仍是 maxDuration 1200
const w5 = durationWindow(RULES, 5)
check('5km 的用时下限被 minPace 抬起', w5.lo === 1000 && w5.hi === 1200, `${w5.lo}~${w5.hi}`)

check('违规：里程不足', checkAgainstRules(RULES, 1.5, 600).some((i) => i.code === 'minDistance'))
check('违规：用时过短', checkAgainstRules(RULES, 2, 300).some((i) => i.code === 'minDuration'))
check('违规：用时过长', checkAgainstRules(RULES, 2, 1300).some((i) => i.code === 'maxDuration'))
check('违规：配速过快', checkAgainstRules(RULES, 2, 300).some((i) => i.code === 'minDuration' || i.code === 'minPace'))
check('违规：配速过慢', checkAgainstRules(RULES, 2, 1200 + 1).length > 0)
check('2km/12min 合法', checkAgainstRules(RULES, 2, 720).length === 0)
check('违规项带人话说明', checkAgainstRules(RULES, 1.5, 600)[0]?.text?.includes('学校要求'))

const planned = planRun({ rules: RULES })
check('默认参数落在合法区间', checkAgainstRules(RULES, planned.distanceKm, planned.durationSec).length === 0,
  `${planned.distanceKm}km/${planned.durationSec}s`)
check('默认配速取自慢跑（6\'00" 附近）',
  Math.abs(planned.durationSec / planned.distanceKm - DEFAULT_TARGET_PACE) < 40,
  String(Math.round(planned.durationSec / planned.distanceKm)))
check('显式参数优先', planRun({ rules: RULES, distanceKm: 2, durationSec: 700 }).durationSec === 700)

const described = describeRules(RULES)
check('规则能翻译成人话', described.known && described.lines.length >= 3 && described.lines[0].includes('至少'))
check('拿不到规则时不崩', describeRules(null).known === false)

// ---- v30 新增的「当前能不能跑」门禁（runAvailableNow / runUnavailableReason）

const RULES_UNAVAILABLE = { ...RULES, runAvailableNow: false, runUnavailableReason: '当前不在可跑步时间段（测试）' }
check('runAvailableNow=false 会拦住开跑',
  checkAgainstRules(RULES_UNAVAILABLE, 2, 720).some((i) => i.code === 'runUnavailable'))
check('不可跑时说明里带上服务端给的原因',
  checkAgainstRules(RULES_UNAVAILABLE, 2, 720).some((i) => i.text.includes('当前不在可跑步时间段')))
check('字段缺失时不拦（兼容老版本/未配置的学校）',
  !checkAgainstRules(RULES, 2, 720).some((i) => i.code === 'runUnavailable'))
check('runAvailableNow=true 不拦',
  !checkAgainstRules({ ...RULES, runAvailableNow: true }, 2, 720).some((i) => i.code === 'runUnavailable'))
// 后端两种命名风格都要认（小程序用 pickRuleField 同时兼容 camelCase / snake_case）
check('下划线风格 run_available_now 也认',
  checkAgainstRules({ ...RULES, run_available_now: false }, 2, 720).some((i) => i.code === 'runUnavailable'))
check('describeRules 把「当前不可跑步」顶到第一行',
  (describeRules(RULES_UNAVAILABLE).lines[0] || '').includes('当前不可跑步'))
check('可用性字段进入 describeRules 返回值',
  describeRules(RULES_UNAVAILABLE).runAvailable === false
  && describeRules(RULES).runAvailable === null)

// ---- 规则读不到时的兜底（实测 2026-10-07：某高校 /run-rules/current 返回成功但无 data）

check('hasRuleFields：空响应/空对象都算「没下发规则」',
  !hasRuleFields(undefined) && !hasRuleFields(null) && !hasRuleFields({})
  && !hasRuleFields({ minDistance: null }) && hasRuleFields({ minDistance: 2 }))

const DERIVED = deriveRulesFromStandards({
  currentSemesterName: '2026 秋季学期',
  standards: [{ id: 17, label: '有效跑步 >= 22次（按单程标准）', standardType: 'RUN_COUNT_2KM', standardValue: 22, currentValue: 22 }],
})
check('从 RUN_COUNT_2KM 推导出「每次至少 2 公里」', DERIVED?.minDistance === 2, JSON.stringify(DERIVED))
check('推导只给里程下限，不臆造时长/配速',
  DERIVED.minDuration === undefined && DERIVED.maxDuration === undefined
  && DERIVED.minPace === undefined && DERIVED.maxPace === undefined)
check('标准类型不认识就返回 null（不乱猜）',
  deriveRulesFromStandards({ standards: [{ standardType: 'SOMETHING_ELSE' }] }) === null
  && deriveRulesFromStandards({ standards: [] }) === null)

const describedDerived = describeRules(DERIVED, { source: 'stats' })
check('推导出来的规则照样 known=true 并且自报 derived',
  describedDerived.known === true && describedDerived.derived === true && describedDerived.source === 'stats')
check('说明里点明「按达标标准推导」并带达标进度',
  describedDerived.lines[0].includes('达标标准') && describedDerived.lines.join(' ').includes('22/22'))
check('推导后默认规划 2km（不再规划 0.5km 那种不计入有效次数的记录）',
  planRun({ rules: DERIVED }).distanceKm === 2, String(planRun({ rules: DERIVED }).distanceKm))
check('低于推导下限时按 minDistance 报错', checkAgainstRules(DERIVED, 1, 600).some(i => i.code === 'minDistance'))

const describedNone = describeRules(null, { source: 'none' })
check('彻底读不到时说「学校未配置」而不是「接口不可用」',
  describedNone.known === false && /未配置/.test(String(describedNone.reason)), String(describedNone.reason))
check('接口真的报错时把错误原文带出来',
  /超时/.test(String(describeRules(null, { source: 'none', ruleError: '连接超时' }).reason)))

// ---------------------------------------------------------------- 5. 随机浮动

let jitterOk = 0
for (let i = 0; i < 200; i++) {
  const j = applyJitter(2.2, 792, { rules: RULES })
  if (!checkAgainstRules(RULES, j.distanceKm, j.durationSec).length) jitterOk++
  if (i === 0) {
    check('浮动幅度在 ±0.09km 内', Math.abs(j.distanceKm - 2.2) <= 0.09 + 1e-9, String(j.distanceKm))
  }
}
check('200 次浮动全部仍在规则内', jitterOk === 200, `${jitterOk}/200`)

// 目标贴着下限时不允许往下浮：应当仍然返回合法值
const tight = applyJitter(2, 480, { rules: RULES })
check('贴着边界时浮动结果依然合法', checkAgainstRules(RULES, tight.distanceKm, tight.durationSec).length === 0,
  `${tight.distanceKm}km/${tight.durationSec}s`)

// ---------------------------------------------------------------- 5.5 请求签名（v30）

const { signHeaders, canonicalString, requiresRunSign, RUN_SIGN_KEY } = await import(core('request.mjs'))

check('签名只覆盖三个写接口（v30 requiresRunSign 原文）',
  requiresRunSign('POST', '/runs')
  && requiresRunSign('POST', '/runs/sessions/start')
  && requiresRunSign('POST', '/runs/sessions/7/finish')
  && requiresRunSign('post', '/runs/sessions/12/finish')
  && !requiresRunSign('POST', '/runs/sessions/7/cancel')
  && !requiresRunSign('POST', '/runs/sessions/abc/finish')
  && !requiresRunSign('GET', '/runs')
  && !requiresRunSign('POST', '/users/run-settings'))

{
  const c = canonicalString({
    method: 'post', url: '/runs/sessions/start',
    token: 'tok', deviceId: 'dev_x', timestamp: '1770000000',
    nonce: '0123456789abcdef0123456789abcdef', bodyString: '{"a":1}',
  })
  const lines = c.endsWith('\n') ? c.slice(0, -1).split('\n') : []
  check('canonical 是 8 行 + 末尾换行', lines.length === 8 && !c.includes('\r'), JSON.stringify(c))
  check('canonical 前 5 行为字面量且方法大写',
    lines[0] === 'v1' && lines[1] === 'POST' && lines[2] === '/runs/sessions/start'
    && lines[3] === '1770000000' && lines[4] === '0123456789abcdef0123456789abcdef')
  check('canonical 末 3 行是 sha256 hex', lines.slice(5).every((l) => /^[0-9a-f]{64}$/.test(l)))
}

{
  // 固定向量：由 wxapkg-unpack/verify-sign-v30.mjs 用**小程序包自带的 js-sha256** 独立算出。
  // ⚠️ token / deviceId 必须是合成值 —— 这个向量要提交进仓库，不能带任何真实凭证。
  const h = signHeaders({
    method: 'POST', url: '/runs/sessions/start',
    token: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    deviceId: 'dev_synthetic0deadbeefcafe',
    bodyString: '{"runType":"CAMPUS","routeId":2,"startLatitude":31.230416,"startLongitude":121.473701}',
    timestamp: '1770000000',
    nonce: '0123456789abcdef0123456789abcdef',
  })
  check('固定向量与小程序包内 js-sha256 结果一致',
    h['sunshine-run-sign'] === '8bbde8675159c6e26b35ef9d8d918ea9e72440390fa0bec70f4a6635e9d82d29',
    h['sunshine-run-sign'])
  check('三个头名字正确',
    h['sunshine-run-timestamp'] === '1770000000' && h['sunshine-run-nonce'].length === 32)
}

check('密钥是 v30 那把 64 位 hex（未轮换）',
  RUN_SIGN_KEY === '11b88c5d08744fdcba39ae5727fd689c7b08bac9876353e79ec223441fb24ea3')

{
  const args = { method: 'POST', url: '/runs', token: 't', deviceId: 'd', bodyString: '{}' }
  const a = signHeaders(args)
  const b = signHeaders(args)
  check('timestamp 是秒级、nonce 是 32 位小写 hex', /^\d{10}$/.test(a['sunshine-run-timestamp']) && /^[0-9a-f]{32}$/.test(a['sunshine-run-nonce']))
  check('每次请求都换 nonce（签名随之改变）', a['sunshine-run-nonce'] !== b['sunshine-run-nonce'] && a['sunshine-run-sign'] !== b['sunshine-run-sign'])
  const fixed = { ...args, timestamp: '1770000000', nonce: '0'.repeat(32) }
  check('body 文本变了签名必变',
    signHeaders({ ...fixed, bodyString: '{"distance":3}' })['sunshine-run-sign']
    !== signHeaders({ ...fixed, bodyString: '{"distance":3.0}' })['sunshine-run-sign'])
}

// ---------------------------------------------------------------- 6. 落盘

store.setCredentials({ token: 'x'.repeat(20), deviceId: 'dev_test', baseUrl: 'http://example.test' })
check('凭证写-读一致', store.getCredentials()?.deviceId === 'dev_test')
check('凭证默认不返回明文之外的东西', store.getCredentials()?.token?.length === 20)

const cfg = store.setConfig({ mode: 'demo', jitter: false })
check('配置合并而非覆盖', cfg.mode === 'demo' && cfg.jitter === false && cfg.mockPort === 8898)

store.setRunState({ phase: 'waiting', sessionId: 's1' })
check('进行中的状态可落盘', store.getRunState()?.sessionId === 's1')
store.clearRunState()
check('状态可清除', store.getRunState() === null)

store.appendRunLog({ outcome: 'done', routeName: '测试跑道' })
check('日志按时间倒序追加', store.getRunLog()[0]?.routeName === '测试跑道')

check('清除凭证', store.clearCredentials() === true && store.getCredentials() === null)

// ---------------------------------------------------------------- 结果

try {
  fs.rmSync(process.env.SUNSHINE_DATA_DIR, { recursive: true, force: true })
} catch { /* 清理失败无所谓 */ }

console.log(`\n自检：通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过'}`)
if (failures.length) {
  console.log('')
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exit(1)
}
