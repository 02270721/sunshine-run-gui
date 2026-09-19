# 🏃 阳光跑助手 - 校园跑助手

## 注意 只做校园跑 · 使用者只需要装 Node.js 18+

### 🎯 主要功能

#### 🏃 校园跑 (Campus Run) ⭐
**唯一计入学期标准的那条路径**
- 选跑道、定里程与用时，自动生成符合学校规则的跑步轨迹
- **真实计时**：用时由学校服务器按「创建会话 → 提交」的真实间隔计算，程序陪你等满
- **提交前自检**：轨迹喂进真机算法重放 + 打卡点复算，不合格就**撤销会话**，不白交一条删不掉的无效记录
- **随机浮动**：目标值上做 ±0.09km / ±0.15km/h 浮动（同 totoro-paradise），浮动后重新校验规则
- **断点续跑**：等待期间可以关掉网页、关掉程序，重启后接着算

#### 🔑 一键抓取凭证
**不需要微信开发者工具，也不需要 Python / mitmproxy**
- 在本机临时架一个 HTTPS 代理，从你自己的流量里取出登录凭证
- **只解密 `*.sqcoe.com`**，其它网站原样直通
- 临时根证书每次现生成，抓完立即从证书库删除；系统代理改前备份、用完还原
- 中途被强杀也不怕：程序下次启动自动收拾，诊断页还有「一键还原」

#### 🧪 演练模式
- 在本机起一个假的学校后端，**规则、流程、服务端计时都和真实完全一致**
- 不碰真账号、不产生任何真实记录
- 唯一"省掉"的是碰真账号的风险，不是时间

#### 📊 记录与统计
- 学校服务器上的记录 + 本学期达标进度（还差几次）
- 本机执行流水：含失败与被撤销的尝试，用来回答「我那次到底怎么了」

#### 🩺 只读诊断
- 后端地址、设备身份、小程序接口逐个探活（全部是 GET，不写任何数据）

### 💡 使用步骤

1. **启动程序**: 双击 `启动阳光跑.bat`，浏览器会自动打开（地址 `http://127.0.0.1:2727`）
2. **接入账号**: 顶部「接入向导」→ 一键自动抓取 → 按提示重启 PC 微信并登录小程序
3. **设置参数**: 「校园跑」页选跑道，拖里程与用时滑杆（默认 2km / 12:00）
4. **开始执行**: 看「先预演一遍」全绿后点「开始跑步」，等满时间（页面可关）
5. **查看记录**: 到点自动提交，在「跑步记录」页看结果和达标进度

### ❓ 常见问题

| 现象 | 原因与做法 |
|---|---|
| 双击 bat 没反应 | 旧版本脚本的编码问题，已修（脚本现在纯 ASCII）。仍不行就用命令行跑 `node scripts\launch.mjs` 看报错 |
| 提示「登录状态已失效（401）」 | 凭证过期（协议里没有续期接口）。重做一次「接入向导」 |
| 提示「还没有绑定学号（403）」 | 先在小程序里绑定学号 |
| 「没读到任何路线」 | 协议里没有「列出全部路线」的接口，程序靠逐条试探 `/routes/1..24` 并缓存 6 小时。点「重新扫描跑道列表」 |
| 跑完显示「记录无效」 | 无效记录删不掉，所以程序尽量在提交前拦住。原因会写在结果页（用时不达标 / 里程不足 / 打卡点未全过…） |
| 2727 端口被占用 | 启动器会**自动换端口**（2728、2729…）并把实际地址打在窗口里 |
| 提示「无法启动 powershell.exe」 | 杀毒软件或公司策略拦住了。放行后重试，或改用「手动方式」接入 |
| 用完微信连不上网 | 忘了第二次重启微信。重启一次即可（浏览器不受影响） |
| 想彻底清除本机数据 | 关掉程序，删掉 `.data` 文件夹 |

---

## 🛠️ 开发者指南

### 环境要求
- Node.js 18+（本项目在 v24.16.0 上开发验证）
- pnpm 8+（或 npm）
- Windows（**只有一键抓凭证功能依赖 Windows** 自带的 PowerShell 与 certutil；其余功能跨平台）

### 本地开发

```bash
# 安装依赖
pnpm install

# 启动开发服务器（2727）
pnpm dev
```

### 构建部署

```bash
# 构建生产版本
pnpm build

# 启动生产服务器
pnpm start

# 打包成「解压双击就能用」的发布包（内含 .output，使用者不需要装依赖）
pnpm release
```

### 测试

