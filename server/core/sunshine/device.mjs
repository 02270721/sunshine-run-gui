/**
 * 设备标识与指纹 —— 逐句对照 app-service.js 里 webpack module 723 的 `getDeviceIdentity`。
 *
 * 小程序侧行为：
 *   deviceId     : 首次生成后写入 storage(DEVICE_ID)，之后固定复用
 *   fingerprint  : 由 9 个设备字段用 "|" 拼接后取 FNV-1a 32 位，输出 8 位小写 hex
 *
 * ⚠️ 注意 v() 里是 `16777619 * (e ^= c) >>> 0`，**没有**用 Math.imul。
 *    当乘积超过 2^53 时 JS 会丢精度，所以它并不是教科书版的 FNV-1a。
 *    这里必须原样照抄，否则和服务端记录的指纹对不上。
 */

const DEVICE_PREFIX = 'dev_';
const HEX = '0123456789abcdef';

function randomHex(n) {
  let out = '';
  for (let i = 0; i < n; i++) out += HEX[Math.floor(16 * Math.random())];
  return out;
}

/** 原样复刻小程序里的 deviceId 生成：dev_ + base36(ms) + 12 位随机 hex */
export function makeDeviceId() {
  return `${DEVICE_PREFIX}${Date.now().toString(36)}${randomHex(12)}`;
}

/** FNV-1a 32 位，但保留原实现的浮点精度行为 */
export function fnv1a32(input) {
  const s = input == null ? '' : String(input);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    // 与压缩代码完全等价的写法：h ^= c; h = (16777619 * h) >>> 0
    h = (16777619 * (h ^ s.charCodeAt(i))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 小程序用到的 9 个字段，顺序即拼接顺序，不可调换 */
export const FINGERPRINT_FIELDS = [
  'brand', 'model', 'system', 'platform',
  'language', 'version', 'pixelRatio', 'screenWidth', 'screenHeight',
];

/**
 * 根据设备信息算出 fingerprint。
 * @param {Record<string, unknown>} info 至少包含 FINGERPRINT_FIELDS 里的键
 */
export function fingerprintOf(info = {}) {
  const parts = FINGERPRINT_FIELDS.map((k) => (info[k] == null ? '' : String(info[k])));
  return fnv1a32(parts.join('|'));
}

/**
 * 造一个"像某台真机"的设备档案。测试时可固定 seed 复现同一台设备。
 * @param {object} [opts]
 * @param {string} [opts.deviceId] 复用已有 id
 * @param {object} [opts.info]     直接指定设备信息
 */
export function getDeviceIdentity({ deviceId, info } = {}) {
  const resolvedInfo = {
    brand: 'iPhone', model: 'iPhone15,4', system: 'iOS 17.4.1', platform: 'ios',
    language: 'zh_CN', version: '8.0.49', pixelRatio: 3, screenWidth: 393, screenHeight: 852,
    ...info,
  };
  return {
    deviceId: deviceId || makeDeviceId(),
    deviceFingerprint: fingerprintOf(resolvedInfo),
    deviceInfo: resolvedInfo,
  };
}
