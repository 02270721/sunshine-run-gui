/**
 * 校园跑状态机 —— 本项目唯一会产生真实记录的地方。
 *
 * 为什么要有「状态机」而不是一个函数跑到底：
 *   校园跑的时长**由服务端按会话 start → finish 的真实间隔计算**（PROTOCOL.md 12.9），
 *   客户端传的 duration 会被完全忽略。所以一次校园跑天生横跨 8~20 分钟，
 *   期间用户可能刷新页面、关掉浏览器、甚至关掉整个程序。
 *   把状态落在 .data/state.json，重启后就能接着算 —— 这是 CLI 做不到、
 *   而普通人最容易踩的坑（等一半关了窗口，会话悬挂，记录作废）。
 *
 * 阶段流转：
 *   idle → starting → waiting → submitting → done
 *                        ↓           ↓
 *                    cancelled    failed
 */

import { requireApi, getRules, getRouteDetail, explainError } from './service.mjs'
import { generateTrack, verifyTrack, verifyCheckpoints, normalizeRoutePoints } from './trackgen.mjs'
import { simulateTrack } from './runtrack.mjs'
import {
  polylineLengthMeters, formatPace, calcCalories, formatDateTime, formatDuration, formatMeters,
} from './metrics.mjs'
import { checkAgainstRules, planRun } from './rules.mjs'
import { applyJitter } from './jitter.mjs'
import * as store from './store.mjs'

/**
 * 提交前额外多等的秒数。
 *
 * 实测（2026-09-19，真实账号）：
 *   本机等到 821 秒才提交，服务端记的是 819 秒 —— **服务端会少算约 2 秒**。
 *   原因是我们在发起「创建会话」请求**之前**就开始计时，而服务端是在**收到请求、
 *   真正建好会话**那一刻才开始算，中间的往返与建会话耗时被它吃掉了。
 *
 * 所以这里多等 4 秒：服务端记下来的时长 ≈ 目标 + 2 秒，
 * 既不会掉到 minDuration 下沿，也不会去顶 maxDuration 上沿。
 */
const SUBMIT_MARGIN_SEC = 4
/** 与规则上下限之间保留的安全距离（秒） */
const BOUND_SAFETY_SEC = 3

// ---------------------------------------------------------------- 内存状态

let state = store.getRunState()
let timer = null

function nowIso() {
  return new Date().toISOString()
}

function pushLog(text, level = 'info') {
  if (!state) return
  state.log = state.log || []
  state.log.push({ t: nowIso(), level, text })
  if (state.log.length > 200) state.log = state.log.slice(-200)
}

function persist() {
  if (!state) return
  state.updatedAt = nowIso()
  store.setRunState(state)
}

function activePhases() {
  return ['starting', 'waiting', 'submitting']
}

export function isRunning() {
  return Boolean(state && activePhases().includes(state.phase))
}

/** 给网页看的快照（含实时推算的剩余时间；不含任何凭证） */
export function snapshot() {
  if (!state) return { phase: 'idle' }

  const startedMs = state.sessionStartedAt ? new Date(state.sessionStartedAt).getTime() : null
  const elapsedSec = startedMs ? Math.floor((Date.now() - startedMs) / 1000) : 0
  const waitUntilMs = state.submitAt ? new Date(state.submitAt).getTime() : null
  const remainingSec = waitUntilMs ? Math.max(0, Math.ceil((waitUntilMs - Date.now()) / 1000)) : 0

  return {
    id: state.id,
    phase: state.phase,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    mode: state.mode,
    routeId: state.routeId,
    routeName: state.routeName,
    distanceKm: state.distanceKm,
    durationSec: state.durationSec,
    expectedDurationSec: state.expectedDurationSec,
    requested: state.requested,
    jittered: state.jittered,
    checkpoints: state.checkpoints,
    track: state.track,
    sessionId: state.sessionId,
    sessionStartedAt: state.sessionStartedAt,
    submitAt: state.submitAt,
    elapsedSec,
    remainingSec,
    elapsedText: startedMs ? formatDuration(elapsedSec) : null,
    remainingText: waitUntilMs ? formatDuration(remainingSec) : null,
    result: state.result,
    error: state.error,
    log: state.log || [],
    canSubmitNow: state.phase === 'waiting' || state.phase === 'interrupted',
    canCancel: activePhases().includes(state.phase) || state.phase === 'interrupted',
    /**
     * 「现在点提交会怎么样」的预览 —— 给界面用，免得用户凭感觉点。
     * 提前提交时上报的 duration 是**当前真实经过秒数**（不是原目标值）。
     */
    submitPreview: (state.phase === 'waiting' || state.phase === 'interrupted')
      ? (() => {
          const issues = checkAgainstRules(state.rules || null, state.distanceKm, elapsedSec)
          // 重启时如果连轨迹都没生成完，提交上去只会得到一条删不掉的垃圾记录
          if (!state.payload) issues.unshift({ text: '这次跑步的数据没生成完整，不能提交，只能撤销' })
          return {
            durationSec: elapsedSec,
            durationText: formatDuration(elapsedSec),
            paceText: formatPace(elapsedSec, state.distanceKm),
            allowed: issues.length === 0,
            issues: issues.map((i) => i.text),
            earlierThanTarget: elapsedSec < state.durationSec,
          }
        })()
      : null,
  }
}

