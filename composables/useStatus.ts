/**
 * 全局接入状态 —— 首页、向导、诊断页共用同一份，避免各自去猜有没有登录。
 */

export interface AuthUser {
  name?: string
  /** 服务端有时返回 studentName 而不是 name */
  studentName?: string
  studentId?: string
  /** 服务端有时返回 studyCode 而不是 studentId */
  studyCode?: string
  schoolName?: string
  schoolId?: number
  weight?: number
}

export interface AuthStatus {
  mode: 'real' | 'demo'
  loggedIn: boolean
  baseUrl: string
  deviceId: string | null
  deviceFingerprint: string | null
  tokenPrefix: string | null
  savedAt: string | null
  user: AuthUser | null
  hasLegacy: boolean
  legacyFile: string | null
  jitter: boolean
  mockPort: number
}

export function useStatus() {
  const api = useApi()
  const status = useState<AuthStatus | null>('sunshine-status', () => null)
  const loading = useState('sunshine-status-loading', () => false)

  async function refresh() {
    loading.value = true
    try {
      status.value = await api.get<AuthStatus>('/api/auth/status')
      return status.value
    } finally {
      loading.value = false
    }
  }

  async function setMode(mode: 'real' | 'demo') {
    const res = await api.post<{ status: AuthStatus }>('/api/config', { mode })
    status.value = res.status
    return res
  }

  async function setJitter(jitter: boolean) {
    await api.post('/api/config', { jitter })
    await refresh()
  }

  async function logout() {
    await api.post('/api/auth/logout')
    await refresh()
  }

  return { status, loading, refresh, setMode, setJitter, logout }
}
