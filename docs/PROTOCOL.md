# 酷动·阳光跑 —— 后端协议说明

> 📌 **本文档已脱敏**：学校名、校区名、跑道坐标、账号 ID 都已换成中性值，
> 其余内容（请求/响应结构、实测数值、结论）保持原样。
> 它由同作者的命令行版测试客户端产出，随本仓库一起提供，方便对照阅读代码。

> 依据：微信小程序包 `__APP__.wxapkg` 解包后的 `app-service.js`（538 KB，webpack 打包，未加密）。
> 本文所有结论均可回溯到该文件中的具体模块，关键处标注了原文片段。
> 与 totoro-paradise 那类"协议重放"不同，**这套后端没有任何加密或签名**，是普通的 REST + 自定义 token 头。

---

## 1. 总体形态

| 项 | 值 |
|---|---|
| API 域名 | `https://sports.sqcoe.com`（module 709 `API_DOMAIN`） |
| **默认 API 根** | **`https://sports.sqcoe.com/sunshine`**（`API_BASE_URL` = `API_DOMAIN + "/sunshine"`） |
| 文件上传根 | `https://sports.sqcoe.com/schoolServer`（`SCHOOL_SERVER_BASE_URL`，仅用于 `/api/attachment/upload`） |
| 传输 | 明文 JSON（`Content-Type: application/json`） |
| 鉴权 | 自定义头 `sunshine-run`，**不是** `Authorization: Bearer` |
| 加密/签名 | **无**（全文无 RSA/AES/HMAC/sign 相关代码） |
| 响应信封 | `{ code, message, data }` |
| 成功判定 | HTTP 200 **且** `code === 200 \|\| code === 0` |
| 坐标系统 | GCJ-02（`wx.getLocation({ type: 'gcj02' })`） |
| 风格 | RESTful（`/runs/sessions/{id}/finish`），非 RPC |

> ⚠️ 业务接口的路径前缀是 **`/sunshine`**。别把 base 写成裸域名 —— 那样所有请求都会 404。

### 1.1 baseUrl 三级回退

请求封装（module 722）里 baseUrl 的解析顺序：

```
1. 学校专属 server_url   （登录后写入 storage: sunshine-run-server-url / USER_INFO.serverUrl）
2. 用户信息里的 serverUrl
3. 默认 API_BASE_URL = https://sports.sqcoe.com/sunshine
```

并且有 502 兜底：请求学校 `server_url` 返回 502 时，自动切回默认 API 重试一次。

```js
if (502 === o.statusCode && l) {          // l = 是否还允许回退
  console.warn("请求school server_url返回502,切换默认API重试:", ...);
  var p = x();                            // x() 把默认 baseUrl 写回 storage
  a(p, !1);                               // 用默认 baseUrl 重发，且不再回退
}
```

> 说明这是**多租户**后端：每个学校可以指向自己的部署，但路径结构与默认 API 一致
> （学校服务器同样要提供 `/runs`、`/auth/*` 等）。测试客户端因此必须支持 `--base` 覆盖。

### 1.2 本地存储键（module 709 `STORAGE_KEYS`）

全部带 `sunshine-run-` 前缀，字面值如下（在开发者工具 Storage 面板里按这些键名找）：

| 常量 | 字面值 |
|---|---|
| `TOKEN` | `sunshine-run-token` |
| `USER_INFO` | `sunshine-run-user-info` |
| `DEVICE_ID` | `sunshine-run-device-id` |
| `SERVER_URL` | `sunshine-run-server-url` |
| `ACTIVE_RUN` | `sunshine-run-active-run` |
| `RUN_SETTINGS` | `sunshine-run-run-settings` |
| `RUN_RECORDS` | `sunshine-run-records` |
| `PENDING_SYNC` | `sunshine-run-pending-sync` |

登录判定就一句：

```js
isLogin() { return !!wx.getStorageSync(STORAGE_KEYS.TOKEN); }
```

---

## 2. 请求头约定

module 722 的 `request` 里，头是"默认 + 调用方自定义 + 三个身份头"：

```js
var w = wx.getStorageSync(STORAGE_KEYS.TOKEN) || "";
w && (c["sunshine-run"] = w);
var E = getDeviceIdentity();
E.deviceId          && (c["sunshine-run-device-id"] = E.deviceId);
E.deviceFingerprint && (c["sunshine-run-device-fp"] = E.deviceFingerprint);
// 最终 header = { "Content-Type": "application/json", ...c }
```

| 头 | 值 | 何时带 |
|---|---|---|
| `Content-Type` | `application/json` | 始终 |
| `sunshine-run` | token | token 非空时 |
| `sunshine-run-device-id` | `dev_...` | 始终 |
| `sunshine-run-device-fp` | 8 位 hex | 始终 |

### 2.1 设备身份生成（module 723）

```js
var s = "dev_", l = null;

function p() {                       // deviceId
  return "".concat("dev_")
           .concat(Date.now().toString(36))
           .concat(randomHex(12));   // 12 位 [0-9a-f]
}

function v(t) {                      // fingerprint
  var e = 2166136261, r = (t == null ? "" : String(t));
  for (var o = 0; o < r.length; o++) e = 16777619 * (e ^= r.charCodeAt(o)) >>> 0;
  return e.toString(16).padStart(8, "0");
}

function h() {
  var deviceId = storage(DEVICE_ID) || (gen & save);   // 首次生成后固定
  var info = { brand, model, system, platform, language,
               version, pixelRatio, screenWidth, screenHeight };
  return { deviceId, deviceFingerprint: v(
    [info.brand, info.model, info.system, info.platform, info.language,
     info.version, info.pixelRatio, info.screenWidth, info.screenHeight].join("|")
  ) };
}
```

两个**必须原样照抄**的细节：

