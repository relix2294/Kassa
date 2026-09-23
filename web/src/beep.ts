// Звук скана. Кассир смотрит на товар, а не на экран: по звуку он должен
// понять, пробился товар или нет. Звук синтезируем — файлы не нужны,
// работает и без сети.

let ctx: AudioContext | null = null;

function tone(freq: number, ms: number, delayMs = 0) {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const start = ctx.currentTime + delayMs / 1000;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.08, start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + ms / 1000);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + ms / 1000);
  } catch {
    // Нет звука — не беда, касса работает и без него.
  }
}

// Короткий высокий «пик» — товар в чеке.
export function beepOk() {
  tone(1900, 80);
}

// Два низких гудка — товар не найден.
export function beepError() {
  tone(320, 160);
  tone(320, 160, 220);
}