// ---------------------------------------------------------------- 定时

function clearTimer() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}

function scheduleSubmit() {
  clearTimer()
  if (!state?.submitAt) return
  const delay = new Date(state.submitAt).getTime() - Date.now()
  // setTimeout 上限约 24.8 天，校园跑远小于它，直接用
  timer = setTimeout(() => {
    timer = null
    submit().catch((e) => {
      if (state) {
        state.phase = 'failed'
        state.error = explainError(e)
        pushLog(`自动提交失败：${state.error}`, 'error')
        persist()
      }
    })
  }, Math.max(0, delay))
  if (typeof timer.unref === 'function') timer.unref()
}

// ---------------------------------------------------------------- 干跑预演

/**
 * 只体检、不创建会话 —— 用户在设置页改参数时实时调它，
 * 好处是：参数不合法、轨迹不过打卡点，都在这时候发现，不会产生任何脏数据。
 */
export async function plan({ routeId, distanceKm, durationSec, jitter = false } = {}) {
  const rules = (await getRules()).raw || null
  const { checkpoints: routeCheckpoints, detail } = await getRouteDetail(routeId)

  const planRes = planRun({ rules, distanceKm, durationSec })
  let d = planRes.distanceKm
  let t = planRes.durationSec

  if (jitter) {
    const j = applyJitter(d, t, { rules })
    d = j.distanceKm
    t = j.durationSec
  }

  const issues = checkAgainstRules(rules, d, t)
  if (issues.length) {
    return { ok: false, issues, distanceKm: d, durationSec: t, route: describeRoute(detail, routeCheckpoints) }
  }

  const routePoints = normalizeRoutePoints(routeCheckpoints)
  const track = generateTrack({ route: routePoints, distanceKm: d, durationSec: t })
  const replay = simulateTrack(track.routeData)
  const cp = verifyCheckpoints(track.routeData, routeCheckpoints, {
    checkpointHitRadiusM: detail?.checkpointHitRadiusM,
    passMode: detail?.passMode,
  })

  return {
    ok: cp.passed === cp.total && replay.dropped === 0,
    issues,
    distanceKm: d,
    durationSec: t,
    paceText: formatPace(t, track.stats.actualMeters / 1000),
    route: describeRoute(detail, routeCheckpoints),
    track: {
      pointCount: track.stats.pointCount,
      actualKm: Number((track.stats.actualMeters / 1000).toFixed(2)),
      laps: track.stats.laps,
      dtSec: Number(track.stats.dtSec.toFixed(1)),
      warnings: track.warnings,
    },
    replay: {
      input: replay.input,
      accepted: replay.accepted,
      dropped: replay.dropped,
      segments: replay.segments,
      meters: Math.round(replay.totalDistanceMeters),
    },
    checkpoints: { total: cp.total, passed: cp.passed, missed: cp.missed, mode: cp.mode, radius: cp.radius },
    timing: describeTiming(t, rules),
    rules,
  }
}

function describeRoute(detail, checkpoints) {
  return {
    id: detail?.id ?? null,
    name: detail?.name ?? null,
    passMode: detail?.passMode ?? 'ORDERED',
    hitRadius: detail?.checkpointHitRadiusM ?? 30,
    startAllowedRadiusM: detail?.startAllowedRadiusM ?? null,
    checkpointCount: checkpoints.length,
    lapMeters: Math.round(polylineLengthMeters(normalizeRoutePoints(checkpoints))),
    points: normalizeRoutePoints(checkpoints).map((p) => [p.latitude, p.longitude]),
  }
}

/**
 * 本次要在「会话开始后第几秒」提交，以及为什么。
 * 使用者看到的是「预计用时 12:02」，而不是一堆秒数。
 */
