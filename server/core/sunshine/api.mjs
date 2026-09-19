/**
 * API 封装 —— 端点全部来自 `wxapkg-unpack/API-INVENTORY.md`（由 inventory.mjs 自动提取，
 * 以 `e.d(n,{...})` 导出映射为锚点），共 32 个，不是猜的。
 * 每个函数注释里标了它是小程序的哪个导出。
 */

/** @param {ReturnType<import('./request.mjs').createClient>} c */
export function createApi(c) {
  return {
    // ---------------------------------------------------------------- auth
    /** POST /auth/wx-login —— code 只能由 wx.login() 产生，外部客户端无法自行完成 */
    wxLogin: (code) => c.post('/auth/wx-login', { code }),
    /** GET /auth/check */
    checkLogin: () => c.get('/auth/check'),
    /** POST /auth/bind-student */
    bindStudent: (data) => c.post('/auth/bind-student', data),
    /** POST /auth/logout */
    logout: () => c.post('/auth/logout'),

    // ---------------------------------------------------------------- users
    /** GET /users/profile */
    getUserProfile: () => c.get('/users/profile'),
    /** PUT /users/profile/avatar */
    updateUserAvatar: (data) => c.put('/users/profile/avatar', data),
    /** GET /users/run-settings */
    getRunSettings: () => c.get('/users/run-settings'),
    /** PUT /users/run-settings */
    updateRunSettings: (data) => c.put('/users/run-settings', data),

    // ---------------------------------------------------------------- schools
    /** GET /schools/list —— { longitude, latitude } */
    getSchools: ({ longitude, latitude } = {}) => c.get('/schools/list', { longitude, latitude }),
    /** GET /schools/search —— { keyword, longitude, latitude } */
    searchSchools: (keyword, { longitude, latitude } = {}) =>
      c.get('/schools/search', { keyword, longitude, latitude }),
    /** POST /schools/validate-student —— { schoolId, studyCode } */
    validateStudent: (schoolId, studyCode) =>
      c.post('/schools/validate-student', { schoolId, studyCode }),

    /**
     * GET /routes/{id}
     *
     * 这是**唯一可用的路线查询接口**（`/routes/nearby/rat-line` 在我们这边稳定 500）。
     * 返回的 `checkpoints` 数组**本身就是路径折线**，每个点带 `seqNo` / `startPoint`。
     *
     * 实测（schoolId=1 某高校）：
     *   1 → 路线不存在或未启用
     *   2 → 体育馆  22 点
     *   3 → 操场    15 点
     *   4 → 操场（另一校区）
     *   5 → 第2食堂
     */
    getRouteDetail: (id) => c.get(`/routes/${id}`),

    /**
     * GET /routes/nearby/rat-line?lat=&lng=&limit=
     *
     * ⚠️ 路径是 `/routes/nearby/rat-line`，**不是** `/routes/nearby`（后者返回 500）。
     * 参数名是 `lat` / `lng`（不是 latitude/longitude）。这是从真机抓包里看到的。
     *
     * ⚠️ 但实测这个接口**稳定返回 500**（18/18 次），而真机上它一半成功一半失败 ——
     * 是服务端 bug。需要路线时请改用 `getRouteDetail(id)`。
     */
    getNearbyRoutes: ({ latitude, longitude, limit = 20 } = {}) =>
      c.get('/routes/nearby/rat-line', { lat: latitude, lng: longitude, limit }),

    // ---------------------------------------------------------------- routes/admin
    getAdminRoutes: (data) => c.get('/routes/admin', data),
    createAdminRoute: (data) => c.post('/routes/admin', data),
    getAdminRouteDetail: (id) => c.get(`/routes/admin/${id}`),
    updateAdminRoute: (id, data) => c.put(`/routes/admin/${id}`, data),
    deleteAdminRoute: (id) => c.del(`/routes/admin/${id}`),
    getRouteAdminPermission: () => c.get('/routes/admin/permission'),

    // ---------------------------------------------------------------- runs
    /** POST /runs/sessions/start —— { runType, routeId, startLatitude, startLongitude } */
    startRunSession: (data) => c.post('/runs/sessions/start', data),
    /** POST /runs/sessions/{id}/finish */
    finishRunSession: (sessionId, data) => c.post(`/runs/sessions/${sessionId}/finish`, data),
    /** POST /runs/sessions/{id}/cancel */
    cancelRunSession: (sessionId) => c.post(`/runs/sessions/${sessionId}/cancel`),
    /** POST /runs —— FREE 模式直接落库 */
    saveRunRecord: (data) => c.post('/runs', data),
    /** GET /runs?dateType=semester —— 真机用的是 dateType 而非 page/size */
    getRunRecords: (data) => c.get('/runs', data),
    getRecentWeekRecords: (data) => c.get('/runs/recent-week', data),
    getRunRecordDetail: (id) => c.get(`/runs/${id}`),

    // ---------------------------------------------------------------- run-rules / notices
    /** GET /run-rules/current —— 当前生效的跑步规则（最低里程、有效时段等） */
    getCurrentRunRule: () => c.get('/run-rules/current'),
    /** GET /run-notices/campus-safety */
    getCampusSafetyNotice: () => c.get('/run-notices/campus-safety'),

    // ---------------------------------------------------------------- run-exemptions（免跑申请）
    getCurrentRunExemption: (data) => c.get('/run-exemptions/current', data),
    getRunExemptionDetail: (id) => c.get(`/run-exemptions/${id}`),
    submitRunExemption: (data) => c.post('/run-exemptions', data),
    deleteRunExemption: (id) => c.del(`/run-exemptions/${id}`),

    // ---------------------------------------------------------------- stats
    /** GET /stats */
    getStats: (data) => c.get('/stats', data),
  };
}

/**
 * 文件上传走的是另一条路：`wx.uploadFile`（multipart），
 * URL = `${SCHOOL_SERVER_BASE_URL}/api/attachment/upload`，
 * 而且**只带 `sunshine-run` 一个头**，不带 device-id / device-fp。
 *
 * @param {string} token
 * @param {string} filePath 本地文件路径
 * @param {string} [name] 表单字段名，默认 'file'
 */
export async function uploadAttachment(token, filePath, name = 'file') {
  const { ATTACHMENT_UPLOAD_URL } = await import('./request.mjs');
  const fs = await import('node:fs');
  const path = await import('node:path');

  const buf = fs.readFileSync(filePath);
  const form = new FormData();
  form.append(name, new Blob([buf]), path.basename(filePath));

  const res = await fetch(ATTACHMENT_UPLOAD_URL, {
    method: 'POST',
    headers: token ? { 'sunshine-run': token } : {},
    body: form,
  });
  const text = await res.text();
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error(`上传返回非 JSON: ${text.slice(0, 200)}`); }
  if (res.status !== 200) throw new Error(`上传失败 HTTP ${res.status}: ${payload?.message || text.slice(0, 200)}`);
  return payload?.data ?? payload;
}
