/**
 * 轨迹生成 —— 目标是产出"真实小程序会原样接受"的 routeData。
 *
 * 依据来自 app-service.js：
 *   module 776  DEFAULT_TRACK_OPTIONS  —— 客户端 RunTrack 的过滤/抽稀参数（下面原样照抄）
 *   normalizeRouteDataForPersistence   —— 落库时每个点的最终形态：
 *        { latitude: toFixed(6), longitude: toFixed(6),
 *          timestamp: floor(ms), accuracy: toFixed(1) | null, segmentBreak: boolean }
 *   跑步页 fetchCurrentLocation        —— wx.getLocation({ type: "gcj02" })，所以坐标是 **GCJ-02**
 */

import { haversineMeters, polylineLengthMeters } from './metrics.mjs';

/** 原样照抄 module 776 的 DEFAULT_TRACK_OPTIONS */
export const DEFAULT_TRACK_OPTIONS = {
  minDistance: 6,              // 两点最小间距(m)，小于会被去重丢弃
  maxSpeed: 8,                 // 判 HOLD 的速度上限(m/s) ≈ 28.8km/h
  maxSegmentDistance: 180,     // 单段最大跨度(m)
  segmentBreakGapSec: 15,      // 时间间隔超过它 → 判定为分段
  segmentBridgeGapSec: 60,     // 60s 内可桥接
  segmentBridgeMaxDistance: 180,
  segmentBridgeMaxSpeed: 6,
  accuracyTrusted: 20,         // accuracy ≤ 20m 为可信档
  accuracyDegraded: 65,        // ≤ 65m 为降级档，超过则不可靠
  compressionTolerance: 10,    // 抽稀容差(m)
  maxPoints: 500,              // 单次上传最多点数
};

/** 高斯随机（Box-Muller），用于给坐标加自然抖动 */
function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const METERS_PER_DEG_LAT = 111320;

/**
 * 生成**相对偏移量**（单位：米）的一阶自回归随机游走。
 *
 * 真机 GPS 误差是**时间相关**的：相邻采样点的偏移高度相似，而不是每点独立乱跳。
 * 用独立同分布抖动会人为制造"高频抖动"，让相邻点间距忽大忽小 —— 实测会直接触发
 * minDistance(6m) 违规。用随机游走既真实又不会破坏间距。
 *
 * 返回相对偏移（不是绝对坐标），这样外层迭代收缩弧长时偏移才有意义。
 */
const JITTER_RHO = 0.85;

function makeJitterOffsets(sigmaMeters, count, rho = JITTER_RHO) {
  const k = Math.sqrt(1 - rho * rho);
  let dx = 0;
  let dy = 0;
  const out = [];
  for (let i = 0; i < count; i++) {
    if (sigmaMeters > 0) {
      dx = dx * rho + gauss() * sigmaMeters * k;
      dy = dy * rho + gauss() * sigmaMeters * k;
    }
    out.push({ dx, dy });
  }
  return out;
}

/** 把任意形态的路线点数组规整成 [{latitude, longitude}] */
export function normalizeRoutePoints(route) {
  const raw =
    (Array.isArray(route) && route) ||
    (route && (route.points || route.routePoints || route.polyline || route.pointList)) ||
    [];
  return raw
    .map((p) => {
      if (!p) return null;
      if (Array.isArray(p)) return { latitude: Number(p[1]), longitude: Number(p[0]) };
      const latitude = Number(p.latitude ?? p.lat);
      const longitude = Number(p.longitude ?? p.lng ?? p.lon);
      return Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : null;
    })
    .filter(Boolean);
}

/**
 * 在折线上按弧长等距取点。
 * 路线不够长时会**循环复用**（和 totoro 的 generateRoute 同思路）。
 * @returns {{points: {latitude:number,longitude:number}[], laps:number}}
 */
