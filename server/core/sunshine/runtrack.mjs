/**
 * RunTrack —— 小程序轨迹过滤器的**逐句复刻**（app-service.js webpack module 776 + 751）。
 *
 * 为什么需要它：`verifyTrack()` 只是按参数近似体检，而本文件是把一条轨迹**真的喂进
 * 原算法重放一遍**，看它会得到什么结果。这是提交前最可靠的验证方式 ——
 * 能告诉你"真机上这条轨迹会被去重掉多少点、会不会被判超速/瞬移/分段"。
 *
 * ⚠️ 一个容易搞错的点：
 *   addPoint 通过的点进入 `rawPoints`（**不设上限**），`displayPoints` 才会被 maxPoints=500 裁剪。
 *   上传给服务端的 `routeData = getRawRoute()`，也就是 rawPoints —— **不受 500 限制**。
 *   maxPoints 只影响地图展示。
 */

import { DEFAULT_TRACK_OPTIONS } from './trackgen.mjs';
import { haversineMeters } from './metrics.mjs';

export const TRACK_RESULT = {
  ACCEPTED: 'accepted',
  BREAK: 'break',
  HOLD: 'hold',
  UNRELIABLE: 'unreliable',
  REJECTED: 'rejected',
};

const isFin = (v) => Number.isFinite(v);

/** 对照 module 751 的 calculateTotalDistance（跳过 segmentBreak 断点之间的段） */
export function calculateTotalDistance(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (b.segmentBreak === true) continue;
    const d = haversineMeters(a.latitude, a.longitude, b.latitude, b.longitude);
    if (isFin(d)) total += d;
  }
  return total;
}

export class RunTrack {
  constructor(options = {}) {
    this.options = { ...DEFAULT_TRACK_OPTIONS, ...options };
    this.reset();
  }

  reset() {
    this.rawPoints = [];
    this.displayPoints = [];
    this.totalDistanceMeters = 0;
    this.smoothBuffer = [];
    this.consecutiveRejects = 0;
    this.forceBreakOnNextPoint = false;
    this.lastSampleTimestamp = 0;
  }

  /** 上传用的轨迹就是它（rawPoints，无上限） */
  getRawRoute() { return this.rawPoints.slice(); }
  getDisplayRoute() { return this.displayPoints.slice(); }
  getLastPoint() { return this.rawPoints[this.rawPoints.length - 1] || null; }

  getTotalDistance() {
    if (!isFin(this.totalDistanceMeters) || this.totalDistanceMeters < 0) {
      this.totalDistanceMeters = calculateTotalDistance(this.rawPoints);
    }
    return this.totalDistanceMeters;
  }

  normalizePoint(t) {
    if (!t) return null;
    const lat = Number(t.latitude);
    const lng = Number(t.longitude);
    if (!isFin(lat) || Math.abs(lat) > 90 || !isFin(lng) || Math.abs(lng) > 180) return null;
    const ts = Number(t.timestamp);
    const acc = Number(t.accuracy);
    const spd = Number(t.speed);
    return {
      latitude: lat,
      longitude: lng,
      timestamp: isFin(ts) && ts > 0 ? ts : Date.now(),
      accuracy: isFin(acc) && acc > 0 ? acc : undefined,
      speed: isFin(spd) && spd >= 0 ? spd : undefined,
      segmentBreak: t.segmentBreak === true,
    };
  }

  /** 缺省 / 非正 accuracy 落到 "degraded"，不是 "trusted" —— 这点容易搞反 */
  resolveAccuracyLevel(accuracy) {
    const e = Number(accuracy);
    if (!isFin(e) || e <= 0) return 'degraded';
    if (e <= this.options.accuracyTrusted) return 'trusted';
    if (e <= this.options.accuracyDegraded) return 'degraded';
    return 'unreliable';
  }

