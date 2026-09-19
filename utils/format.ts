/**
 * 显示用的小格式化函数 —— 只负责把数字变成人话，不含任何业务判断。
 * （服务端那份 metrics.mjs 是协议实现，不能混用：这里的格式只为好看。）
 */

/** 秒 → mm:ss（超过一小时才出现小时位） */
export function formatDuration(totalSeconds?: number | null) {
  if (totalSeconds == null || !Number.isFinite(Number(totalSeconds))) return '—'
  const t = Math.floor(Number(totalSeconds))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `${h > 0 ? `${p2(h)}:` : ''}${p2(m)}:${p2(s)}`
}

/** 秒/公里 → 6'00" */
export function formatPace(durationSeconds?: number | null, distanceKm?: number | null) {
  if (!durationSeconds || !distanceKm || distanceKm <= 0) return '—'
  const perKm = durationSeconds / 60 / distanceKm
  const m = Math.floor(perKm)
  return `${m}'${String(Math.floor(60 * (perKm - m))).padStart(2, '0')}"`
}

export function formatKm(km?: number | null) {
  if (km == null || !Number.isFinite(Number(km))) return '—'
  return `${Number(km).toFixed(2)} km`
}

/** 2026-09-19T18:38:00 → 09-19 18:38 */
export function formatDateTime(value?: string | null) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}