1. **字段顺序固定为 9 个**，用 `|` 拼接，缺的按空串。
2. `v()` 里是 `16777619 * (e ^= c) >>> 0`，**没有用 `Math.imul`**。乘积会超过 2^53 而丢精度，
   所以它并不是标准 FNV-1a。自己实现时如果"顺手改成 Math.imul"，指纹就会和服务端记录的对不上。
   `test/selftest.mjs` 里有 2000 组随机输入验证逐字节一致。

`deviceId` 存在 `wx.getStorageSync('deviceId')`，**首登生成后终身不变** —— 这就是服务端识别"同一台设备"的依据。

### 2.2 请求签名（小程序 v29 起，2026-09 实测）

服务端对**三个写接口**强制校验签名。不带签名的请求一律返回：

```json
{ "code": 403, "message": "请求校验失败，请更新小程序后重试" }
```

| 方法 | 路径 | 要签名 |
|---|---|---|
| POST | `/runs` | ✅ |
| POST | `/runs/sessions/start` | ✅ |
| POST | `/runs/sessions/{id}/finish` | ✅ |
| POST | `/runs/sessions/{id}/cancel` | ❌ |
| 所有 GET | — | ❌ |

要加的三个头：

| 头 | 内容 |
|---|---|
| `sunshine-run-timestamp` | 秒级时间戳（**字符串**） |
| `sunshine-run-nonce` | 16 个随机字节 → 32 位**小写 hex** |
| `sunshine-run-sign` | `hmacSHA256hex(key, canonical)` |

`canonical` 是 8 行、用 `\n` 连接、**末尾还有一个 `\n`**：

```
v1
<方法大写>
<路径>                      ← 例如 /runs/sessions/start，不含域名
<timestamp>
<nonce>
<sha256hex(token)>
<sha256hex(deviceId)>
<sha256hex(请求体 JSON 字符串)>
```

密钥硬编码在小程序里（64 位 hex）：`11b88c5d08744fdcba39ae5727fd689c7b08bac9876353e79ec223441fb24ea3`

容易踩的点：

1. `sha256()` 与 `hmac()` 都输出 **hex**（小程序用的是 js-sha256，不是 base64）。
2. 请求体那一路哈希的必须是**实际发出去的那份 JSON 字符串** —— 先序列化一次，再用同一个字符串去算签名，不能算了签名再重新序列化。
3. `timestamp` / `nonce` 是**每次请求重新生成**的，不是会话级。
4. 少任何一项，服务端都先拦在 403，**不会**走到业务逻辑（所以 403 不等于"没绑定学号"）。

实测对照（2026-09-24，真实后端）：

```
正确签名 → POST /runs/sessions/start → code 200，拿到 sessionId
改坏签名 → code 403「请求校验失败，请更新小程序后重试」
正确签名 → finish 一个已撤销的会话 → code 500「跑步会话已结束」（业务错误，说明签名已放行）
```

出处：v29 的 `app-service.js` 里 `C()`（判定哪些 url 要签名）、`D()`（拼 canonical + HMAC）、`U()`（生成 nonce/timestamp）。
以后小程序再更新，重新解包后优先 diff 这三个函数。

---

## 3. 登录链路

```
wx.login()  →  code
            →  POST /auth/wx-login { code }
            →  { token, userInfo, isBound }
            →  storage: TOKEN / USER_INFO / SERVER_URL(userInfo.serverUrl)
            →  isBound ? 首页 : 弹窗引导 /auth/bind-student
```

```js
wx.login();
case 4: if (t = n.sent, r = t.code) break; throw new Error("获取微信登录code失败");
case 5: return n.next = 6, wxLogin(r);
case 6: o = n.sent,
        wx.setStorageSync(STORAGE_KEYS.TOKEN, o.token),
        wx.setStorageSync(STORAGE_KEYS.USER_INFO, o.userInfo),
        o.userInfo && o.userInfo.serverUrl
          ? wx.setStorageSync(STORAGE_KEYS.SERVER_URL, o.userInfo.serverUrl)
          : wx.removeStorageSync(STORAGE_KEYS.SERVER_URL);
```

> ⚠️ **这是本协议唯一无法在微信外复现的一步。** `code` 由微信客户端签发、只能在小程序运行环境里产生，
> 无法用 HTTP 直接换到。所以外部测试客户端必须**传入已有 token** 作为引导。
> 如果要在 CI 里跑，建议在后端加一个仅测试环境可用的换 token 通道，而不是去模拟微信。

其余鉴权端点：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/auth/check` | 校验 token 是否有效 |
| POST | `/auth/bind-student` | 绑定学号 |
| POST | `/auth/logout` | 登出 |
| GET | `/users/profile` | 用户档案 |
| PUT | `/users/profile/avatar` | 更新头像 |

`code === 401` 时小程序会清空 `TOKEN`/`USER_INFO`/`SERVER_URL` 并 `reLaunch` 到登录页；
`code === 403` 会弹"去绑定学号"。这两个约定对客户端错误处理是契约的一部分。

---

## 4. 跑步协议

后端提供**两套**写入路径，由 `runType` 区分：`CAMPUS`（校园跑，需打卡点）和 `FREE`（自由跑）。

### 4.1 CAMPUS —— 会话式（三段）

| 方法 | 路径 | 请求体 | 响应 |
|---|---|---|---|
| POST | `/runs/sessions/start` | `{ runType: "CAMPUS", routeId, startLatitude, startLongitude }` | `{ sessionId, route, selectedCheckpoints }` |
| POST | `/runs/sessions/{id}/finish` | 见下 | — |
| POST | `/runs/sessions/{id}/cancel` | 无 | — |

```js
function i(t){ return request({ url:"/runs/sessions/start",  method:"POST", data:t }) }
function u(t,n){ return request({ url:`/runs/sessions/${t}/finish`, method:"POST", data:n }) }
function a(t){ return request({ url:`/runs/sessions/${t}/cancel`, method:"POST" }) }
```

调用点（跑步页）：

```js
startRunSession({ runType: "CAMPUS", routeId: this.selectedRouteId,
                  startLatitude: this.latitude, startLongitude: this.longitude });