  /** max(minDistance, accuracy/2)，低速时进一步放宽到 accuracy */
  resolveDistanceThreshold(t) {
    const e = this.options.minDistance;
    const n = Number(t.accuracy);
    const a = isFin(n) && n > 0 ? n : 2 * e;
    let i = Math.max(e, 0.5 * a);
    const s = Number(t.speed);
    if (isFin(s) && s >= 0 && s < 0.5) i = Math.max(i, a);
    return i;
  }

  /** 5 点中值滤波 */
  smooth(t) {
    if (t.segmentBreak === true) {
      this.smoothBuffer = [t];
      return t;
    }
    this.smoothBuffer.push(t);
    if (this.smoothBuffer.length > 5) this.smoothBuffer.shift();
    if (this.smoothBuffer.length < 5) return t;
    const mid = Math.floor(2.5);
    const lats = this.smoothBuffer.map((p) => p.latitude).sort((a, b) => a - b);
    const lngs = this.smoothBuffer.map((p) => p.longitude).sort((a, b) => a - b);
    return { ...t, latitude: lats[mid], longitude: lngs[mid] };
  }

  resolveJumpLimit(dt, isBreak) {
    const n = Number(this.options.maxSegmentDistance);
    const a = isFin(n) && n > 0 ? n : Infinity;
    if (!isBreak) return a;
    const i = isFin(dt) && dt > 0 ? dt : 0;
    return Math.max(a, i * this.options.maxSpeed);
  }

  isTeleport(dist, dt, isBreak) {
    if (dist > this.resolveJumpLimit(dt, isBreak)) return true;
    if (!isFin(dt) || dt <= 0) return true;
    if (!isBreak && dist / dt > this.options.maxSpeed) return true;
    return false;
  }

  canBridgeGap(dist, dt) {
    const n = Number(this.options.segmentBridgeGapSec);
    if (!isFin(n) || n <= 0 || dt > n) return false;
    const a = Number(this.options.segmentBridgeMaxDistance);
    if (isFin(a) && a > 0 && dist > a) return false;
    const i = Number(this.options.segmentBridgeMaxSpeed);
    if (!isFin(i) || i <= 0 || dt <= 0) return false;
    return dist / dt <= i;
  }

  rejectOrReanchor(q, level) {
    this.consecutiveRejects += 1;
    if (this.consecutiveRejects < 10) {
      return { result: TRACK_RESULT.REJECTED, reason: 'teleport', distanceDelta: 0, accuracyLevel: level };
    }
    this.consecutiveRejects = 0;
    this.smoothBuffer = [];
    this.forceBreakOnNextPoint = false;
    this.pushPoint({ ...q, segmentBreak: true });
    return { result: TRACK_RESULT.BREAK, reason: 'reanchor', distanceDelta: 0, accuracyLevel: level };
  }

  pushPoint(t) {
    this.rawPoints.push(t);
    this.displayPoints.push(t);
    // 仅裁剪展示用轨迹；rawPoints（上传用）不裁剪
    if (this.displayPoints.length > this.options.maxPoints) {
      const step = this.displayPoints.length / this.options.maxPoints;
      this.displayPoints = Array.from(
        { length: this.options.maxPoints },
        (_, i) => this.displayPoints[Math.min(this.displayPoints.length - 1, Math.floor(i * step))],
      );
    }
  }