```bash
pnpm core:test        # 核心自检 51 项：协议实现有没有被改坏
pnpm typecheck        # 类型检查（能抓出 useDisplay 这类只在浏览器里炸的错）
pnpm verify:render    # 无头浏览器把 5 个页面真渲染一遍，确认不白屏
pnpm verify:demo      # 演练全流程验收（会真的等满时间）
pnpm verify:capture   # 抓凭证端到端验收 15 项（本机闭环，不碰真域名）
pnpm core:sync --check # 核心协议实现与命令行版是否还有漂移
```

> `verify:capture` 用 `SUNSHINE_CAPTURE_REGKEY` 把「系统代理」写到测试注册表键，
> 用 `SUNSHINE_CAPTURE_UPSTREAM` 把上游指向本机假服务器 —— 所以它能在不碰真实域名、
> 不动真实系统代理的前提下，验证证书链、抓取、直通隔离和清理。

### 🧨 改这个项目前必须知道的坑

这些都是实打实踩过的，每条都对应一次「功能完全不工作」：

| # | 坑 | 后果 | 正确做法 |
|---|---|---|---|
| 1 | `.bat` 里写中文 | cmd.exe 在 `chcp 65001` 后按字节偏移解析 UTF-8 批处理会**错位**，从行中间开始执行 | **bat 保持纯 ASCII**，中文提示全部交给 Node 打印（`scripts/launch.mjs`） |
| 2 | 用 Vuetify 的 composable 没 import | `useDisplay is not defined` → 整站白屏 500，**构建不报错** | `import { useDisplay } from 'vuetify'`（autoImport 只管组件，不管 composable） |
| 3 | 生成的 `.ps1` 不带 UTF-8 BOM | PowerShell 5.1 按 GBK 读，中文注释的尾字节吃掉换行 → 莫名其妙的语法错误 | 写脚本时加 `\uFEFF` |
| 4 | 用 `Remove-Item` 删用户根证书 | 报 `UI is not allowed` 并**静默失败** → 临时根证书留在用户电脑上 | 必须用 `certutil -user -delstore Root <指纹>` |
| 5 | JS 模板字符串里出现反引号 | PowerShell 续行符 `` ` `` 会截断 JS 字符串 → 服务直接起不来 | PS 脚本每条 cmdlet 写一行，不用续行符 |
| 6 | 抓到凭证就先翻状态、再清理 | 网页/测试会读到「已完成但代理还没还原」的中间态（竞态） | `phase` 在**清理完成之后**才翻转 |
| 7 | 按目标时长准时提交 | 服务端少算约 2 秒（实测：本机 821s → 服务端 819s） | `SUBMIT_MARGIN_SEC = 4`，并夹进 `[minDuration+3, maxDuration-3]` |
| 8 | 假设 2727 一定可用 | Windows 动态保留端口段 / 上次没退干净的连接会让它 `EACCES` | 启动器逐个试端口，并记住上次成功的端口 |
| 9 | 用「首页返回 200」验收 SPA | `ssr: false` 时服务器只返回空壳 HTML，白屏也能过 | 用无头浏览器真渲染：`pnpm verify:render` |
| 10 | 测试里想改后端地址 | `login()` 取的是**凭证文件**里的 `baseUrl`，不是 `config.baseUrl` | 预置一份凭证文件指向假服务器 |

### 📁 项目结构

```
sunshine-run-gui/
├── pages/                    # 页面路由
│   ├── index.vue                 # 首页：接入状态、学校要求、达标进度、最近记录
│   ├── setup.vue                 # 接入向导：一键抓取 / 手动 / 演练模式开关
│   ├── campus.vue                # 校园跑主流程：设置 → 执行 → 结果（由服务端状态决定看哪一屏）
│   ├── records.vue               # 记录与统计（学校服务器记录 + 本机流水）
│   └── diagnose.vue              # 只读体检 + 抓包环境一键还原
├── components/               # Vue 组件
│   ├── CaptureWizard.vue         # 一键抓取凭证向导（知情确认 + 分步进度 + 实时日志）
│   ├── RunSetup.vue              # 跑道/里程/用时 + 实时预演
│   ├── RunExecution.vue          # 倒计时、阶段时间线、进度环
│   ├── RunResult.vue             # 结果（有效/无效/撤销）
│   ├── RuleCard.vue              # 学校规则翻译成人话
│   ├── RoutePreview.vue          # SVG 路线图（不依赖地图服务）
│   └── LogPanel.vue              # 运行日志面板
├── composables/              # Vue Composables
│   ├── useApi.ts                 # 接口调用（拆开 { ok, data|error } 信封）
│   ├── useStatus.ts              # 全局接入状态
│   └── useRun.ts                 # 跑步状态轮询
├── types/api.ts              # 接口形状（规则 / 路线 / 预演结果）
├── docs/PROTOCOL.md          # 协议实测说明（脱敏版，随仓库提供）
├── utils/
│   ├── format.ts                 # 显示用格式化
│   └── notify.ts                 # 完成提醒（系统通知 + 提示音 + 标题闪烁）
├── server/
│   ├── api/                      # 接口层：一个文件一个端点，文件名就是 URL
│   ├── plugins/capture-cleanup.ts# 启动时兜底还原抓包环境
│   ├── utils/respond.ts          # 统一的 { ok, data | error } 返回
│   └── core/sunshine/            # 核心层（协议 + 落盘 + 状态机）
│       ├── request.mjs api.mjs device.mjs metrics.mjs trackgen.mjs runtrack.mjs
│       │                         # ↑ 同步自命令行版，逐字未改
│       ├── rules.mjs             # 规则换算：合法区间、违规识别、人话描述
│       ├── jitter.mjs            # 随机浮动（浮动后重新校验规则）
│       ├── store.mjs             # 落盘（凭证/配置/状态/日志/路线缓存）
│       ├── service.mjs           # 业务层：登录、规则、路线、记录、统计、诊断、剪贴板
│       ├── runner.mjs            # 校园跑状态机（真实计时、断点续跑、提交前自检）
│       ├── capture.mjs           # 一键抓凭证：临时根证书 + 本机 HTTPS 代理 + 系统代理接管/还原
│       └── demo.mjs              # 演练模式的后端管理
├── scripts/
│   ├── launch.mjs                # 启动器：Node 版本闸门、自动挑端口、等就绪再开浏览器
│   ├── sync-core.mjs             # 从 sunshine-run-client 同步协议实现（含 --check）
│   ├── selftest.mjs              # 51 项核心自检
│   ├── mock-server.mjs           # 演练用假后端（忠实复刻服务端计时与打卡点复算）
│   ├── verify-demo.mjs           # 演练全流程验收（真的等满时间）
│   ├── verify-capture.mjs        # 抓凭证端到端验收（15 项）
│   ├── verify-render.mjs         # 无头浏览器渲染验收
│   └── release.mjs               # 打包发布 zip
├── app.vue nuxt.config.ts plugins/vuetify.ts
├── 启动阳光跑.bat                 # 双击即用（纯 ASCII，见坑 #1）
└── Node.js-not-found.txt         # 没装 Node.js 时自动用记事本打开的中文说明
```

### 🔧 配置说明

#### 运行期环境变量

| 变量名 | 说明 | 默认值 |
|---|---|---|
| `PORT` / `NITRO_PORT` | 本机服务端口 | `2727`（由启动器挑选） |
| `HOST` | 监听地址 | `127.0.0.1` |
| `SUNSHINE_DATA_DIR` | 本机数据目录 | 项目下的 `.data` |
| `SUNSHINE_CAPTURE_PORT` | 抓包代理端口 | `8899` |
| `SUNSHINE_CAPTURE_REGKEY` | 系统代理写哪个注册表键（**测试用**） | 真实的 Internet Settings |
| `SUNSHINE_CAPTURE_UPSTREAM` | 上游映射（**测试用**） | 空 |

#### 关键常量

| 位置 | 常量 | 值 | 含义 |
|---|---|---|---|
| `runner.mjs` | `SUBMIT_MARGIN_SEC` | `4` | 比目标多等 4 秒再提交（服务端少算约 2 秒） |
| `runner.mjs` | `BOUND_SAFETY_SEC` | `3` | 与规则上下限保持的安全距离 |
| `capture.mjs` | `PROXY_PORT` | `8899` | 抓包代理端口 |
| `capture.mjs` | `DEFAULT_ALLOW` | `sports.sqcoe.com` / `sqcoe.com` | 只解密这两个域名 |
| `launch.mjs` | `CANDIDATES` | `2727,2728,…` | 端口被占时依次尝试 |

#### 本机数据文件（`.data/`，都是人能看懂的 JSON）

```
credentials.json   凭证（明文，别提交、别外传）
config.json        偏好设置（演练模式开关、上次选的跑道、记住的端口）
state.json         进行中的跑步（断点续跑）
runs-log.json      本机执行流水（含失败与被撤销的尝试）
routes-cache.json  路线扫描缓存（6 小时）
```

### 📝 API 文档

接口层一共 20 个端点，全部返回 `{ ok: true, data }` 或 `{ ok: false, error, issues? }`。

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/auth/status` | GET | 当前接入状态（模式、是否登录、用户、后端地址） |
| `/api/auth/login` | POST | 保存凭证：`{ text }` / `{ from: 'clipboard' \| 'legacy' }` |
| `/api/auth/logout` | POST | 清除本机凭证 |
| `/api/config` | POST | 切换演练模式 / 保存偏好 |
| `/api/rules` | GET | 学校当前规则（已翻译成人话 + 数值） |
| `/api/routes` | GET | 可用路线（`?refresh=1` 强制重扫） |
| `/api/run/plan` | POST | **干跑预演**：生成轨迹 + 真机算法重放 + 打卡点判定（不发写请求） |
| `/api/run/start` | POST | 真正开始：建会话 → 生成 → 自检 → 进入等待 |
| `/api/run/state` | GET | 跑步进度（网页每秒轮询） |
| `/api/run/submit` | POST | 立即提交（提前交卷 / 重启后接着交） |
| `/api/run/cancel` | POST | 撤销会话（不产生任何记录） |
| `/api/run/reset` | POST | 清掉已结束的状态 |
| `/api/records` | GET | 学校服务器上的记录（分页） |
| `/api/stats` | GET | 本学期达标进度 |
| `/api/runs-log` | GET | 本机执行流水 |
| `/api/diagnose` | GET | 只读体检（后端/设备/接口连通性） |
| `/api/capture/start` | POST | 开始一键抓取（装临时证书 + 接管系统代理） |
| `/api/capture/state` | GET | 抓取进度（步骤 + 实时日志） |
| `/api/capture/stop` | POST | 停止抓取并还原系统 |
| `/api/capture/cleanup` | POST | 一键还原（代理 + 临时证书） |

