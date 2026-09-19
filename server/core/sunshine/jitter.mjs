/**
 * 随机浮动 —— 照 totoro-paradise 的做法：在目标值上叠加范围内**均匀**随机。
 *
 * totoro 原版（src/classes/RunCalculator.ts）：
 *   addDistanceVariation: (rand - 0.5) * 0.18   → ±0.09 km
 *   addSpeedVariation:    (rand - 0.5) * 0.30   → ±0.15 km/h
 *
 * 这里保持同样的公式，但叠加后会**重新校验学校规则**并重试 ——
 * 否则 2km 往下浮 0.09 就掉到 minDistance 以下，白提交一条无效记录。
 *
 * （实现与 sunshine-run-client/src/cli.mjs 的 applyJitter 一致，只是把规则校验换成 rules.mjs 里的版本。）
 */

import { checkAgainstRules } from './rules.mjs'

/**
 * @param {number} distanceKm
 * @param {number} durationSec
 * @param {{distJitterKm?:number, speedJitterKmh?:number, rules?:object|null}} [opts]
 * @returns {{distanceKm:number, durationSec:number, speedKmh:number, baseSpeedKmh:number}}
 */
export function applyJitter(distanceKm, durationSec, opts = {}) {
  const distJitterKm = opts.distJitterKm ?? 0.09
  const speedJitterKmh = opts.speedJitterKmh ?? 0.15
  const rules = opts.rules ?? null

  const baseSpeedKmh = distanceKm / (durationSec / 3600)
  const rnd = (j) => (Math.random() - 0.5) * 2 * j

  for (let attempt = 0; attempt < 300; attempt++) {
    const d = Number((distanceKm + rnd(distJitterKm)).toFixed(2))
    const s = Number((baseSpeedKmh + rnd(speedJitterKmh)).toFixed(2))
    if (!(d > 0) || !(s > 0)) continue
    const t = Math.round((d / s) * 3600)
    if (t <= 0) continue
    if (!checkAgainstRules(rules, d, t).length) {
      return { distanceKm: d, durationSec: t, speedKmh: s, baseSpeedKmh }
    }
  }
  // 重试全失败（目标本身贴着边界）→ 原样返回，绝不硬塞一个越界值
  return { distanceKm, durationSec, speedKmh: baseSpeedKmh, baseSpeedKmh }
}