function describeTiming(durationSec, rules) {
  const minT = rules?.minDuration != null && rules.minDuration !== '' ? Number(rules.minDuration) : null
  const maxT = rules?.maxDuration != null && rules.maxDuration !== '' ? Number(rules.maxDuration) : null

  let submitAt = durationSec + SUBMIT_MARGIN_SEC
  let note = `比目标多等 ${SUBMIT_MARGIN_SEC} 秒，抵消服务端少算的那约 2 秒，让记录时长正好落在目标上`
  if (minT != null && submitAt < minT + BOUND_SAFETY_SEC) {
    submitAt = minT + BOUND_SAFETY_SEC
    note = `太接近学校要求的最短用时，自动延到 ${formatDuration(submitAt)} 再提交`
  }
  if (maxT != null && submitAt > maxT - BOUND_SAFETY_SEC) {
    submitAt = maxT - BOUND_SAFETY_SEC
    note = `太接近学校允许的最长用时，自动提前到 ${formatDuration(submitAt)} 提交`
  }
  return {
    targetSec: durationSec,
    submitAtSec: submitAt,
    submitAtText: formatDuration(submitAt),
    marginSec: SUBMIT_MARGIN_SEC,
    note,
  }
}

// ---------------------------------------------------------------- 真正开跑

/**
 * 创建会话 → 生成轨迹 → 体检 → 进入等待（到点自动提交）。
 * 任何一步失败都会把已经创建的会话撤销掉，不留悬挂 session。
 */