// → sessionId
// → selectedCheckpoints[]：{ id, pointName, latitude, longitude, seqNo, passed }
// → route：服务端下发的标准路线（同样用于本地打卡判定）
```

**finish 请求体**（`saveCampusRunRecord`）：

```js
finishRunSession(sessionId, {
  distance:  parseFloat(t.distance),   // 公里，2 位小数
  duration:  t.totalSeconds,           // 秒，整数
  pace:      t.pace,                   // "6'40\"" 形式
  calories:  t.calories,
  startTime: t.startTime,              // "YYYY-MM-DDTHH:mm:ss" 本地时间
  endTime:   t.endTime,                // 同上
  routeData: t.routeData               // 轨迹点数组
});
```

`sessionId` 缺失时小程序直接提示"会话已失效，请重新开始"——说明服务端会话是有状态的、会过期的。

### 4.2 FREE —— 直接落库（一段）

```js
saveRunRecord({
  runType: "FREE",
  distance: parseFloat(t.distance),
  duration: t.totalSeconds,
  pace: t.pace,
  calories: t.calories,
  startTime: a.startTime,
  endTime: a.endTime,
  routeData: t.routeData
});   // → POST /runs
```

注意 FREE 的请求体里 **`runType` 是字符串 `"FREE"`**，而离线上传路径里又写成 `runType: n.runType || "FREE"`。

### 4.3 读取

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/runs` | 记录列表（query 传参） |
| GET | `/runs/recent-week` | 最近一周 |
| GET | `/runs/{id}` | 详情 |
| GET | `/stats` | 统计 |

### 4.4 离线补传（说明服务端幂等性）

小程序会把失败的记录存在本地 `RUN_RECORDS`，之后补传，补传时**按类型走不同路径**：

```js
if (n.syncType === "CAMPUS_FINISH") {
  if (!n.sessionId) throw new Error("校园跑补传缺少会话ID");
  finishRunSession(n.sessionId, n.finishPayload, { showLoading: false });
} else {
  saveRunRecord({ runType: n.runType || "FREE", ... }, { showLoading: false });
}
```

> 由此可知：**CAMPUS 的 finish 以 `sessionId` 为幂等键**，重复提交同一次会话是安全的（补传就是这个假设）。
> 写压测/回归脚本时可以直接复用这一点。

---

## 5. 轨迹格式 `routeData`

落库前的归一化函数（module 722）：

```js
normalizeRouteDataForPersistence: function (t) {
  return Array.isArray(t) ? t.map(function (t) {
      if (!t) return null;
      var e = Number(t.latitude), n = Number(t.longitude);
      if (!isFinite(e) || !isFinite(n)) return null;
      var a = Number(t.timestamp), i = Number(t.accuracy);
      return {
        latitude:  Number(e.toFixed(6)),
        longitude: Number(n.toFixed(6)),
        timestamp: isFinite(a) ? Math.floor(a) : null,   // 毫秒 epoch
        accuracy:  isFinite(i) ? Number(i.toFixed(1)) : null,
        segmentBreak: t.segmentBreak === true
      };
  }).filter(Boolean) : [];
}
```

单点结构：

```ts
interface RoutePoint {
  latitude: number;    // 6 位小数，GCJ-02
  longitude: number;   // 6 位小数，GCJ-02
  timestamp: number;   // 毫秒；服务端按它算分段与速度
  accuracy: number | null;  // 米，1 位小数
  segmentBreak: boolean;    // true = 与上一点之间强制断开
}
```

---

## 6. 客户端轨迹过滤规则（module 776）

这是**小程序自己**在采集时用的过滤器，也是判断一条轨迹"像不像真的"的基准：

```js
DEFAULT_TRACK_OPTIONS = {
  minDistance: 6,              // 相邻点最小间距(m)，小于则去重丢弃
  maxSpeed: 8,                 // m/s（≈28.8km/h），超过判 HOLD
  maxSegmentDistance: 180,     // 单段最大跨度(m)
  segmentBreakGapSec: 15,      // 相邻点时间间隔 > 15s → 进入分段/桥接判定
  segmentBridgeGapSec: 60,     // 60s 内允许桥接
  segmentBridgeMaxDistance: 180,
  segmentBridgeMaxSpeed: 6,
  accuracyTrusted: 20,         // accuracy ≤ 20m：可信档
  accuracyDegraded: 65,        // ≤ 65m：降级档；> 65m 不可用
  compressionTolerance: 10,    // 抽稀容差(m)
  maxPoints: 500               // ⚠️ 只裁剪展示用轨迹，不影响上传内容（见 6.2）
};
```

服务端 `maxSpeed` 的判定另有一处默认值 **12 m/s**（`handleCrossLineRisk` 里 `|| 12`），
和采集侧的 8 m/s 不一致 —— 值得在后端统一。

### 6.1 `addPoint` 状态机（完整）

每个采样点进来后返回五种结果之一：

```js
TRACK_RESULT = { ACCEPTED: "accepted", BREAK: "break", HOLD: "hold",
                 UNRELIABLE: "unreliable", REJECTED: "rejected" }
```

