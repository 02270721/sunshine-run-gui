/**
 * 完成提醒 —— 校园跑要等 8~20 分钟，人一定会切到别的窗口。
 * 所以到点提交完必须主动喊一声，否则很容易错过结果。
 *
 * 三件事一起做（浏览器权限、API 支持各不相同，能中一个就够）：
 *   1. 系统通知（需要用户授权，点「开始跑步」时请求）
 *   2. 页面标题闪烁（不需要任何权限，切到别的标签页也能看见）
 *   3. 一声提示音（用 WebAudio 现场合成，不依赖任何音频文件）
 */

export async function ensureNotifyPermission(): Promise<boolean> {
  if (typeof window === 'undefined' || !('Notification' in window)) return false
  if (Notification.permission === 'granted') return true
  if (Notification.permission === 'denied') return false
  try {
    return (await Notification.requestPermission()) === 'granted'
  } catch {
    return false
  }
}

export function notifyDone(title: string, body: string) {
  if (typeof window === 'undefined') return

  // 1. 系统通知
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body, tag: 'sunshine-run' })
    }
  } catch { /* 有些浏览器在非用户手势下会拒绝，忽略 */ }

  // 2. 提示音
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new Ctx()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.frequency.value = 880
    gain.gain.value = 0.05
    osc.start()
    osc.stop(ctx.currentTime + 0.25)
    setTimeout(() => ctx.close().catch(() => {}), 800)
  } catch { /* 没有音频权限也无所谓 */ }

  // 3. 标题闪烁（回到页面就停）
  const original = document.title
  let on = false
  const timer = setInterval(() => {
    on = !on
    document.title = on ? '✅ 跑步已完成' : original
  }, 1200)
  const stop = () => {
    clearInterval(timer)
    document.title = original
    document.removeEventListener('visibilitychange', onVisible)
  }
  const onVisible = () => {
    if (!document.hidden) stop()
  }
  document.addEventListener('visibilitychange', onVisible)
  setTimeout(stop, 60_000)
}