#### 一次校园跑的完整数据流

```
拖动滑杆 → POST /api/run/plan    本机干跑：生成轨迹 + 重放 + 打卡点判定（不发写请求）
点开始   → POST /api/run/start   建会话 → 生成轨迹 → 自检 → 记下提交时刻 → 落盘
等待中   → GET  /api/run/state   每秒轮询；计时在服务端进程里，和浏览器无关
到点     → （服务端定时器）       用真实经过秒数再校验一次规则 → POST finish → 落盘 + 写流水
看结果   → RunResult.vue         有效/无效、原因、记录号
```

#### 一键抓取的时序

```
① 生成临时根证书（PowerShell 现生成）→ certutil 导入「当前用户 → 受信任的根证书颁发机构」
② 备份系统代理 → 指向 127.0.0.1:8899
③ 本机 HTTPS 代理：CONNECT 白名单域名 → 用叶子证书解密，提取 sunshine-run 头
                    其它域名 → 原样 TCP 直通（不解密）
④ 抓到 → 校验 /auth/check → 保存凭证
⑤ 关闭代理 → 还原系统代理 → certutil 删除证书 → 清空内存里的证书口令
```

### ⚠️ 已知风险

- **服务端可能事后清理记录**：实测有一条 `status=1` 的校园跑记录（id 10490）在几十分钟后从服务端消失，`/runs/{id}` 返回「跑步记录不存在」，而小程序接口清单里**没有任何删除记录的接口**。原因未查明。→ 建议每次跑完把记录号留档，本机 `.data/runs-log.json` 是目前唯一不会丢的凭据。
- **抓凭证只支持 Windows**：依赖系统证书库与系统代理；其它系统请走手动方式。
- **杀毒软件/公司策略**可能拦住 PowerShell 或证书导入。
- **轨迹是程序生成的**，不是在操场上真实采集的；服务端只做规则层与打卡点校验。请遵守所在学校的规定。