```
normalizePoint          经纬度非法 → REJECTED(invalid)
accuracyLevel           缺省/≤0 → "degraded"；≤20 → trusted；≤65 → degraded；>65 → UNRELIABLE
                        注意：**缺省不是 trusted**
dt < 0.5s               → HOLD(uncertain-timing)
isBreak = segmentBreak || forceBreakOnNextPoint || (距上次采样 > 15s)
smooth(e)               5 点中值滤波
h = 距上一个已接受点的距离

isTeleport(h, dt, isBreak) = h > jumpLimit  ||  dt<=0  ||  (!isBreak && h/dt > 8)
    jumpLimit = isBreak ? max(180, dt*8) : 180
    → 连续 10 次瞬移后改为 reanchor（打 segmentBreak 强行重新锚定）

gapExceeded && !forcedBreak && h < threshold      → HOLD(below-threshold)
gapExceeded && !forcedBreak && canBridgeGap(h,dt) → ACCEPTED(bridged)  ← 点数照收
isBreak                                           → BREAK（点被收下但标 segmentBreak）
h < threshold                                     → HOLD(below-threshold)
否则                                               → ACCEPTED
```

去重阈值不是固定的 6m：

```js
resolveDistanceThreshold(t) {
  a = accuracy > 0 ? accuracy : 2 * minDistance;   // 兜底 12
  i = max(minDistance, 0.5 * a);
  if (speed ∈ [0, 0.5)) i = max(i, a);             // 低速时进一步放宽
  return i;
}
```

> **容易踩的坑**：`accuracy = 20` 时阈值变成 10m，`accuracy = 65` 时变成 32.5m。
> 也就是说上报精度越差，去重越松 —— 但 > 65m 直接整点丢弃。

> **15~60s 的间隔不会判分段**：只要 `h/dt ≤ segmentBridgeMaxSpeed(6)` 且 `h ≤ 180m`，
> 就会被当作 `bridged` 正常接受并计入里程。只有超过 60s 才真的 `BREAK`。

### 6.2 ⚠️ `maxPoints` 不约束上传内容

```js
pushPoint(t) {
  this.rawPoints.push(t);        // ← 无上限
  this.displayPoints.push(t);    // ← 只在超过 maxPoints 时抽稀
  this.trimDisplayPointsIfNeeded();
}
getRawRoute() { return this.rawPoints.slice(); }   // 上传用的是这个
```

跑步页的赋值是 `routeData = runTrack.getRawRoute()`、`displayRouteData = runTrack.getDisplayRoute()`，
而落库/上传的是 `normalizeRouteDataForPersistence(this.routeData)`。

**结论：上传给服务端的轨迹点数没有 500 的上限，500 只影响地图折线。**
一小时的真实跑步按 1~5s 采样会产生 720~3600 个点。写后端校验时不要按"最多 500 点"来假设。

---

## 7. 打卡点判定

客户端在 `updateCheckpointProgressByRouteData` 里本地算一遍：

```js
var s = Number(selectedRoute && selectedRoute.checkpointHitRadiusM) || 30;   // 默认命中半径 30m
var o = selectedRoute && selectedRoute.passMode === "ANY" ? "ANY" : "ORDERED";
```

- `ORDERED`：必须**按 `seqNo` 顺序**依次进入每个打卡点的 30m 范围；
- `ANY`：任意顺序经过即可。

服务端应当独立复算（客户端这份只用于 UI 进度与语音播报），
`event = "cross_line"` 的音频（`audio/cross_line.mp3`）就是打卡点穿越提示音。

---

## 8. 度量公式

全部来自跑步页的 `updateMetrics` / `calculateDistanceMeters`：

```js
// 距离：标准 Haversine，R = 6371e3
var u = (r - i) * Math.PI / 180, c = (o - s) * Math.PI / 180;
var l = Math.sin(u/2)**2 + Math.cos(i*Math.PI/180)*Math.cos(r*Math.PI/180)*Math.sin(c/2)**2;
return 6371e3 * (2 * Math.atan2(Math.sqrt(l), Math.sqrt(1 - l)));

// 配速：分'秒"   （duration 秒，distance 公里）
var i = (this.duration / 60) / parseFloat(this.distance);
this.pace = `${Math.floor(i)}'${pad2(Math.floor(60 * (i - Math.floor(i))))}"`;

// 卡路里：就这么简单
this.calories = Math.floor(60 * t);
```

| 字段 | 公式 | 示例（3km / 20min） |
|---|---|---|
| `distance` | 轨迹总长 / 1000，`toFixed(2)` | `3.02` |
| `duration` | 秒，整数 | `1200` |
| `pace` | `60/duration/距离` → `分'秒"` | `6'36"` |
| `calories` | `floor(60 × 距离km)` | `181` |
| `startTime`/`endTime` | 本地 `YYYY-MM-DDTHH:mm:ss`，**无时区无毫秒** | `2026-09-18T21:27:49` |

> `startTime`/`endTime` 不带时区后缀，意味着服务端只能按"服务器本地时间"或约定时区解析。
> 如果服务端跨时区部署，这里会是个隐患。

---

## 9. 与 totoro-paradise 的对比

| 维度 | totoro-paradise（龙猫校园） | 本项目（酷动·阳光跑） |
|---|---|---|
| 目标 | 原生 App 后端 | 小程序后端 |
| 报文 | 整体 RSA 加密 base64（1024 位，内嵌密钥） | **明文 JSON** |
| 鉴权 | 加密体里的 `token` 字段 | 自定义头 `sunshine-run` |
| 端点风格 | RPC（`platform/recrecord/sunRunExercises`） | REST |
| 打卡点 | 需按固定路线经过打卡点 | `selectedCheckpoints` + `passMode`（ORDERED/ANY，半径默认 30m） |
| 轨迹点数 | 按 0.0001° 步长插值到目标里程，无上限 | 采集侧 rawPoints 无上限；仅展示用折线裁到 500 |
| 过滤/平滑 | 无（只用高斯抖动加噪） | 5 点中值滤波 + 去重/瞬移/桥接/分段状态机 |
| 提交方式 | 立即提交（自由跑）/ 等满时长（阳光跑） | 会话式：start → finish |
| 反作弊 | 服务端时序校验（不能提交未来时间） | 客户端 `RunTrack` 过滤 + 服务端复算（强度未知） |

