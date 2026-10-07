/**
 * 跑步规则的兜底推导。
 *
 * ---- 为什么需要它（2026-10-07 实测）----
 * `GET /run-rules/current` 对某些学校/学期会返回
 * `{"code":200,"message":"成功","timestamp":"…"}` —— **连 `data` 字段都没有**。
 *
 * 这不是客户端姿势问题：小程序 v27 / v29 / v30 三个版本发的都是同一个裸 GET，
 * 我们复刻的请求与它逐字一致。而且同一所学校（schoolId=1）、同一个学期（semesterId=2）
 * 在 9/18 时还能返回完整规则（minDistance=2 / minDuration=480 / maxDuration=1200 …），
 * 说明是**服务端把这条规则撤了或没配**。
 *
 * 小程序自己遇到这种情况也是放行的：`loadCurrentRule()` 里 `Number(e && e.minDistance)`
 * 得到 NaN → 当作无约束，`runAvailableNow` 默认 true。所以"读不到规则"不等于不能跑。
 *
 * ---- 兜底依据 ----
 * 唯一还有据可依的约束是**本学期达标标准**（`GET /stats`）：
 *
 *   { standardType: "RUN_COUNT_2KM", standardValue: 22,
 *     label: "有效跑步 >= 22次（按单程标准）", currentValue: 22 }
 *
 * `standardType` 里的数字就是「一次有效跑步至少要跑几公里」。
 * 这里**只推导这一条**（有硬证据）；时长 / 配速不臆造 —— 服务端本来就没下发，
 * 编一个假的区间只会让人以为学校有要求。
 */

/** `/^RUN_COUNT_(\d+(\.\d+)?)KM$/i` —— 从标准类型里取出「每次至少几公里」 */
const STANDARD_TYPE_RE = /^RUN_COUNT_(\d+(?:\.\d+)?)KM$/i;

/**
 * 服务端到底有没有下发规则内容。
 * `undefined` / `null` / `{}` / 全是空值的对象，都算「没有」。
 * @param {unknown} rules
 */
export function hasRuleFields(rules) {
  if (!rules || typeof rules !== 'object') return false;
  const KEYS = [
    'minDistance', 'minDuration', 'maxDuration', 'minPace', 'maxPace',
    'runAvailableNow', 'run_available_now', 'runUnavailableReason', 'run_unavailable_reason',
  ];
  return KEYS.some((k) => {
    const v = rules[k];
    return v !== undefined && v !== null && v !== '';
  });
}

/**
 * 从 `/stats` 的达标标准推导规则。推不出来返回 null（不乱猜）。
 *
 * @param {any} stats `/stats` 的 data
 * @returns {{minDistance:number, semesterName:string|null, derived:object}|null}
 */
export function deriveRulesFromStandards(stats) {
  const list = Array.isArray(stats?.standards) ? stats.standards : [];
  const std = list.find((s) => STANDARD_TYPE_RE.test(String(s?.standardType ?? '')));
  if (!std) return null;

  const km = Number(String(std.standardType).match(STANDARD_TYPE_RE)[1]);
  if (!Number.isFinite(km) || km <= 0) return null;

  return {
    minDistance: km,
    semesterName: stats?.currentSemesterName ?? null,
    derived: {
      from: 'stats.standards',
      standardType: String(std.standardType),
      standardLabel: std?.label ?? null,
      required: Number.isFinite(Number(std?.standardValue)) ? Number(std.standardValue) : null,
      current: Number.isFinite(Number(std?.currentValue)) ? Number(std.currentValue) : null,
    },
  };
}

/**
 * 取规则：先用服务端的，读不到就用达标标准推导。
 * 两个都拿不到才返回 null（调用方据此提示"规则未知"）。
 *
 * @param {{getCurrentRunRule:Function, getStats:Function}} api
 * @returns {Promise<{rules:object|null, source:'server'|'stats'|'none', error?:string}>}
 */
export async function resolveRunRules(api) {
  let error;
  try {
    const raw = await api.getCurrentRunRule();
    if (hasRuleFields(raw)) return { rules: raw, source: 'server' };
  } catch (e) {
    error = e?.message || String(e);
  }

  try {
    const stats = await api.getStats();
    const derived = deriveRulesFromStandards(stats);
    if (derived) return { rules: derived, source: 'stats', error };
  } catch (e) {
    error = error || e?.message || String(e);
  }

  return { rules: null, source: 'none', error };
}