export async function start({ routeId, distanceKm, durationSec, jitter = false } = {}) {
  if (isRunning()) throw new Error('已经有一次校园跑在进行中，先等它结束或撤销')

  const { api, target } = requireApi()
  const rules = (await getRules()).raw || null
  const { checkpoints: routeCheckpoints, detail } = await getRouteDetail(routeId)

  const planRes = planRun({ rules, distanceKm, durationSec })
  let d = planRes.distanceKm
  let t = planRes.durationSec
  const requested = { distanceKm: planRes.distanceKm, durationSec: planRes.durationSec }

  const issues = checkAgainstRules(rules, d, t)
  if (issues.length) {
    const err = new Error(issues.map((i) => i.text).join('；'))
    err.issues = issues
    throw err
  }

  let jittered = false
  if (jitter) {
    const j = applyJitter(d, t, { rules })
    jittered = j.distanceKm !== d || j.durationSec !== t
    d = j.distanceKm
    t = j.durationSec
  }

  const startPoint = routeCheckpoints.find((x) => x.startPoint === true) || routeCheckpoints[0]
  const startLatitude = Number(startPoint?.latitude)
  const startLongitude = Number(startPoint?.longitude)
  if (!Number.isFinite(startLatitude) || !Number.isFinite(startLongitude)) {
    throw new Error('这条路线没有可用的起点坐标')
  }

  // 这一刻就是服务端计时的起点（我们这边略微提前一点，只会让最终用时偏大）
  const sessionStartedAt = new Date()

  state = {
    id: `run_${Date.now().toString(36)}`,
    phase: 'starting',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    mode: target.mode,
    routeId,
    routeName: detail?.name ?? null,
    startLatitude,
    startLongitude,
    distanceKm: Number(d.toFixed(2)),
    durationSec: Math.round(t),
    requested,
    jittered,
    sessionId: null,
    sessionStartedAt: sessionStartedAt.toISOString(),
    submitAt: null,
    expectedDurationSec: null,
    checkpoints: null,
    track: null,
    payload: null,
    result: null,
    error: null,
    log: [],
  }
  pushLog(`开始校园跑：${detail?.name ?? routeId}，目标 ${state.distanceKm}km / ${formatDuration(state.durationSec)}`)
  persist()

  let sessionId = null
  try {
    pushLog('正在创建跑步会话（POST /runs/sessions/start）…')
    const session = await api.startRunSession({
      runType: 'CAMPUS',
      routeId,
      startLatitude,
      startLongitude,
    })
    sessionId = session?.sessionId
    if (!sessionId) throw new Error(`服务端没有返回会话号：${JSON.stringify(session)?.slice(0, 200)}`)
    state.sessionId = sessionId
    pushLog(`会话已创建 sessionId=${sessionId}`)

    // 路线几何优先用服务端随会话下发的（更权威），拿不到就退回路线详情
    const serverRoute = normalizeRoutePoints(session?.route)
    const routePoints = serverRoute.length >= 2 ? serverRoute : normalizeRoutePoints(routeCheckpoints)
    const checkpoints = Array.isArray(session?.selectedCheckpoints) && session.selectedCheckpoints.length
      ? session.selectedCheckpoints
      : routeCheckpoints
    const hitRadius = session?.route?.checkpointHitRadiusM ?? detail?.checkpointHitRadiusM ?? 30
    const passMode = session?.route?.passMode ?? detail?.passMode ?? 'ORDERED'

    pushLog('正在生成轨迹…')
    const track = generateTrack({
      route: routePoints,
      distanceKm: state.distanceKm,
      durationSec: state.durationSec,
      startTime: sessionStartedAt,
    })
    const replay = simulateTrack(track.routeData)
    const cp = verifyCheckpoints(track.routeData, checkpoints, {
      checkpointHitRadiusM: hitRadius,
      passMode,
    })
    const warnings = verifyTrack(track.routeData)

    state.track = {
      pointCount: track.stats.pointCount,
      actualKm: Number((track.stats.actualMeters / 1000).toFixed(2)),
      laps: track.stats.laps,
      dtSec: Number(track.stats.dtSec.toFixed(1)),
      warnings: [...(track.warnings || []), ...warnings.map((w) => w.detail)],
    }
    state.replay = { input: replay.input, accepted: replay.accepted, dropped: replay.dropped, segments: replay.segments }
    state.checkpoints = { total: cp.total, passed: cp.passed, missed: cp.missed, mode: cp.mode, radius: cp.radius }

    pushLog(`轨迹 ${track.stats.pointCount} 点 / ${formatMeters(track.stats.actualMeters)} / ${track.stats.laps} 圈`)
    pushLog(`真机算法重放：入点 ${replay.input} → 接受 ${replay.accepted}${replay.dropped ? `（丢 ${replay.dropped}）` : '（无丢失）'}`, replay.dropped ? 'warn' : 'info')
    pushLog(`打卡点自检 ${cp.passed}/${cp.total}（${cp.mode}，命中半径 ${cp.radius}m）`, cp.passed === cp.total ? 'info' : 'error')

    if (cp.total > 0 && cp.passed < cp.total) {
      throw new Error(`轨迹没有经过全部打卡点（${cp.passed}/${cp.total}），已放弃这次提交`)
    }

    const timing = describeTiming(state.durationSec, rules)
    state.expectedDurationSec = timing.submitAtSec
    state.submitAt = new Date(sessionStartedAt.getTime() + timing.submitAtSec * 1000).toISOString()
    state.payload = {
      distance: Number((track.stats.actualMeters / 1000).toFixed(2)),
      duration: Math.round(state.durationSec),
      pace: formatPace(state.durationSec, track.stats.actualMeters / 1000),
      calories: calcCalories(track.stats.actualMeters / 1000),
      startTime: formatDateTime(track.startTime),
      endTime: formatDateTime(track.endTime),
      routeData: track.routeData,
    }
    state.rules = rules
    state.phase = 'waiting'
    pushLog(`开始计时：到 ${new Date(state.submitAt).toLocaleTimeString('zh-CN', { hour12: false })} 自动提交（${timing.note}）`)
    pushLog('现在可以关闭这个页面，计时在后台继续。', 'warn')
    persist()
    scheduleSubmit()
    return snapshot()
  } catch (e) {
    // 已经建了会话就必须撤销，绝不留下半条脏数据
    if (sessionId) {
      try {
        await api.cancelRunSession(sessionId)
        pushLog(`已撤销会话 ${sessionId}`, 'warn')
      } catch { /* 撤销失败也不能掩盖原始错误 */ }
    }
    state.phase = 'failed'
    state.error = explainError(e)
    pushLog(`失败：${state.error}`, 'error')
    persist()
    logRun('failed')
    throw e
  }
}

// ---------------------------------------------------------------- 提交 / 撤销

/**
 * 按真实经过时间重排轨迹的时间戳。
 *
 * 为什么必须做：轨迹是按**目标时长**生成的，如果提前提交，轨迹里最后几个点的
 * 时间戳会落在"未来"（比提交时刻还晚），而 payload.duration 也还是目标值。
 * 服务端 v29 会拿上报的 duration 和会话真实经过时间对账 —— 对不上就判「作弊」。
 * （实测：上报 926 秒 vs 真实 858 秒 → 作弊；上报 720 vs 真实 724 只差 4 秒 → 有效）
 *
 * 坐标不动（里程因此不变），只把所有时间戳均匀压进 [startTime, startTime + duration]。
 */