**结论：本项目的协议比 totoro 简单一个数量级** —— 没有加密、没有签名、没有时序谜题，
唯一的门槛是 token 获取和轨迹合理性。

---

## 10. 端点总表

完整清单（32 个端点，含方法、路径、导出名、是否显示 loading）见
[`wxapkg-unpack/API-INVENTORY.md`](../wxapkg-unpack/API-INVENTORY.md)，由
[`wxapkg-unpack/inventory.mjs`](../wxapkg-unpack/inventory.mjs) 从 `app-service.js` 自动生成，可用
`node inventory.mjs --write` 重新产出。

分组一览：

| 分组 | 端点数 | 说明 |
|---|---|---|
| `auth` | 4 | `wx-login` / `check` / `bind-student` / `logout` |
| `users` | 4 | profile、avatar、run-settings（读写） |
| `schools` | 3 | list / search / validate-student |
| `routes` | 1 | `/routes/nearby` |
| `routes/admin` | 6 | 路线管理（含 `PUT /routes/admin/{id}/status`） |
| `runs` | 6 | start / finish / cancel / 落库 / 列表 / 详情 / 近一周 |
| `run-rules` | 1 | `/run-rules/current` |
| `run-notices` | 1 | `/run-notices/campus-safety` |
| `run-exemptions` | 4 | 免跑申请 |
| `stats` | 1 | `/stats` |

---

## 11. 服务端跑步规则（实测）

`GET /run-rules/current` 返回**当前生效的校验规则** —— 这是服务端把"允许区间"直接下发给客户端，
也是判断一条记录能否通过的第一道门槛。

实测响应（某高校，2026 秋季学期）：

```json
{
  "id": 11,
  "schoolId": 1,
  "semesterId": 2,
  "semesterName": "2026 秋季学期",
  "sex": "1",
  "minDistance": 2,      // km，最低里程
  "minDuration": 480,    // 秒，最短用时  = 8 分钟
  "maxDuration": 1200,   // 秒，最长用时  = 20 分钟
  "minPace": 200,        // 秒/km，最快配速 = 3'20"/km
  "maxPace": 600         // 秒/km，最慢配速 = 10'00"/km
}
```

### 换算成实际约束

| 约束 | 数值 | 推导 |
|---|---|---|
| 里程下限 | **≥ 2 km** | `minDistance` |
| 用时 | **480 ~ 1200 秒**（8~20 分钟） | `minDuration` / `maxDuration` |
| 配速 | **200 ~ 600 秒/km** | `minPace` / `maxPace` |
| 由此推出的速度 | **6 ~ 18 km/h** | `3600 / maxPace` ~ `3600 / minPace` |
| 由此推出的里程上限 | **≈ 6 km** | `18 km/h × (1200/3600) h` |

> ⚠️ **`maxDuration` 是最容易被忽略的硬上限。** 里程没有显式上限，
> 但 20 分钟的时长上限 + 18 km/h 的速度上限，把有效里程锁死在 **2~6 km**。
> 想要 10 km 的记录，在这套规则下无论如何都凑不出来。

> ⚠️ 这套规则**每个学校、每个学期可能不同**（响应里带 `schoolId`/`semesterId`），
> 不要把它当常量写死，运行时拉一次。

### 对测试客户端的含义

`campus` / `free` 命令会在提交前拉一次 `/run-rules/current`，
若 `--distance` / `--duration` 落在区间外会**直接告警**，而不是等后端返回"记录无效"。

`/users/run-settings` 的实测响应（用户个人偏好，与校验无关）：

```json
{ "voiceAutoBroadcast": true, "gpsVoiceAlert": false, "vibrationFeedback": true }
```

---

## 12. 实测确认（2026-09-18，某高校）

以下都是**真实打过线上后端**得到的，不是从包里推断的。

### 12.1 `POST /runs` 响应

```json
{
  "id": 10483,
  "distance": 2,
  "startTime": "2026-09-18T22:47:17",
  "endTime": "2026-09-18T22:59:17",
  "duration": 720,
  "pace": "6'00\"",
  "calories": 120,
  "status": 1,
  "runDate": "2026-09-18",
  "runType": "FREE",
  "routeName": "自由跑",
  "selectedCheckpointCount": 0,
  "passedCheckpointCount": 0,
  "createdAt": "2026-09-18T22:47:17.536462817"
}
```

服务端接受客户端上报的 `distance`/`duration`/`pace`/`calories` 并**原样回显**；
`runDate` 从 `startTime` 推导；`createdAt` 是纳秒精度时间戳。

### 12.2 `GET /runs` 响应

```
{ records: [...], total, size, current, pages }
```

`records[]` 元素结构与 12.1 相同。分页参数 `page` / `size` 生效。

### 12.3 `GET /stats` 响应

```json
{
  "currentSemesterName": "2026 秋季学期",
  "standards": [{
    "id": 14, "label": "有效跑步 >= 22次（按单程标准）",
    "isMet": false, "details": "还差 22 次",
    "standardType": "RUN_COUNT_2KM", "standardValue": 22, "currentValue": 0
  }],
  "warningInfo": { "show": true, "title": "未达到目标", "description": "...", "gap": 22 },
  "weeklyStats": [ { "day": "周六", "distance": 0, "runCount": 0 }, ... ],
  "overviewStats": {
    "totalRuns": 0, "qualifiedRuns": 0, "totalDuration": 0,
    "totalCalories": 0, "avgDistance": 0, "avgPace": "0'00\""
  }
}
```

### 12.4 ⚠️ FREE 记录**不计入统计**

