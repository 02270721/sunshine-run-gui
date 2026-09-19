/**
 * 服务端跑步规则 —— 从 sunshine-run-client/src/cli.mjs 的规则相关函数抽出来，
 * 逻辑保持不变，只是把「打印给人看」改成「返回结构化数据」，便于网页渲染。
 *
 * 规则来源：GET /run-rules/current（随学校、学期变化，绝不能写死）。
 * 实测样例（某高校 2026 秋季学期）：
 *   { minDistance: 2, minDuration: 480, maxDuration: 1200, minPace: 200, maxPace: 600 }
 * 换算：至少 2km；用时 8~20 分钟；配速 3'20"~10'00"；速度 6~18km/h。
 * 注意 maxDuration 是最容易被忽略的硬上限：20 分钟 × 18km/h 把里程锁死在 2~6km。
 */

/** 默认目标配速（秒/公里）。360 = 6'00"/km ≈ 10km/h —— 普通慢跑，比取规则窗口中点更像真的。 */
export const DEFAULT_TARGET_PACE = 360

/** 规则里取的数值，空/未定义一律当「无约束」 */
export function ruleNum(v) {
  return v == null || v === '' ? null : Number(v)
}

/** 规则里「时长」对某个里程的可行窗口（秒） */
export function durationWindow(rules, distanceKm) {
  const minT = ruleNum(rules?.minDuration) ?? 0
  const maxT = ruleNum(rules?.maxDuration) ?? Infinity
  const minPace = ruleNum(rules?.minPace) ?? 0
  const maxPace = ruleNum(rules?.maxPace) ?? Infinity
  return {
    lo: Math.max(minT, minPace * distanceKm),
    hi: Math.min(maxT, maxPace * distanceKm),
  }
}

/**
 * 里程已定、只挑用时：优先用真实配速，再夹进规则窗口。
 */
export function pickDurationFor(rules, distanceKm, targetPace = DEFAULT_TARGET_PACE) {
  const w = durationWindow(rules, distanceKm)
  if (!(w.hi > 0 && w.hi >= w.lo)) return Math.round((distanceKm / 8) * 3600)
  const want = targetPace * distanceKm
  return Math.round(Math.min(w.hi, Math.max(w.lo, want)))
}

/**
 * 还能跑多长/多短 —— 这是网页滑杆的取值范围。
 *
 * 推导（两条约束共同决定存在性）：
 *   最快配速 × 里程 ≤ 时长上限  →  里程 ≤ maxDuration / minPace
 *   最慢配速 × 里程 ≥ 时长下限  →  里程 ≥ minDuration / maxPace
 * 再与学校写死的 minDistance 取交集。
 *
 * 另外给一个「推荐上限」：按默认慢跑配速能跑到的最大里程（受 maxDuration 卡死），
 * 这才是普通人实际能选的范围（样例规则下是 3.33km，而不是数学上的 6km）。
 */
export function feasibleDistanceRange(rules, targetPace = DEFAULT_TARGET_PACE) {
  if (!rules) return { minKm: 0.5, maxKm: 20, recommendMaxKm: 20, known: false }

  const minD = ruleNum(rules.minDistance) ?? 0
  const minT = ruleNum(rules.minDuration) ?? 0
  const maxT = ruleNum(rules.maxDuration)
  const minPace = ruleNum(rules.minPace)
  const maxPace = ruleNum(rules.maxPace)

  let lo = minD
  if (maxPace != null && maxPace > 0) lo = Math.max(lo, minT / maxPace)

  let hi = 20
  if (maxT != null && maxT > 0 && minPace != null && minPace > 0) hi = maxT / minPace
  else if (maxT != null && maxT > 0) hi = (maxT / targetPace)

  // 两端各留 0.1km 余量并向外/向内取整，避免滑杆端点恰好踩线被判违规
  const minKm = Math.max(0.1, Math.ceil(lo * 10) / 10)
  const maxKm = Math.max(minKm, Math.floor(hi * 10) / 10)
  // 推荐上限不能低于下限 —— 规则很紧时（比如演练规则）它只是"没有额外建议"而已
  const recommendMaxKm = maxT != null && maxT > 0
    ? Math.min(maxKm, Math.max(minKm, Math.floor((maxT / targetPace) * 10) / 10))
    : maxKm

  return { minKm, maxKm, recommendMaxKm, known: true }
}

/**
 * 逐条比对规则，返回**给人看**的违规说明（空数组 = 通过）。
 * 每条带 code，前端可以据此定位到具体输入框。
 */