function retimeTrack(routeData, startTime, durationSec) {
  if (!Array.isArray(routeData) || routeData.length < 2) return routeData
  const startMs = new Date(startTime).getTime()
  const dt = (durationSec * 1000) / (routeData.length - 1)
  return routeData.map((p, i) => ({
    ...p,
    timestamp: Math.floor(startMs + i * dt),
  }))
}

/**
 * 按**真实经过时间**重建上报数据。
 *
 * 关键：duration 一律用真实经过秒数（不是原目标值）。
 * 服务端 v29 会拿它和会话真实时长对账，两者相差太大会判「作弊」；
 * 用真实值最保险（差值只剩我们这边提前计时的零点几秒）。
 * 坐标不动 → 里程不变；时间戳重排 → 与 duration 自洽。
 */
function buildSubmitPayload(elapsedSec) {
  const p = state.payload || {}
  const distanceKm = Number(p.distance ?? state.distanceKm) || state.distanceKm
  const startTime = p.startTime || state.sessionStartedAt
  return {
    ...p,
    duration: Math.round(elapsedSec),
    distance: Number(Number(distanceKm).toFixed(2)),
    pace: formatPace(elapsedSec, distanceKm),
    calories: calcCalories(distanceKm),
    startTime: formatDateTime(new Date(startTime)),
    endTime: formatDateTime(new Date(new Date(startTime).getTime() + elapsedSec * 1000)),
    routeData: retimeTrack(p.routeData, startTime, elapsedSec),
  }
}

/**
 * 提交（到点自动调用，也可以由用户点「提前提交」触发）。
 *
 * 两条铁律：
 *   1. **上报的 duration 必须等于会话真实经过时间** —— 提前提交时按真实值重算
 *      （duration / pace / calories / 轨迹时间戳），否则会被判「作弊」。
 *   2. 等太久（比如中途电脑休眠）超过 maxDuration → 撤销，而不是白交一条删不掉的无效记录。
 */
export async function submit({ force = false } = {}) {
  if (!state) throw new Error('当前没有进行中的跑步')
  if (!['waiting', 'interrupted'].includes(state.phase)) {
    throw new Error(`当前状态是 ${state.phase}，不能提交`)
  }
  clearTimer()

  const { api } = requireApi()
  const elapsedSec = Math.floor((Date.now() - new Date(state.sessionStartedAt).getTime()) / 1000)
  const rules = state.rules || null
  const issues = checkAgainstRules(rules, state.distanceKm, elapsedSec)

  /**
   * 没有 payload 就绝对不能提交 —— 那说明重启时连轨迹都没生成完，
   * 交上去只会得到一条「协议里没有删除接口」的垃圾记录。
   */
  if (!state.payload) {
    throw new Error('这次跑步的数据没生成完整，不能提交；请点「撤销这次跑步」把它清掉。')
  }

  if (issues.length && !force) {
    const over = issues.some((i) => i.code === 'maxDuration')
    const why = issues.map((i) => i.text).join('；')
    if (over) {
      await cancelRun({ reason: `实际经过 ${formatDuration(elapsedSec)}，${why}，已撤销会话（不会产生无效记录）` })
      const err = new Error(`实际耗时 ${formatDuration(elapsedSec)} 超出学校允许范围，已撤销会话`)
      err.issues = issues
      throw err
    }
    // 太短（提前提交得太多）→ 拒绝，继续等，不要送去被服务端判无效/作弊
    const err = new Error(`现在还只有 ${formatDuration(elapsedSec)}，${why}。建议再等一会儿，或点「撤销这次跑步」。`)
    err.issues = issues
    pushLog(`⛔ 拒绝提前提交：${why}`, 'warn')
    scheduleSubmit() // 继续按原计划等
    throw err
  }

  // ★ 按真实经过时间重建 payload：提前提交时上报值与真实值必须一致
  const payload = buildSubmitPayload(elapsedSec)

  state.phase = 'submitting'
  const early = elapsedSec < state.durationSec
  pushLog(
    `正在提交（实际经过 ${formatDuration(elapsedSec)}` +
    (early ? `，比目标 ${formatDuration(state.durationSec)} 提前，已按真实时长重算上报数据` : '') + '）…',
  )
  persist()

  try {
    const res = await api.finishRunSession(state.sessionId, payload)
    state.result = res
    const ok = res && (res.status === 1 || res.status === '1')
    state.phase = ok ? 'done' : 'failed'
    if (!ok) state.error = res?.invalidReason || '服务端判定这条记录无效'
    pushLog(
      ok
        ? `✓ 提交成功：记录号 ${res.id}，服务端记时 ${formatDuration(res.duration ?? elapsedSec)}`
        : `✗ 服务端判为无效：${state.error}`,
      ok ? 'info' : 'error',
    )
    persist()
    logRun(ok ? 'done' : 'invalid', { result: res, elapsedSec })
    return snapshot()
  } catch (e) {
    state.phase = 'failed'
    state.error = explainError(e)
    pushLog(`提交失败：${state.error}`, 'error')
    persist()
    logRun('failed', { elapsedSec })
    throw e
  }
}