实测：提交一条 **2km / 12 分钟**（`runType: "FREE"`）的记录 —— 里程和用时都完全满足
`RUN_COUNT_2KM` 标准字面上的"2 公里 20 分钟内"：

| 检查 | 结果 |
|---|---|
| `GET /runs` | ✅ 记录存在（`total` 递增） |
| `GET /stats.overviewStats.totalRuns` | ❌ **0** |
| `GET /stats.standards[0].currentValue` | ❌ **0**，`details: "还差 22 次"` |

**结论：统计只计算 CAMPUS（校园跑）记录，FREE 只落库、不计分、不算达标次数。**

要达到学期标准，必须走会话流程：

```
POST /runs/sessions/start   → 拿到 sessionId + route + selectedCheckpoints
POST /runs/sessions/{id}/finish
```

而且 `routeData` 必须**真的经过打卡点** —— 这是 CAMPUS 与 FREE 的实质区别。

### 12.5 `/routes/nearby/rat-line` 返回 500（服务端 bug）

**先纠正一处**：真实路径是

```
GET /sunshine/routes/nearby/rat-line?lat=<lat>&lng=<lng>&limit=20
```

不是 `/routes/nearby`（后者也 500）。参数名是 `lat` / `lng`。

**现象**：用真机上报的真实 GPS 连续请求 **18 次，全部 500**：

```json
{ "code": 500, "message": "系统错误,请联系管理员", "timestamp": "..." }
```

而且**真机上也一半失败**（抓包里同一 URL 交替出现 `1.5kb` 与 `213b`，后者正是这句错误 JSON 的长度）。

**排除了 token 的嫌疑**：同一份 token 在 `/auth/check`、`/users/profile`、`/runs`、`/stats`、
`/routes/{id}` 上**全部正常**，只有 `rat-line` 稳定 500 —— 所以这是接口自身的 bug。

### 12.6 `GET /routes/{id}` —— 可用的路线来源

```
GET /sunshine/routes/{id}
```

只读，无需管理权限。**这是目前唯一可靠的路线查询接口。**

实测（schoolId=1 某高校）：

| id | name | 打卡点 | passMode | 起点半径 | 命中半径 |
|---|---|---|---|---|---|
| 1 | （路线不存在或未启用） | — | — | — | — |
| 2 | 体育馆 | 22 | ANY | 100 m | 30 m |
| 3 | **操场** | 15 | ANY | 100 m | 30 m |
| 4 | 操场（另一校区） | 14 | ANY | 100 m | 30 m |
| 5 | 第2食堂 | 13 | ANY | 100 m | 30 m |

响应结构：

```json
{
  "id": 3, "schoolId": 1, "name": "操场", "status": 1,
  "passMode": "ANY",                 // ORDERED = 按 seqNo 顺序 / ANY = 任意顺序
  "randomCheckpointCount": 0,
  "startAllowedRadiusM": 100,        // 起跑点必须在此半径内
  "checkpointHitRadiusM": 30,        // 轨迹必须经过每个打卡点此半径内
  "checkpoints": [
    { "id": 32, "pointName": "点位1", "latitude": 30.0000000,
      "longitude": 120.0000000, "seqNo": 1, "startPoint": true },
    ...
  ]
}
```

**`checkpoints` 数组本身就是路径折线** —— 没有单独的路径点字段。
`startPoint: true` 标记起跑点。

`node src/cli.mjs routes` 会遍历 1..20 把可用路线列出来（纯只读）。

### 12.7 "GPS 过于远" 只影响小程序 UI，不影响 API

小程序会因定位距离拒绝进入校园跑。但 **`POST /runs/sessions/start` 的起点坐标是客户端自己传的**：

```json
{ "runType": "CAMPUS", "routeId": "3",
  "startLatitude": 30.0000000, "startLongitude": 120.0000000 }
```

直接传**路线自带的起点**即可，不需要真实 GPS。

> 顺带：PC 微信没有 GPS 硬件，`wx.getLocation` 退化成网络定位。
> 实测本机公网 IP 是**中国移动**，IP 库定位到市中心 `31.2222, 121.4581`，
> 而人在主校区校区（约 50km 外）—— 所以小程序才报"过于远"。这是网络定位的固有问题。

### 12.8 校园跑全流程实测（routeId=3 操场主校区）

```
路线「操场」15 点  单圈 391m
✓ 通过服务端规则校验（里程≥2km, 用时 480~1200s）
runType=CAMPUS  routeId=3  start=(30.0000000, 120.0000000)   ← 取自路线起点
轨迹 145 点  2.00km / 12:00  6'00"/km（6 圈）
重放 RunTrack 入点 145 → 接受 145（无丢失）
打卡点 15/15 (ANY, 半径 30m)
```

> **环形路线必须闭合**：操场这类路线的首尾点差约 37m，里程超过单圈时轨迹会循环，
> 环回那一刻是个"跳跃"，会被 RunTrack 判瞬移丢掉。
> `generateTrack` 现在会自动补上闭合段（首尾距离 1~150m 时）。

### 12.9 ⚠️ 核心：CAMPUS 的时长由服务端计时，FREE 不是

**这是整个协议里最关键的一条。** 实测提交一条 CAMPUS 记录
（`routeId=3, distance=2, duration=1167, startTime=2026-09-17T18:38:00`）：

服务端 HTTP 200 接受、创建了记录，但**把它标成无效**：

```json
{
  "id": 10484, "distance": 2, "calories": 119,
  "duration": 1, "pace": "0'01\"",
  "startTime": "2026-09-18T23:43:36",
  "endTime":   "2026-09-18T23:43:36",
  "runDate":   "2026-09-18",
  "status": 2,
  "invalidReason": "单次用时不达标，范围应在 8~20 分钟",
  "runType": "CAMPUS", "routeId": 3, "sessionId": 13158,
  "snapshotUrl": "https://resources.sqcoe.com/sports/snapshots/2026/09/18/1000001/….png"
}
```

