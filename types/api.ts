/**
 * 接口返回的形状 —— 只定义网页真正用到的字段。
 *
 * 放一个公共文件，是因为这些形状被多个页面/组件同时消费
 * （规则被首页和跑步页用，路线被跑步页用，预览被跑步页用），
 * 各写一份 Record<string, any> 就等于没有类型。
 */

/** GET /api/rules —— 服务端规则，已翻译成人话 */
export interface RulesInfo {
  known: boolean
  semesterName?: string | null
  schoolId?: number | null
  semesterId?: number | null
  minDistanceKm?: number | null
  minDurationSec?: number | null
  maxDurationSec?: number | null
  minPaceSec?: number | null
  maxPaceSec?: number | null
  speedRangeKmh?: { min: number, max: number } | null
  distanceRange?: {
    minKm: number
    maxKm: number
    recommendMaxKm: number
    known: boolean
  }
  lines: string[]
  /** 原始响应，诊断页会展示 */
  raw?: Record<string, unknown> | null
}

/** GET /api/routes 里的一条路线 */
export interface RouteItem {
  id: number
  name: string
  passMode: string | null
  checkpointHitRadiusM: number
  startAllowedRadiusM: number | null
  checkpointCount: number
  startLatitude: number | null
  startLongitude: number | null
}

/** POST /api/run/plan —— 干跑预演的结果 */
export interface RunPreview {
  ok: boolean
  issues: { code: string, text: string }[]
  distanceKm: number
  durationSec: number
  paceText: string
  route: {
    id: number | null
    name: string | null
    passMode: string
    hitRadius: number
    checkpointCount: number
    lapMeters: number
    points: number[][]
  }
  track: {
    pointCount: number
    actualKm: number
    laps: number
    dtSec: number
    warnings: string[]
  }
  replay: { input: number, accepted: number, dropped: number, segments: number, meters: number }
  checkpoints: { total: number, passed: number, missed: (string | number)[], mode: string, radius: number }
  timing: { targetSec: number, submitAtSec: number, submitAtText: string, marginSec: number, note: string }
}
