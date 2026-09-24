/**
 * 跑步状态 —— 网页每秒问一次服务端「现在跑到哪一步了」。
 *
 * 为什么是问服务端而不是浏览器自己计时：
 *   校园跑的时长由服务端按会话 start → finish 计算，浏览器只是个显示器。
 *   所以刷新页面、关掉浏览器、甚至重启程序，进度都不会丢。
 */
import type { RunPreview } from '~/types/api'

export interface RunTrackInfo {
  pointCount: number
  actualKm: number
  laps: number
  dtSec: number
  warnings: string[]
}

export interface RunCheckpointInfo {
  total: number
  passed: number
  missed: (string | number)[]
  mode: string
  radius: number
}

export interface RunSnapshot {
  phase: 'idle' | 'starting' | 'waiting' | 'submitting' | 'done' | 'failed' | 'cancelled' | 'interrupted'
  id?: string
  mode?: string
  routeId?: number
  routeName?: string | null
  distanceKm?: number
  durationSec?: number
  expectedDurationSec?: number | null
  requested?: { distanceKm: number, durationSec: number }
  jittered?: boolean
  checkpoints?: RunCheckpointInfo | null
  track?: RunTrackInfo | null
  replay?: { input: number, accepted: number, dropped: number, segments: number } | null
  sessionId?: string | null
  sessionStartedAt?: string | null
  submitAt?: string | null
  elapsedSec?: number
  remainingSec?: number
  elapsedText?: string | null
  remainingText?: string | null
  result?: Record<string, unknown> | null
  error?: string | null
  log?: { t: string, level: string, text: string }[]
  canSubmitNow?: boolean
  canCancel?: boolean
  /**
   * 「现在点提交会发生什么」的预览。
   * 提前提交时上报的 duration 会按真实经过秒数重算，所以必须让用户看见这个数字。
   */
  submitPreview?: {
    durationSec: number
    durationText: string
    paceText: string
    allowed: boolean
    issues: string[]
    earlierThanTarget: boolean
  } | null
}

let pollTimer: ReturnType<typeof setInterval> | null = null

export function useRun() {
  const api = useApi()
  const state = useState<RunSnapshot>('sunshine-run', () => ({ phase: 'idle' }))
  const busy = useState('sunshine-run-busy', () => false)

  async function refresh() {
    state.value = await api.get<RunSnapshot>('/api/run/state')
    return state.value
  }

  /** 有任务在跑（或刚结束）时才需要频繁轮询；空闲时 5 秒一次就够 */
  function ensurePolling() {
    if (pollTimer) return
    const tick = async () => {
      try {
        await refresh()
      } catch { /* 单次失败忽略，下一次继续 */ }
    }
    tick()
    pollTimer = setInterval(tick, 1000)
    if (typeof pollTimer === 'object' && 'unref' in pollTimer) (pollTimer as { unref: () => void }).unref()
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  async function plan(body: Record<string, unknown>) {
    return api.post<RunPreview>('/api/run/plan', body)
  }

  async function start(body: Record<string, unknown>) {
    busy.value = true
    try {
      state.value = await api.post<RunSnapshot>('/api/run/start', body)
      return state.value
    } finally {
      busy.value = false
    }
  }

  async function submitNow(force = false) {
    busy.value = true
    try {
      state.value = await api.post<RunSnapshot>('/api/run/submit', { force })
      return state.value
    } finally {
      busy.value = false
    }
  }

  async function cancel(reason?: string) {
    busy.value = true
    try {
      state.value = await api.post<RunSnapshot>('/api/run/cancel', { reason })
      return state.value
    } finally {
      busy.value = false
    }
  }

  async function reset() {
    state.value = await api.post<RunSnapshot>('/api/run/reset')
    return state.value
  }

  const isActive = computed(() => ['starting', 'waiting', 'submitting', 'interrupted'].includes(state.value?.phase || 'idle'))

  return { state, busy, isActive, refresh, ensurePolling, stopPolling, plan, start, submitNow, cancel, reset }
}
