// Генерация UUID для идемпотентности чеков/возвратов.
//
// crypto.randomUUID() доступен только в защищённом контексте (https или
// localhost). Касса в магазине часто открыта по http (http://IP), где этот
// метод отсутствует — раньше на этом падало оформление продажи. Поэтому:
// 1) используем crypto.randomUUID(), если он есть;
// 2) иначе строим UUID v4 из crypto.getRandomValues() — он работает и по http;
// 3) в самом крайнем случае — из Math.random().
export function genId(): string {
  const c: Crypto | undefined = globalThis.crypto;

  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }

  if (c && typeof c.getRandomValues === 'function') {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; // версия 4
    b[8] = (b[8] & 0x3f) | 0x80; // вариант 10x
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'));
    return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