export function resampleAlongRoute(polyline, targetMeters, count) {
  if (polyline.length < 2) throw new Error('路线至少需要 2 个点');
  const routeLen = polylineLengthMeters(polyline);
  if (!(routeLen > 0)) throw new Error('路线长度为 0');

  const laps = Math.max(1, Math.ceil(targetMeters / routeLen));
  const step = targetMeters / (count - 1);

  // 预先算好累计弧长，之后每次取点用二分查找。
  // 注意：不能用一个单调前进的 seg 游标 —— 目标里程超过单圈长度时，弧长会在每圈开头
  // 回绕，游标不会重置，点会全部塌缩到路线末尾（实测实际里程只有目标的 80%）。
  const cum = [0];
  for (let i = 0; i < polyline.length - 1; i++) {
    cum.push(cum[i] + haversineMeters(
      polyline[i].latitude, polyline[i].longitude,
      polyline[i + 1].latitude, polyline[i + 1].longitude,
    ));
  }

  const locate = (d) => {
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= d) lo = mid; else hi = mid;
    }
    return lo;
  };

  const points = [];
  for (let i = 0; i < count; i++) {
    const want = i * step;
    const d = Math.min(routeLen, want - Math.floor(want / routeLen) * routeLen);
    const seg = locate(d);
    const segLen = cum[seg + 1] - cum[seg];
    const t = segLen > 0 ? Math.min(1, Math.max(0, (d - cum[seg]) / segLen)) : 0;
    const a = polyline[seg];
    const b = polyline[seg + 1] || polyline[seg];
    points.push({
      latitude: a.latitude + (b.latitude - a.latitude) * t,
      longitude: a.longitude + (b.longitude - a.longitude) * t,
    });
  }
  return { points, laps };
}

/**
 * 生成一条可提交的 routeData。
 *
 * @param {object} o
 * @param {Array}  o.route          服务端下发的路线点（GCJ-02）
 * @param {number} o.distanceKm     目标里程
 * @param {number} o.durationSec    目标用时（秒）
 * @param {Date}   [o.startTime]    开始时间，默认现在
 * @param {number} [o.jitterMeters] 坐标抖动强度，默认 2.5m
 * @param {number} [o.accuracyMeters] 上报的 accuracy，默认 12
 * @param {object} [o.options]      覆盖 DEFAULT_TRACK_OPTIONS
 * @returns {{routeData: object[], startTime: Date, endTime: Date, stats: object, warnings: string[]}}
 */