  /** 逐句对照 addPoint */
  addPoint(input) {
    const e = this.normalizePoint(input);
    if (!e) return { result: TRACK_RESULT.REJECTED, reason: 'invalid', distanceDelta: 0 };

    const prevSampleTs = this.lastSampleTimestamp;
    this.lastSampleTimestamp = Math.max(this.lastSampleTimestamp, e.timestamp);

    const level = this.resolveAccuracyLevel(e.accuracy);
    if (level === 'unreliable') {
      return { result: TRACK_RESULT.UNRELIABLE, reason: 'accuracy', distanceDelta: 0, accuracyLevel: level };
    }

    const s = this.getLastPoint();
    if (!s) {
      this.pushPoint(this.smooth(e));
      return { result: TRACK_RESULT.ACCEPTED, distanceDelta: 0, accuracyLevel: level };
    }

    const dt = (e.timestamp - s.timestamp) / 1000;
    if (dt < 0.5) {
      if (haversineMeters(s.latitude, s.longitude, e.latitude, e.longitude) >= this.resolveDistanceThreshold(e)) {
        this.forceBreakOnNextPoint = true;
        this.smoothBuffer = [];
      }
      return { result: TRACK_RESULT.HOLD, reason: 'uncertain-timing', distanceDelta: 0, accuracyLevel: level };
    }

    const forcedBreak = e.segmentBreak === true || this.forceBreakOnNextPoint;
    const gapExceeded = prevSampleTs > 0 && (e.timestamp - prevSampleTs) / 1000 > this.options.segmentBreakGapSec;
    const isBreak = forcedBreak || gapExceeded;
    if (isBreak) this.smoothBuffer = [];

    const q = this.smooth(e);
    const h = haversineMeters(s.latitude, s.longitude, q.latitude, q.longitude);

    if (!isFin(h)) {
      return { result: TRACK_RESULT.REJECTED, reason: 'invalid', distanceDelta: 0, accuracyLevel: level };
    }

    if (this.isTeleport(h, dt, isBreak)) return this.rejectOrReanchor(q, level);

    this.consecutiveRejects = 0;

    if (gapExceeded && !forcedBreak && h < this.resolveDistanceThreshold(q)) {
      this.forceBreakOnNextPoint = true;
      return { result: TRACK_RESULT.HOLD, reason: 'below-threshold', distanceDelta: 0, accuracyLevel: level };
    }
    if (gapExceeded && !forcedBreak && this.canBridgeGap(h, dt)) {
      this.pushPoint(q);
      this.totalDistanceMeters += h;
      return { result: TRACK_RESULT.ACCEPTED, reason: 'bridged', distanceDelta: h, accuracyLevel: level };
    }
    if (isBreak) {
      this.forceBreakOnNextPoint = false;
      this.pushPoint({ ...q, segmentBreak: true });
      return { result: TRACK_RESULT.BREAK, distanceDelta: 0, accuracyLevel: level };
    }
    if (h < this.resolveDistanceThreshold(q)) {
      return { result: TRACK_RESULT.HOLD, reason: 'below-threshold', distanceDelta: 0, accuracyLevel: level };
    }

    this.pushPoint(q);
    this.totalDistanceMeters += h;
    return { result: TRACK_RESULT.ACCEPTED, distanceDelta: h, accuracyLevel: level };
  }

  /** 批量喂点，返回汇总统计 */
  feed(points) {
    const counts = {
      [TRACK_RESULT.ACCEPTED]: 0,
      [TRACK_RESULT.BREAK]: 0,
      [TRACK_RESULT.HOLD]: 0,
      [TRACK_RESULT.UNRELIABLE]: 0,
      [TRACK_RESULT.REJECTED]: 0,
    };
    const reasons = {};
    const events = [];
    for (let i = 0; i < points.length; i++) {
      const r = this.addPoint(points[i]);
      counts[r.result] = (counts[r.result] || 0) + 1;
      if (r.reason) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
      if (r.result !== TRACK_RESULT.ACCEPTED) events.push({ index: i, ...r });
    }
    return {
      input: points.length,
      counts,
      reasons,
      events,
      accepted: this.rawPoints.length,
      dropped: points.length - this.rawPoints.length,
      totalDistanceMeters: this.getTotalDistance(),
      segments: this.rawPoints.filter((p) => p.segmentBreak === true).length,
      rawPoints: this.getRawRoute(),
    };
  }
}

/**
 * 把一条轨迹喂进 RunTrack 重放，返回"真机会发生什么"。
 * @param {object[]} routeData
 * @param {object} [options] 覆盖 DEFAULT_TRACK_OPTIONS
 */
export function simulateTrack(routeData, options) {
  const track = new RunTrack(options);
  return track.feed(routeData);
}
