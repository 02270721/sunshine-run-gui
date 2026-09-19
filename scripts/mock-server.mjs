#!/usr/bin/env node
/**
 * 演练后端 —— 一个本机的迷你「酷动·阳光跑」服务端。
 *
 * 网页上的「演练模式」会自动把它拉起来（不需要手动执行）。
 *
 *   node scripts/mock-server.mjs                 规则与真实后端完全一致（默认）
 *   node scripts/mock-server.mjs --strict        再加点级校验（复算里程 / 查瞬移 / 查时间戳）
 *   node scripts/mock-server.mjs --fast          开发用：把规则压到几十秒，快速验证链路
 *   node scripts/mock-server.mjs --port 8898     指定端口
 *
 * ⚠️ 它**故意**照真实服务端的两条关键行为实现，否则演练会误导人：
 *   1. CAMPUS 的 duration 由「会话创建 → finish」的真实间隔计算，
 *      客户端传的 duration 被忽略（PROTOCOL.md 12.9）。所以演练**也要真等**。
 *   2. 打卡点由服务端按 routeData 复算，不是只信客户端。
 *
 * 结构与 sunshine-run-client/test/mock-server.mjs 一脉相承，
 * 但补上了 /routes/{id} 与 CAMPUS 会话（原版只够跑规则层的用例）。
 */

import http from 'node:http'

// ---------------------------------------------------------------- 参数

const argv = process.argv.slice(2)
const argOf = (name, def) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}
const PORT = Number(argOf('--port', 8898))
/** --fast 只在开发时用：把规则压缩到几十秒，方便快速验证一遍流程 */
const FAST = argv.includes('--fast')
const STRICT = argv.includes('--strict')

/**
 * 规则与真实后端**完全一致**（实测值：某高校 2026 秋季学期）。
 * 演练之所以要照抄真实规则，是因为「演练」的意义就是提前体验真实要求：
 * 至少 2 公里、用时 8~20 分钟、配速 3'20"~10'00"。
 *
 * --fast 会把它压缩成 0.4km / 60~150 秒（配速区间不动），
 * 只用于开发时快速跑一遍链路 —— 网页上的演练模式**不会**用它。
 */
const RULES = FAST
  ? {
      id: 99, schoolId: 1, semesterId: 1, semesterName: '演练学期（快速）', sex: '1',
      minDistance: 0.35, minDuration: 60, maxDuration: 150, minPace: 200, maxPace: 600,
    }
  : {
      id: 11, schoolId: 1, semesterId: 2, semesterName: '2026 秋季学期', sex: '1',
      minDistance: 2, minDuration: 480, maxDuration: 1200, minPace: 200, maxPace: 600,
    }

const USER = {
  id: 1000001, studentId: '2024000001', name: '演练同学', schoolId: 1,
  schoolName: '演练大学', serverUrl: `http://127.0.0.1:${PORT}/sunshine`,
  weight: 70, totalDistance: 0, totalDuration: 0, totalRuns: 0, totalCalories: 0,
}

// ---------------------------------------------------------------- 合成跑道

const CENTER = { latitude: 30.0000000, longitude: 120.0000000 }
const METERS_PER_DEG_LAT = 111320

/** 椭圆跑道：a/b 是米，返回若干经纬度点（GCJ-02 就当它是，演练不关心偏移） */
function makeLoop(aMeters, bMeters, count) {
  const cosLat = Math.cos((CENTER.latitude * Math.PI) / 180)
  const pts = []
  for (let i = 0; i < count; i++) {
    const th = (i / count) * Math.PI * 2
    pts.push({
      latitude: Number((CENTER.latitude + (bMeters * Math.sin(th)) / METERS_PER_DEG_LAT).toFixed(7)),
      longitude: Number((CENTER.longitude + (aMeters * Math.cos(th)) / (METERS_PER_DEG_LAT * cosLat)).toFixed(7)),
    })
  }
  return pts
}