export function generateTrack(o) {
  const opts = { ...DEFAULT_TRACK_OPTIONS, ...(o.options || {}) };
  let polyline = normalizeRoutePoints(o.route);
  const targetMeters = o.distanceKm * 1000;
  const durationSec = Math.round(o.durationSec);
  const startTime = o.startTime ? new Date(o.startTime) : new Date();
  const jitterMeters = o.jitterMeters ?? 2.5;
  const accuracy = o.accuracyMeters ?? 12;
  const warnings = [];

  if (polyline.length < 2) throw new Error('路线点不足，无法生成轨迹');
  if (!(o.distanceKm > 0)) throw new Error('distanceKm 必须 > 0');
  if (!(durationSec > 0)) throw new Error('durationSec 必须 > 0');

  // 环形路线自动闭合。
  // 校园跑路线（如操场 391m）的首尾点往往差几十米 —— 里程超过单圈时轨迹会循环，
  // 环回那一刻就是一个"跳跃"，会被 RunTrack 判成瞬移丢掉。补上闭合段即可消除。
  if (o.closeLoop !== false && polyline.length >= 3) {
    const first = polyline[0];
    const last = polyline[polyline.length - 1];
    const gap = haversineMeters(first.latitude, first.longitude, last.latitude, last.longitude);
    if (gap > 1 && gap < 150) {
      polyline = [...polyline, { latitude: first.latitude, longitude: first.longitude }];
    }
  }

  // ---- 选点数：同时满足 minDistance / segmentBreakGapSec / maxPoints ----
  //
  // 注意不能直接用 minDistance 当最小间距：抖动会让相邻点的**相对**位移叠加到间距上，
  // 间距贴着 6m 时随便一点抖动就会掉到 6m 以下，被 RunTrack 判 HOLD 丢掉。
  // 一阶自回归游走每步的相对位移单轴标准差是 sigma*sqrt(2(1-rho))，留 4σ 余量。
  const relStdPerAxis = jitterMeters * Math.sqrt(2 * (1 - JITTER_RHO));
  const minSafeStep = opts.minDistance + 4 * relStdPerAxis * Math.SQRT2;
  const maxNByDist = Math.floor(targetMeters / minSafeStep) + 1;
  const minNByGap = Math.ceil(durationSec / opts.segmentBreakGapSec) + 1;
  const preferredN = Math.ceil(durationSec / 5) + 1; // 目标 ~5s 一个点
  const count = Math.max(
    2,
    Math.min(opts.maxPoints, maxNByDist, Math.max(minNByGap, Math.min(preferredN, opts.maxPoints))),
  );

  const stepMeters = targetMeters / (count - 1);
  const dtSec = durationSec / (count - 1);
  const avgSpeed = targetMeters / durationSec;

  if (count < minNByGap) {
    warnings.push(
      `点数被 minDistance(${opts.minDistance}m)/maxPoints(${opts.maxPoints}) 限制在 ${count}，` +
      `导致相邻点间隔 ${dtSec.toFixed(1)}s > segmentBreakGapSec(${opts.segmentBreakGapSec}s)，真机上会被判为分段`,
    );
  }
  if (avgSpeed > opts.maxSpeed) {
    warnings.push(`平均速度 ${avgSpeed.toFixed(2)} m/s 超过 maxSpeed(${opts.maxSpeed})，真机上会被 HOLD`);
  }
  if (stepMeters < opts.minDistance) {
    warnings.push(`相邻点间距 ${stepMeters.toFixed(1)}m 小于 minDistance(${opts.minDistance}m)，真机会去重丢点`);
  }
  if (o.distanceKm * 1000 > polylineLengthMeters(polyline)) {
    warnings.push('目标里程超过路线单圈长度，轨迹将循环复用路线');
  }

  const { points: basePoints, laps } = resampleAlongRoute(polyline, targetMeters, count);

  // 抖动会**增加**折线长度（随机游走让路径变弯），单次按弧长等距取样必然偏长。
  // 做法：先把**相对偏移量**固定下来（一次随机游走，之后复用），再迭代收缩目标弧长，
  // 直到加上抖动后的实际里程命中目标。偏移必须相对于当前基点，否则改变弧长不会
  // 影响结果，迭代就成了空转。
  const offsets = makeJitterOffsets(jitterMeters, count);

  const applyOffsets = (pts) =>
    pts.map((p, i) => {
      const cosLat = Math.cos((p.latitude * Math.PI) / 180);
      return {
        latitude: Number((p.latitude + offsets[i].dy / METERS_PER_DEG_LAT).toFixed(6)),
        longitude: Number((p.longitude + offsets[i].dx / (METERS_PER_DEG_LAT * cosLat)).toFixed(6)),
      };
    });

  let arcTarget = targetMeters;
  let routeData;
  let bestErr = Infinity;
  for (let iter = 0; iter < 14; iter++) {
    const points = iter === 0 ? basePoints : resampleAlongRoute(polyline, arcTarget, count).points;
    const jittered = applyOffsets(points);
    const actual = polylineLengthMeters(jittered);
    const err = (actual - targetMeters) / targetMeters;

    // 只保留误差最小的一次（收缩过程中末次不一定最优）
    if (Math.abs(err) < Math.abs(bestErr)) {
      bestErr = err;
      routeData = jittered.map((p, i) => ({
        latitude: p.latitude,
        longitude: p.longitude,
        timestamp: Math.floor(startTime.getTime() + i * dtSec * 1000),
        accuracy: Number(accuracy.toFixed(1)),
        // 单段连续跑步：全部为 false。真机只在"强制断开"时把下一个点标记为 true。
        segmentBreak: false,
      }));
    }
    if (Math.abs(err) < 0.0002) break;
    // 阻尼收缩，避免间距变化 → 抖动增量变化 引起的振荡
    arcTarget *= 1 - 0.7 * err;
  }

  const endTime = new Date(startTime.getTime() + durationSec * 1000);
  const actualMeters = polylineLengthMeters(routeData);

  return {
    routeData,
    startTime,
    endTime,
    stats: {
      pointCount: routeData.length,
      laps,
      targetMeters,
      actualMeters,
      stepMeters,
      dtSec,
      avgSpeed,
    },
    warnings,
  };
}

/**
 * 用小程序客户端的规则体检一条轨迹。返回违规项列表（空数组 = 通过）。
 * 用于在真正提交前发现问题，而不是等后端判定无效。
 */
export function verifyTrack(routeData, { options } = {}) {
  const opts = { ...DEFAULT_TRACK_OPTIONS, ...(options || {}) };
  const issues = [];
  if (!Array.isArray(routeData) || routeData.length === 0) {
    return [{ level: 'error', rule: 'empty', detail: 'routeData 为空' }];
  }
  if (routeData.length > opts.maxPoints) {
    issues.push({ level: 'warn', rule: 'maxPoints', detail: `${routeData.length} > ${opts.maxPoints}` });
  }

  let broken = 0;
  for (let i = 1; i < routeData.length; i++) {
    const a = routeData[i - 1];
    const b = routeData[i];
    const d = haversineMeters(a.latitude, a.longitude, b.latitude, b.longitude);
    const dt = (b.timestamp - a.timestamp) / 1000;
    if (dt <= 0) issues.push({ level: 'error', rule: 'timestamp', detail: `第 ${i} 点时间未递增` });
    if (d < opts.minDistance) broken++;
    if (d > opts.maxSegmentDistance) {
      issues.push({ level: 'warn', rule: 'maxSegmentDistance', detail: `第 ${i} 段 ${d.toFixed(0)}m` });
    }
    if (dt > opts.segmentBreakGapSec && b.segmentBreak !== true) {
      issues.push({ level: 'warn', rule: 'segmentBreak', detail: `第 ${i} 点间隔 ${dt.toFixed(1)}s 但未标 segmentBreak` });
    }
    if (dt > 0 && d / dt > opts.maxSpeed) {
      issues.push({ level: 'warn', rule: 'maxSpeed', detail: `第 ${i} 段 ${(d / dt).toFixed(2)} m/s` });
    }
  }
  if (broken > 0) {
    issues.push({ level: 'warn', rule: 'minDistance', detail: `${broken} 个相邻点间距 < ${opts.minDistance}m，会被去重` });
  }
  return issues;
}