逐字段对照客户端发出去的值：

| 字段 | 客户端发送 | 服务端记录 | 结论 |
|---|---|---|---|
| `distance` | 2 | 2 | 采用客户端值 |
| `calories` | 119 | 119 | 采用客户端值 |
| **`duration`** | **1167** | **1** | **服务端自己算** |
| **`startTime`** | **2026-09-17T18:38:00** | **2026-09-18T23:43:36** | **= 会话创建时刻** |
| **`endTime`** | **2026-09-17T18:57:27** | **2026-09-18T23:43:36** | **= finish 调用时刻** |
| `runDate` | — | 2026-09-18 | 由服务端时间推导 |

**结论：CAMPUS 的 `duration` = 会话 `start` → `finish` 的真实经过时间。**
客户端传的时间字段被完全忽略，**无法倒填历史时间**。

要产生有效记录，必须让会话**真实持续 8~20 分钟**（区间来自 `/run-rules/current`）。

#### 12.9.1 ⚠️ v29 新增：上报的 `duration` 会与真实会话时长对账

上面「客户端传的字段被忽略」只说明了**记录里存的是什么**，不代表**传错没人管**。
新版（v29）服务端会把客户端上报的 `duration` 和自己记录的会话时长做比对，
**相差过大直接判「作弊」**（HTTP 200，但 `status: 2` 且记录删不掉，会计入账号）：

| 上报 `duration` | 服务端真实会话时长 | 差值 | 结果 |
|---|---|---|---|
| 720 | 724 | 4s | `status: 1` **有效**（差值来自客户端提前计时的零点几秒 + 网络往返） |
| 926 | 858 | 68s | `status: 2` **作弊**（按**原目标时长**上报、却提前 71 秒提交） |

**因此实现上有一条铁律：`finish` 时上报的 `duration` 必须是「此刻真实经过秒数」，不是原目标值。**
提前提交时，`pace` / `calories` / `endTime` / 轨迹 `routeData` 的时间戳都要按同一个
真实秒数一起重算 —— 否则轨迹里会出现「落在提交时刻之后」的未来点，同样对不上。

顺带一个推论：**提前提交是有下限的**。轨迹几何不变、时间被压缩，等于把配速改快，
压得太狠就会撞上 `minPace` / `minDuration`。所以正常的做法是让会话自然走完
（`duration` 与真实经过时间天然一致，差值只剩 1~4 秒），而不是手动抢跑。

### 12.10 CAMPUS 与 FREE 的检测机制对比（已全部实测）

| 维度 | FREE（`POST /runs`） | CAMPUS（`sessions/start` → `finish`） |
|---|---|---|
| 会话机制 | 无，一次请求直接落库 | 有，start / finish 两段 |
| 返回 `sessionId` | ❌ | ✅ |
| 返回 `routeId` / 打卡点数 | ❌ | ✅ `selectedCheckpointCount` / `passedCheckpointCount` |
| `distance` / `calories` | 采用客户端值 | 采用客户端值 |
| **`duration`** | **采用客户端值**（实测 720 → 720） | **服务端自算**（实测 1167 → **1**） |
| **`startTime` / `endTime`** | **采用客户端值，可倒填** ✅ | **服务端时间，不可控** ❌ |
| `runDate` | 由客户端 `startTime` 推导 | 服务端当前日期 |
| `pace` | **服务端重算**（见下） | 服务端重算 |
| 校验强度 | 规则层（里程/时长/配速区间） | 规则层 **+ 真实时长** |
| **是否计入学期标准** | **❌ 不计**（`totalRuns` 恒为 0） | **✅ 计**（实测 0 → 1，见 12.12） |
| 服务端生成轨迹快照 | ✅ | ✅ |

**倒填实测**：提交 `startTime=2026-09-17T18:38:00, duration=1167, distance=2`（FREE），
服务端原样保留、`runDate` 推导为 `2026-09-17`、`status: 1`（有效）：

```json
{ "id": 10485, "distance": 2, "duration": 1167,
  "startTime": "2026-09-17T18:38:00", "endTime": "2026-09-17T18:57:27",
  "runDate": "2026-09-17", "pace": "9'44\"", "calories": 120,
  "status": 1, "runType": "FREE",
  "snapshotUrl": "https://resources.sqcoe.com/sports/snapshots/2026/09/18/1000001/….png" }
```

**但 `totalRuns` 仍然是 0** —— 再次确认 FREE 不计分，无论数据多合理。

### 服务端会重算 `pace`

客户端传 `pace = "9'43\""`（向下取整），服务端记 `"9'44\""`（四舍五入）：

```
duration / distance = 1167 / 2 = 583.5 秒/km
客户端算法（小程序 RunTrack 同款）: floor(60 × (9.725 − 9))     → 43  → 9'43"
服务端算法（推断）              : round(583.5 − 9 × 60) = 43.5 → 44  → 9'44"
```

差别来自浮点误差：`60 × (p/60 − floor(p/60))` 得到 `43.4999…` 而 `p − 60×floor(p/60)` 得到精确的 `43.5`。
**客户端传的 `pace` 会被覆盖，不用费心算准。**

### 设计逻辑

**只有服务端能独立验证的数据才计分。**

- **FREE = 自报数据**。没有会话可掐表，服务端只能查规则层区间，
  时间字段完全由客户端说了算（可倒填）。所以它**故意不计入学期标准** —— 这不是 bug。
- **CAMPUS = 受监督的会话**。服务端自己计时、自己算打卡点，所以计分。