function circleLength(points) {
  const R = 6371e3
  const rad = (d) => (d * Math.PI) / 180
  let total = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    const dLat = rad(b.latitude - a.latitude)
    const dLon = rad(b.longitude - a.longitude)
    const h = Math.sin(dLat / 2) ** 2
      + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2
    total += R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
  }
  return total
}

function makeRoute(id, name, a, b, checkpointCount) {
  const geometry = makeLoop(a, b, 60)
  const step = Math.floor(geometry.length / checkpointCount)
  const checkpoints = []
  for (let i = 0; i < checkpointCount; i++) {
    const p = geometry[i * step]
    checkpoints.push({
      id: id * 100 + i,
      pointName: `打卡点 ${i + 1}`,
      seqNo: i,
      latitude: p.latitude,
      longitude: p.longitude,
      startPoint: i === 0,
    })
  }
  return {
    id,
    name,
    passMode: 'ORDERED',
    checkpointHitRadiusM: 30,
    startAllowedRadiusM: 60,
    checkpoints,
    lapMeters: Math.round(circleLength(geometry)),
    geometry,
  }
}

const ROUTES = [
  makeRoute(1, '演练跑道（标准）', 55, 35, 12),
  makeRoute(2, '演练跑道（小圈）', 40, 25, 8),
  makeRoute(3, '演练跑道（大圈）', 70, 45, 16),
]

// ---------------------------------------------------------------- 校验

function checkRules(p) {
  const d = Number(p.distance)
  const t = Number(p.duration)
  if (!(d > 0)) return '距离非法'
  if (!(t > 0)) return '用时非法'
  if (d < RULES.minDistance) return `里程不足 ${RULES.minDistance}km`
  if (t < RULES.minDuration) return `用时不足 ${RULES.minDuration}s`
  if (t > RULES.maxDuration) return `用时超过 ${RULES.maxDuration}s`
  const pace = t / d
  if (pace < RULES.minPace) return `配速过快 ${pace.toFixed(0)}s/km`
  if (pace > RULES.maxPace) return `配速过慢 ${pace.toFixed(0)}s/km`
  return null
}

function haversine(a, b) {
  const R = 6371e3
  const rad = (d) => (d * Math.PI) / 180
  const dLat = rad(b.latitude - a.latitude)
  const dLon = rad(b.longitude - a.longitude)
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}

/** 点级校验 —— 只在 --strict 下启用 */
function checkRoute(p) {
  const rd = p.routeData
  if (!Array.isArray(rd)) return 'routeData 不是数组'
  if (rd.length === 0) return 'routeData 为空'
  if (rd.length > 1000) return `点数过多 ${rd.length}`

  let prevTs = -Infinity
  for (let i = 0; i < rd.length; i++) {
    const q = rd[i]
    const lat = Number(q.latitude)
    const lng = Number(q.longitude)
    if (!Number.isFinite(lat) || Math.abs(lat) > 90) return `第 ${i} 点纬度非法`
    if (!Number.isFinite(lng) || Math.abs(lng) > 180) return `第 ${i} 点经度非法`
    const ts = Number(q.timestamp)
    if (Number.isFinite(ts) && ts < prevTs) return `第 ${i} 点时间戳回退`
    if (Number.isFinite(ts)) prevTs = ts
    const acc = Number(q.accuracy)
    if (Number.isFinite(acc) && acc > 65) return `第 ${i} 点精度过差 ${acc}m`
  }

  if (rd.length >= 2) {
    let worst = 0
    let real = 0
    for (let i = 1; i < rd.length; i++) {
      const d = haversine(rd[i - 1], rd[i])
      real += d
      worst = Math.max(worst, d)
    }
    if (worst > 180) return `存在 ${worst.toFixed(0)}m 的瞬移段`
    const declared = Number(p.distance)
    if (Math.abs(real / 1000 - declared) / declared > 0.2) {
      return `轨迹实际 ${(real / 1000).toFixed(2)}km 与声明 ${declared}km 相差过大`
    }
  }
  return null
}

