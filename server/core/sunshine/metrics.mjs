/**
 * 度量换算 —— 对照 app-service.js 里跑步页的 updateMetrics / calculateDistanceMeters。
 *
 * 关键点：
 *   1. 距离用标准 Haversine，R = 6371e3
 *   2. pace 是 `分'秒"` 形式（注意结尾是双引号），例如 5'30"
 *   3. calories = floor(60 * 距离km) —— 就是这么简单，没有 MET、没有体重
 *   4. startTime / endTime 是 **本地时间** 的 `YYYY-MM-DDTHH:mm:ss`，不带时区、不带毫秒
 */

export const EARTH_RADIUS_M = 6371e3;

/** 对照 calculateDistanceMeters：Haversine，输入顺序 (lat1, lon1, lat2, lon2) */
export function haversineMeters(lat1, lon1, lat2, lon2) {
  const i = Number(lat1), s = Number(lon1), r = Number(lat2), o = Number(lon2);
  if (![i, s, r, o].every(Number.isFinite)) return NaN;
  const dLat = ((r - i) * Math.PI) / 180;
  const dLon = ((o - s) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((i * Math.PI) / 180) * Math.cos((r * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_M * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

/** 折线总长（米） */
export function polylineLengthMeters(points) {
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += haversineMeters(
      points[i].latitude, points[i].longitude,
      points[i + 1].latitude, points[i + 1].longitude,
    );
  }
  return total;
}

/** 对照 updateMetrics 的配速格式：i = (duration/60)/distanceKm → 分'秒" */
export function formatPace(durationSeconds, distanceKm) {
  if (!(distanceKm > 0)) return `0'00"`;
  const minPerKm = durationSeconds / 60 / distanceKm;
  const m = Math.floor(minPerKm);
  const s = Math.floor(60 * (minPerKm - m));
  return `${m}'${String(s).padStart(2, '0')}"`;
}

/** 对照 updateMetrics：Math.floor(60 * 距离km) */
export function calcCalories(distanceKm) {
  return Math.floor(60 * distanceKm);
}

const p2 = (n) => String(n).padStart(2, '0');

/** 对照跑步页的 formatDateTime：本地时间 YYYY-MM-DDTHH:mm:ss */
export function formatDateTime(d) {
  const t = d instanceof Date ? d : new Date(d);
  return (
    `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())}` +
    `T${p2(t.getHours())}:${p2(t.getMinutes())}:${p2(t.getSeconds())}`
  );
}

/** 对照 formatTime：秒 → HH:mm:ss（小时数 >0 才出现） */
export function formatDuration(totalSeconds) {
  const t = Math.floor(totalSeconds);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return `${h > 0 ? `${p2(h)}:` : ''}${p2(m)}:${p2(s)}`;
}

/** 距离展示：<1km 显示米 —— 仅供日志可读性 */
export function formatMeters(m) {
  const n = Number(m);
  if (!Number.isFinite(n) || n < 0) return '--';
  return n < 1000 ? `${Math.round(n)}m` : `${(n / 1000).toFixed(2)}km`;
}