## 🔗 和其他两个项目的关系

| 项目 | 角色 |
|---|---|
| `sunshine-run-client` | 命令行**测试客户端**：11 个命令、19 个 fuzz 用例、抓包取 token。**协议真源**（未随本仓库发布） |
| `totoro-paradise` | 另一套后端（龙猫）的网页版，本项目的界面结构参考了它。两者协议不同，代码不通用 |
| **本项目** | 上面那套已核实的协议 + 给普通人用的网页界面。只做校园跑，只读诊断 + 演练模式 |

📄 协议说明见 [`docs/PROTOCOL.md`](docs/PROTOCOL.md)。

`server/core/sunshine/` 里那 6 个协议文件**不是手写的**，由 `scripts/sync-core.mjs` 从命令行版原样同步
（文件头与 `CORE-VERSION.json` 记着来源与哈希）。要改协议实现，改原项目那一份再同步回来 —— CLI 与 GUI 永远一致。

协议细节、实测结论、以及「服务端到底做了哪些校验」都在
[`docs/PROTOCOL.md`](docs/PROTOCOL.md)（由同作者的命令行版测试客户端产出，已脱敏）。

## ⚠️ 免责声明

本项目仅供学习和研究目的，请勿用于任何违反学校规定或法律法规的行为。使用本项目产生的任何后果由使用者自行承担。

## 📝 License

[AGPL-3.0](LICENSE)