/** 打卡点复算 —— 与客户端同一套判定 */
function checkCheckpoints(routeData, checkpoints, hitRadius) {
  const radius = Number(hitRadius) || 30
  const hits = checkpoints.map(() => false)
  let cursor = 0
  for (const p of routeData || []) {
    if (cursor >= checkpoints.length) break
    const cp = checkpoints[cursor]
    if (haversine(p, cp) <= radius) {
      hits[cursor] = true
      cursor++
    }
  }
  return { passed: hits.filter(Boolean).length, total: checkpoints.length }
}

// ---------------------------------------------------------------- 状态

const sessions = new Map()
const records = []
let seq = 1

const p2 = (n) => String(n).padStart(2, '0')
const fmt = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
const fmtDate = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
const paceText = (t, km) => {
  if (!(km > 0)) return '0\'00"'
  const perKm = t / 60 / km
  const m = Math.floor(perKm)
  return `${m}'${String(Math.floor(60 * (perKm - m))).padStart(2, '0')}"`
}

// ---------------------------------------------------------------- HTTP

const ok = (data) => ({ code: 0, message: '', data })
const bad = (message, code = 400) => ({ code, message, data: null })

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const send = (payload) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(payload))
    }
    const path = req.url.split('?')[0]
    const query = Object.fromEntries(new URL(req.url, 'http://x').searchParams)
    const json = () => { try { return JSON.parse(body || '{}') } catch { return {} } }

    if (!req.headers['sunshine-run'] && path !== '/sunshine/auth/check') return send(bad('未授权', 401))

    if (path === '/sunshine/auth/check') return send(ok(true))
    if (path === '/sunshine/users/profile') return send(ok(USER))
    if (path === '/sunshine/users/run-settings') {
      return send(ok({ voiceAutoBroadcast: true, gpsVoiceAlert: false, vibrationFeedback: true }))
    }
    if (path === '/sunshine/run-rules/current') return send(ok(RULES))
    if (path === '/sunshine/stats') {
      const qualified = records.filter((r) => r.status === 1).length
      return send(ok({
        currentSemesterName: RULES.semesterName,
        standards: [{
          id: 14,
          label: '有效跑步 >= 22次（按单程标准）',
          isMet: qualified >= 22,
          details: qualified >= 22 ? '已达标' : `还差 ${22 - qualified} 次`,
          standardType: 'RUN_COUNT_2KM',
          standardValue: 22,
          currentValue: qualified,
        }],
        warningInfo: { show: qualified < 22, title: '未达到目标', description: '继续加油', gap: 22 - qualified },
        weeklyStats: [],
        overviewStats: {
          totalRuns: qualified,
          qualifiedRuns: qualified,
          totalDuration: records.reduce((s, r) => s + (r.duration || 0), 0),
          totalCalories: records.reduce((s, r) => s + (r.calories || 0), 0),
          avgDistance: qualified ? Number((records.reduce((s, r) => s + r.distance, 0) / qualified).toFixed(2)) : 0,
          avgPace: '0\'00"',
        },
      }))
    }

    // ---- 路线
    const routeMatch = path.match(/^\/sunshine\/routes\/(\d+)$/)
    if (routeMatch && req.method === 'GET') {
      const route = ROUTES.find((r) => r.id === Number(routeMatch[1]))
      if (!route) return send(bad('路线不存在或未启用'))
      return send(ok({
        id: route.id,
        name: route.name,
        passMode: route.passMode,
        checkpointHitRadiusM: route.checkpointHitRadiusM,
        startAllowedRadiusM: route.startAllowedRadiusM,
        checkpoints: route.checkpoints,
      }))
    }

    // ---- 记录列表
    if (path === '/sunshine/runs' && req.method === 'GET') {
      const page = Number(query.page || 1)
      const size = Number(query.size || 10)
      const start = (page - 1) * size
      return send(ok({
        records: records.slice(start, start + size),
        total: records.length,
        size,
        current: page,
        pages: Math.max(1, Math.ceil(records.length / size)),
      }))
    }

    // ---- 校园跑：创建会话
    if (path === '/sunshine/runs/sessions/start' && req.method === 'POST') {
      const p = json()
      const route = ROUTES.find((r) => r.id === Number(p.routeId))
      if (!route) return send(bad('路线不存在或未启用'))
      if (p.runType !== 'CAMPUS') return send(bad('演练后端只实现 CAMPUS'))

      const sessionId = `mock-${seq++}`
      sessions.set(sessionId, {
        id: sessionId,
        routeId: route.id,
        route,
        startedAt: Date.now(),
      })
      console.log(`  ${new Date().toLocaleTimeString('zh-CN', { hour12: false })} 会话开始 ${sessionId}  路线「${route.name}」`)
      return send(ok({
        sessionId,
        route: { ...route, checkpoints: undefined, geometry: undefined },
        selectedCheckpoints: route.checkpoints,
      }))
    }

    // ---- 校园跑：提交
    const finishMatch = path.match(/^\/sunshine\/runs\/sessions\/([^/]+)\/finish$/)
    if (finishMatch && req.method === 'POST') {
      const session = sessions.get(finishMatch[1])
      if (!session) return send(bad('会话已失效，请重新开始'))
      const p = json()

      // ★ 关键：服务端自己按会话起止计时，客户端传的 duration 一律忽略
      const elapsed = Math.max(1, Math.round((Date.now() - session.startedAt) / 1000))
      const payload = { ...p, duration: elapsed }

      const err = checkRules(payload) || (STRICT ? checkRoute(payload) : null)
      const cp = checkCheckpoints(p.routeData, session.route.checkpoints, session.route.checkpointHitRadiusM)
      const now = new Date()
      const record = {
        id: 20000 + seq++,
        distance: Number(payload.distance),
        startTime: fmt(new Date(session.startedAt)),
        endTime: fmt(now),
        duration: elapsed,
        pace: paceText(elapsed, Number(payload.distance)),
        calories: Number(payload.calories) || 0,
        status: err || cp.passed < cp.total ? 2 : 1,
        runDate: fmtDate(now),
        runType: 'CAMPUS',
        routeId: session.routeId,
        routeName: session.route.name,
        sessionId: session.id,
        selectedCheckpointCount: cp.total,
        passedCheckpointCount: cp.passed,
        createdAt: new Date().toISOString(),
      }
      if (record.status === 2) {
        record.invalidReason = err
          || `打卡点未全部经过（${cp.passed}/${cp.total}）`
      }
      records.unshift(record)
      sessions.delete(session.id)

      const verdict = record.status === 1 ? '\x1b[32m有效\x1b[0m' : `\x1b[31m无效（${record.invalidReason}）\x1b[0m`
      console.log(`  ${new Date().toLocaleTimeString('zh-CN', { hour12: false })} 提交 ${session.id}  服务端计时 ${elapsed}s  打卡 ${cp.passed}/${cp.total} → ${verdict}`)
      return send(ok(record))
    }

    // ---- 校园跑：撤销
    const cancelMatch = path.match(/^\/sunshine\/runs\/sessions\/([^/]+)\/cancel$/)
    if (cancelMatch && req.method === 'POST') {
      sessions.delete(cancelMatch[1])
      console.log(`  ${new Date().toLocaleTimeString('zh-CN', { hour12: false })} 会话已撤销 ${cancelMatch[1]}`)
      return send(ok(true))
    }

    send(bad(`演练后端未实现：${req.method} ${path}`, 404))
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`
演练后端已启动   http://127.0.0.1:${PORT}/sunshine
规则模式：${FAST ? '\x1b[33m快速（开发用，一次跑步约 2 分钟）\x1b[0m' : STRICT ? '真实规则 + 点级校验' : '真实规则（与学校服务器一致）'}
可用路线：${ROUTES.map((r) => `${r.id} ${r.name}（${r.checkpoints.length} 打卡点 / 单圈 ${r.lapMeters}m）`).join('、')}

在网页上把「演练模式」打开即可，不需要手动跑这个脚本。
Ctrl+C 退出
`)
})