/**
 * 校验打卡点是否被轨迹经过（对照客户端 updateCheckpointProgressByRouteData 的判定）。
 * @param {object[]} routeData
 * @param {object[]} checkpoints  [{ latitude, longitude, pointName, seqNo }]
 * @param {object} rule { checkpointHitRadiusM = 30, passMode = 'ORDERED' | 'ANY' }
 */
export function verifyCheckpoints(routeData, checkpoints, rule = {}) {
  const radius = Number(rule.checkpointHitRadiusM) || 30;
  const mode = rule.passMode === 'ANY' ? 'ANY' : 'ORDERED';
  const list = Array.isArray(checkpoints) ? checkpoints : [];
  const hits = list.map(() => false);

  const near = (cp) =>
    routeData.some(
      (p) => haversineMeters(p.latitude, p.longitude, cp.latitude, cp.longitude) <= radius,
    );

  if (mode === 'ORDERED') {
    let cursor = 0;
    for (const p of routeData) {
      if (cursor >= list.length) break;
      const cp = list[cursor];
      if (haversineMeters(p.latitude, p.longitude, cp.latitude, cp.longitude) <= radius) {
        hits[cursor] = true;
        cursor++;
      }
    }
  } else {
    list.forEach((cp, i) => { hits[i] = near(cp); });
  }

  return {
    mode,
    radius,
    passed: hits.filter(Boolean).length,
    total: list.length,
    missed: list.filter((_, i) => !hits[i]).map((c) => c.pointName || c.id),
    hits,
  };
}

// ---------------------------------------------------------------------------
// 坐标系：小程序用 wx.getLocation({ type: 'gcj02' })，所以服务端路线是 GCJ-02。
// 如果你要导入真实 GPS 轨迹（GPX 一般是 WGS-84），先转换，否则整体会偏 300~500m。
// ---------------------------------------------------------------------------
const GCJ_A = 6378245.0;
const GCJ_EE = 0.00669342162296594323;
const outOfChina = (lat, lng) => !(lng > 73.66 && lng < 135.05 && lat > 3.86 && lat < 53.55);

function transformLat(x, y) {
  let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  ret += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3;
  ret += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3;
  return ret;
}
function transformLng(x, y) {
  let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  ret += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3;
  ret += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3;
  return ret;
}

/** WGS-84 → GCJ-02 */
export function wgs84ToGcj02(lat, lng) {
  if (outOfChina(lat, lng)) return { latitude: lat, longitude: lng };
  const dLat0 = transformLat(lng - 105, lat - 35);
  const dLng0 = transformLng(lng - 105, lat - 35);
  const radLat = (lat / 180) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - GCJ_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  const dLat = (dLat0 * 180) / (((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic)) * Math.PI);
  const dLng = (dLng0 * 180) / ((GCJ_A / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return { latitude: lat + dLat, longitude: lng + dLng };
}

/**
 * GCJ-02 → WGS-84。
 * 常见的 `lat*2 - gcj(lat)` 单向"反射"法残留误差约 1~2m；这里用迭代反解，收敛到亚米级。
 * 导入真实 GPS 轨迹（GPX 一般是 WGS-84）时才需要它。
 */
export function gcj02ToWgs84(lat, lng) {
  if (outOfChina(lat, lng)) return { latitude: lat, longitude: lng };
  let wLat = lat;
  let wLng = lng;
  for (let i = 0; i < 12; i++) {
    const g = wgs84ToGcj02(wLat, wLng);
    const dLat = g.latitude - lat;
    const dLng = g.longitude - lng;
    if (Math.abs(dLat) < 1e-10 && Math.abs(dLng) < 1e-10) break;
    wLat -= dLat;
    wLng -= dLng;
  }
  return { latitude: wLat, longitude: wLng };
}