/** 撤销会话 —— 任何时候都可以点，撤销后不会产生任何记录 */
export async function cancelRun({ reason = '用户主动撤销' } = {}) {
  clearTimer()
  if (!state) return { phase: 'idle' }

  const sessionId = state.sessionId
  if (sessionId && ['starting', 'waiting', 'submitting', 'interrupted'].includes(state.phase)) {
    try {
      const { api } = requireApi()
      await api.cancelRunSession(sessionId)
      pushLog(`已撤销会话 ${sessionId}`, 'warn')
    } catch (e) {
      pushLog(`撤销会话失败（可能已失效）：${explainError(e)}`, 'warn')
    }
  }
  state.phase = 'cancelled'
  state.error = reason
  pushLog(reason, 'warn')
  persist()
  logRun('cancelled')
  return snapshot()
}

/** 清空状态，回到可以重新开始的干净状态（不清日志） */
export function reset() {
  clearTimer()
  state = null
  store.clearRunState()
  return { phase: 'idle' }
}

// ---------------------------------------------------------------- 本机日志

function logRun(outcome, extra = {}) {
  try {
    store.appendRunLog({
      runId: state?.id ?? null,
      outcome,
      mode: state?.mode ?? null,
      routeId: state?.routeId ?? null,
      routeName: state?.routeName ?? null,
      distanceKm: state?.distanceKm ?? null,
      durationSec: state?.durationSec ?? null,
      recordId: extra.result?.id ?? state?.result?.id ?? null,
      status: extra.result?.status ?? state?.result?.status ?? null,
      reason: state?.error ?? null,
      elapsedSec: extra.elapsedSec ?? null,
    })
  } catch { /* 日志写不进去不该影响主流程 */ }
}

export function runLog() {
  return store.getRunLog()
}

// ---------------------------------------------------------------- 启动恢复

/**
 * 服务启动时调用：把上次没跑完的状态接回来。
 *
 *   waiting     → 重新挂上定时器，继续等（时间按真实时钟算，机器关机也算在里面）
 *   已超时      → 不能提交了（会超过 maxDuration），交给界面提示「撤销」
 *   其它阶段    → 标记为 interrupted，界面提供「立即提交 / 撤销」两个选择
 */
export function restore() {
  if (!state) return { phase: 'idle' }
  if (state.phase === 'done' || state.phase === 'cancelled' || state.phase === 'failed') {
    return snapshot()
  }

  const elapsedSec = Math.floor((Date.now() - new Date(state.sessionStartedAt).getTime()) / 1000)
  const maxT = state.rules?.maxDuration != null && state.rules.maxDuration !== ''
    ? Number(state.rules.maxDuration)
    : null

  if (state.phase === 'waiting') {
    if (maxT != null && elapsedSec > maxT) {
      state.phase = 'interrupted'
      state.error = `服务中断期间已经过了 ${formatDuration(elapsedSec)}，超过学校上限 ${formatDuration(maxT)}，这条会话提交也会被判无效，建议撤销`
      pushLog('重启后发现已经超时，无法自动提交', 'error')
      persist()
      return snapshot()
    }
    pushLog(`重启后接上未完成的跑步（已过 ${formatDuration(elapsedSec)}），继续计时`)
    persist()
    scheduleSubmit()
    return snapshot()
  }

  const stuckAt = state.phase === 'starting' ? '创建会话' : '提交'
  state.phase = 'interrupted'
  state.error = `服务中断时正在「${stuckAt}」阶段，需要你决定：立即提交，或撤销会话`
  pushLog(`重启后发现中断在「${stuckAt}」阶段的跑步，等待处理`, 'warn')
  persist()
  return snapshot()
}

// 模块加载即尝试恢复（Nitro 服务启动时会执行到这里）
try {
  restore()
} catch { /* 恢复失败不能挡住服务启动 */ }