export function checkAgainstRules(rules, distanceKm, durationSec) {
  const issues = []
  if (!rules) return issues

  const d = Number(distanceKm)
  const t = Number(durationSec)
  const minD = ruleNum(rules.minDistance)
  const minT = ruleNum(rules.minDuration)
  const maxT = ruleNum(rules.maxDuration)
  const minPace = ruleNum(rules.minPace)
  const maxPace = ruleNum(rules.maxPace)
  const mmss = (s) => `${Math.floor(s / 60)} 分 ${String(Math.round(s % 60)).padStart(2, '0')} 秒`

  if (minD != null && d < minD) {
    issues.push({ code: 'minDistance', text: `里程 ${d.toFixed(2)}km 少于学校要求的 ${minD}km` })
  }
  if (minT != null && t < minT) {
    issues.push({ code: 'minDuration', text: `用时 ${mmss(t)} 短于学校要求的 ${mmss(minT)}` })
  }
  if (maxT != null && t > maxT) {
    issues.push({ code: 'maxDuration', text: `用时 ${mmss(t)} 超过学校上限 ${mmss(maxT)}` })
  }
  if (d > 0 && t > 0) {
    const pace = t / d
    if (minPace != null && pace < minPace) {
      issues.push({
        code: 'minPace',
        text: `配速太快（${(3600 / pace).toFixed(1)}km/h），学校要求不超过 ${(3600 / minPace).toFixed(1)}km/h`,
      })
    }
    if (maxPace != null && pace > maxPace) {
      issues.push({
        code: 'maxPace',
        text: `配速太慢（${(3600 / pace).toFixed(1)}km/h），学校要求不低于 ${(3600 / maxPace).toFixed(1)}km/h`,
      })
    }
  }
  return issues
}

/**
 * 把规则翻译成「大白话」+ 数值，前端只负责排版。
 */
export function describeRules(rules) {
  if (!rules) {
    return { known: false, lines: ['拿不到学校规则（接口不可用或未登录）'], distanceRange: feasibleDistanceRange(null) }
  }
  const minD = ruleNum(rules.minDistance)
  const minT = ruleNum(rules.minDuration)
  const maxT = ruleNum(rules.maxDuration)
  const minPace = ruleNum(rules.minPace)
  const maxPace = ruleNum(rules.maxPace)
  const range = feasibleDistanceRange(rules)

  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
  const lines = []
  if (minD != null) lines.push(`每次至少跑 ${minD} 公里`)
  if (minT != null || maxT != null) {
    lines.push(`用时必须落在 ${minT != null ? mmss(minT) : '?'} ~ ${maxT != null ? mmss(maxT) : '?'} 之间`)
  }
  if (minPace != null && maxPace != null) {
    lines.push(`速度 ${(3600 / maxPace).toFixed(1)} ~ ${(3600 / minPace).toFixed(1)} km/h（不能太快也不能太慢）`)
  }
  lines.push(`能选的距离：${range.minKm.toFixed(1)} ~ ${range.maxKm.toFixed(1)} 公里`)
  if (range.recommendMaxKm < range.maxKm) {
    lines.push(`按正常慢跑配速（${mmss(DEFAULT_TARGET_PACE)}/km），实际最多 ${range.recommendMaxKm.toFixed(1)} 公里`)
  }

  return {
    known: true,
    semesterName: rules.semesterName ?? null,
    schoolId: rules.schoolId ?? null,
    semesterId: rules.semesterId ?? null,
    minDistanceKm: minD,
    minDurationSec: minT,
    maxDurationSec: maxT,
    minPaceSec: minPace,
    maxPaceSec: maxPace,
    speedRangeKmh: minPace != null && maxPace != null
      ? { min: Number((3600 / maxPace).toFixed(1)), max: Number((3600 / minPace).toFixed(1)) }
      : null,
    distanceRange: range,
    lines,
    raw: rules,
  }
}

/**
 * 定参数：显式给了就用用户的；没给就按「刚好达到学校最低要求」来挑 ——
 * 里程取下限（学校要求的最少公里数），用时按正常慢跑配速（6'00"/km）。
 *
 * 为什么默认取最低里程而不是「看起来更漂亮」的 3km：
 *   学期标准是按**有效次数**算的，学校只要求「每次至少 2 公里」，
 *   那 2km / 12 分钟就是最短的合法记录 —— 12 分钟能跑完的事，没必要默认让人等 18 分钟。
 *   想跑远一点，滑杆随时可以往上拖。
 */
export function planRun({ rules, distanceKm, durationSec, targetPace = DEFAULT_TARGET_PACE } = {}) {
  const range = feasibleDistanceRange(rules, targetPace)
  const wantD = distanceKm != null && Number.isFinite(Number(distanceKm)) ? Number(distanceKm) : null
  const d = wantD ?? range.minKm
  const t = durationSec != null && Number.isFinite(Number(durationSec))
    ? Number(durationSec)
    : pickDurationFor(rules, d, targetPace)
  return {
    distanceKm: Number(d.toFixed(2)),
    durationSec: Math.round(t),
    autoPicked: wantD == null || durationSec == null,
    issues: checkAgainstRules(rules, d, t),
  }
}