`status` 字段：`1` = 有效，`2` = 无效（附 `invalidReason`）。
无效记录**不计入** `totalRuns` / `qualifiedRuns`，协议里也没有删除接口。

### 12.11 由此确定的「正常范围」

在 `minDistance=2 / maxDuration=1200 / maxPace=600` 这套规则下：

| 想要的配速 | 2km | 3km | 4km | 5km |
|---|---|---|---|---|
| 6'00"/km (10km/h) | 12:00 ✅ | 18:00 ✅ | 24:00 ❌ 超时长 | 30:00 ❌ |
| 7'30"/km (8km/h) | 15:00 ✅ | 22:30 ❌ | 30:00 ❌ | 37:30 ❌ |
| 10'00"/km (6km/h) | 20:00 ✅ 边界 | 30:00 ❌ | — | — |

**`maxDuration = 1200s` 是真正的瓶颈**：用 6'00"/km 这种正常慢跑配速，
最多只能跑 **3.33 km**。想跑 5km 就必须上到 15 km/h，那已经不是慢跑了。

### 12.12 ✅ CAMPUS 真实计时跑通，并确认计入学期统计（2026-09-19）

12.9 只证明了"不等就无效"。12.12 补齐正面：**真的等满时长，记录就有效且计分。**

命令：

```bash
node src/cli.mjs campus --route-id 3 --distance 2 --duration 1080 --jitter --wait
```

会话 `sessionId=13163` 真实持续 **18:26**（1106 秒）后 finish，服务端返回：

```json
{
  "id": 10488, "distance": 2.05, "duration": 1106,
  "pace": "9'00\"", "calories": 123, "status": 1,
  "startTime": "2026-09-19T08:44:55", "endTime": "2026-09-19T09:03:21",
  "runDate": "2026-09-19",
  "runType": "CAMPUS", "routeId": 3, "sessionId": 13163,
  "routeName": "操场",
  "selectedCheckpointCount": 0, "passedCheckpointCount": 0,
  "snapshotUrl": "https://resources.sqcoe.com/sports/snapshots/2026/09/19/1000001/….png",
  "snapshotFormat": "PNG", "snapshotFileSize": 23783,
  "createdAt": "2026-09-19T09:03:21"
}
```

`duration` = **1106**，与客户端真实等待时间一致 —— 再次印证 12.9 的结论：
这个数字是服务端自己掐的表，客户端传什么都会被覆盖。

#### 关键：`/stats` 从 0 变成 1

这条记录提交**前后**的 `GET /stats` 对比：

| 字段 | 提交前 | 提交后 |
|---|---|---|
| `standards[0].currentValue` | 0 | **1** |
| `standards[0].details` | 还差 22 次 | **还差 21 次** |
| `warningInfo.gap` | 22 | **21** |
| `overviewStats.totalRuns` | 0 | **1** |
| `overviewStats.qualifiedRuns` | 0 | **1** |
| `overviewStats.totalDuration` | 0 | **1106** |
| `overviewStats.avgDistance` | 0 | **2.05** |
| `overviewStats.avgPace` | 0'00" | **9'00"** |
| `weeklyStats[周六]` | 0 / 0 | **2.05 / 1** |

**这是 12.4 与 12.10 那张对比表的最终裁决。** 在此之前，账号里有 3 条 `status: 1` 的
有效 FREE 记录（10482 3km、10483 2km、10485 倒填 2km），全部**一条都没计入**。
现在 1 条 CAMPUS 记录就把所有计数器从 0 推到 1。

> **一句话**：`status: 1` 只代表"这条数据本身合法"，
> **不代表"这条数据算数"**。算不算数由 `runType` 决定，FREE 永远不算。

#### 附带确认

- **会话 18 分钟不会超时** —— 部分回答了 §13.4。`sessionId=13163` 起于 08:44:54，
  finish 于 09:03:21，中间没有任何心跳或续期请求。
- **`selectedCheckpointCount` / `passedCheckpointCount` 恒为 0**，
  即使这是一条完全有效的 CAMPUS 记录。这两个字段目前**没有实际用途**，
  不要拿它判断打卡是否成功 —— 打卡校验发生在客户端 `RunTrack` 与 `finish` 的
  `routeData` 之间，不体现在记录里。
- **快照确实是按 `routeData` 画的**。下载 `snapshotUrl` 看到的是一张标准田径场椭圆，
  青点为起点、红点为终点；2.05km ÷ 391m 单圈 = 5.24 圈，所以终点落在起点前方约 50m
  而非重合，5 圈之间有轻微抖动偏移 —— 与生成的轨迹完全对应。
- **`pace` 再次被服务端重算**：客户端按 `2.0512km` 算出 `8'59"`，
  服务端按落库的 `2.05` 算出 `9'00"`。与 §12 的取整结论一致。

---

## 13. 尚未确认的部分

1. **服务端对 CAMPUS 的 `routeData` 点级校验强度未知**。
   12.12 证明了一条**完全合成的轨迹可以拿到 `status: 1` 并计分**，
   所以校验至少不要求真实 GPS。但边界在哪仍未测：
   完全笔直的假线、瞬移、超出操场范围的点，是否会被拦下？
   `fuzz --mode campus` 已备好（19 个变异用例 / 6 组），
   注意它会**真实占用 8~20 分钟/例**，成本很高。
2. **`/runs/sessions/start` 返回的 `route` 与 `selectedCheckpoints` 完整字段**未确认 ——
   12.5 的 500 挡住了探测路径。
3. **`routeId` 是否可为空**（自动选最近路线）未确认。
4. **并发会话限制未确认**；**会话超时时长 ≥ 18 分钟**（12.12 实测 13163 存活 18:26 无心跳）。
5. 管理端 `/routes/admin/*` 的权限模型未展开。
6. **`/routes/nearby` 的 500 是 bug 还是坐标要求**，需后端确认。
