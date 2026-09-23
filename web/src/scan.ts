import { useEffect, useRef } from 'react';
import { db } from './db';
import type { Product } from './types';

// Всё про сканер штрихкодов в одном месте.
//
// USB-сканер для компьютера — это «клавиатура»: он очень быстро печатает
// символы кода и жмёт Enter. Отсюда все сложности, которые решаем здесь:
//   - в русской раскладке буквы кода (Code128 и т.п.) приходят кириллицей;
//   - один и тот же товар сканер может отдать как UPC-A (12 цифр) или
//     как EAN-13 с нулём впереди;
//   - весы в магазине печатают этикетку, где внутри кода зашит вес;
//   - если курсор ушёл из поля скана (кассир кликнул мышкой), код
//     «печатается» в никуда, а Enter нажимает кнопку под фокусом.

// Русская раскладка ЙЦУКЕН → те же клавиши в латинице.
const RU = 'йцукенгшщзхъфывапролджэячсмитьбю';
const EN = "qwertyuiop[]asdfghjkl;'zxcvbnm,.";
const LAYOUT: Record<string, string> = {};
for (let i = 0; i < RU.length; i++) {
  LAYOUT[RU[i]] = EN[i];
  LAYOUT[RU[i].toUpperCase()] = EN[i].toUpperCase();
}
LAYOUT['ё'] = '`';
LAYOUT['Ё'] = '~';

// Привести то, что напечатал сканер, к настоящему коду.
export function normalizeScan(raw: string): string {
  let out = '';
  for (const ch of raw) out += LAYOUT[ch] ?? ch;
  // Пробелы и управляющие символы (Tab, CR, GS у некоторых сканеров) — мусор.
  return out.replace(/[\s\x00-\x1f\x7f]/g, '');
}

// Все написания одного кода, под которыми товар может лежать в базе.
export function barcodeVariants(code: string): string[] {
  if (/^\d{12}$/.test(code)) return [code, '0' + code]; // UPC-A → EAN-13
  if (/^0\d{12}$/.test(code)) return [code, code.slice(1)]; // EAN-13 → UPC-A
  return [code];
}

// Контрольная цифра EAN-13 — отличает настоящую этикетку от случайного набора.
export function ean13Valid(code: string): boolean {
  if (!/^\d{13}$/.test(code)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(code[i]) * (i % 2 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === Number(code[12]);
}

// Весовая этикетка (весы с печатью). Самый распространённый формат:
//   2P CCCCC WWWWW K
//   2P    — префикс 20–29 (коды «для внутреннего использования» магазина),
//   CCCCC — код товара на весах (PLU),
//   WWWWW — вес в граммах,
//   K     — контрольная цифра.
// Префиксы 20–29 по правилам GS1 никогда не ставят на заводские товары,
// так что спутать этикетку с упаковкой нельзя.
// Если ваши весы настроены иначе (например, 6 цифр кода и 4 веса) —
// поправить здесь.
export interface WeightLabel {
  plu: string;
  kg: number;
}

export function parseWeightLabel(code: string): WeightLabel | null {
  if (!/^2\d{12}$/.test(code) || !ean13Valid(code)) return null;
  const kg = Number(code.slice(7, 12)) / 1000;
  if (!(kg > 0)) return null;
  return { plu: code.slice(2, 7), kg };
}

// Коды, под которыми владелец мог записать весовой товар:
// полный префикс+PLU («2200042»), PLU как на весах («00042») или без нулей («42»).
function pluVariants(code: string, plu: string): string[] {
  return [...new Set([code.slice(0, 7), plu, String(Number(plu))])];
}

export type ScanResult =
  | { kind: 'product'; code: string; product: Product; qty?: number }
  | { kind: 'weight_unknown'; code: string; plu: string }
  | { kind: 'not_found'; code: string };

// Найти товар по скану в локальной базе кассы (работает без сети).
export async function findByScan(raw: string): Promise<ScanResult | null> {
  const code = normalizeScan(raw);
  if (!code) return null;

  // Сначала точное совпадение — вдруг владелец сам завёл товар с таким кодом.
  const exact = await db.products.where('barcode').anyOf(barcodeVariants(code)).first();
  if (exact) return { kind: 'product', code, product: exact };

  const label = parseWeightLabel(code);
  if (label) {
    const candidates = await db.products.where('barcode').anyOf(pluVariants(code, label.plu)).toArray();
    const product = candidates.find((p) => p.unit === 'kg');
    if (product) return { kind: 'product', code, product, qty: label.kg };
    return { kind: 'weight_unknown', code, plu: label.plu };
  }

  return { kind: 'not_found', code };
}

// Сообщение для кассира, когда товар не нашёлся.
export function notFoundMessage(r: ScanResult, fallback = 'Товара нет в базе'): string {
  if (r.kind === 'weight_unknown') {
    return `Весовая этикетка: товар с кодом весов ${r.plu} не заведён. Впишите этот код в карточку весового товара.`;
  }
  return `${fallback} (${r.code})`;
}

// ---------------------------------------------------------------------------
// Перехват скана, когда курсор не в поле ввода.
//
// Сканер печатает символ каждые 5–40 мс, человек — не чаще раза в 80–100 мс.
// Если быстрая очередь символов закончилась Enter'ом — это скан: забираем
// код себе и не даём Enter нажать кнопку, на которой стоит фокус
// (иначе скан после клика по «Оплатить» может сам провести оплату).

const SCAN_GAP_MS = 60;
const SCAN_MIN_LEN = 4;

function isEditable(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true;
  if (t instanceof HTMLInputElement) {
    return !['button', 'submit', 'reset', 'checkbox', 'radio'].includes(t.type);
  }
  return false;
}

// Символ клавиши без зависимости от раскладки (по физической клавише).
function keyChar(e: KeyboardEvent): string | null {
  const m = /^Key([A-Z])$/.exec(e.code);
  if (m) return e.shiftKey ? m[1] : m[1].toLowerCase();
  const d = /^(?:Digit|Numpad)(\d)$/.exec(e.code);
  if (d) return d[1];
  return e.key.length === 1 ? e.key : null;
}

export function useScanCapture(onScan: (code: string) => void, enabled = true) {
  const handler = useRef(onScan);
  handler.current = onScan;

  useEffect(() => {
    if (!enabled) return;
    let buf = '';
    let last = 0;

    function onKey(e: KeyboardEvent) {
      if (isEditable(e.target) || e.ctrlKey || e.altKey || e.metaKey) {
        buf = '';
        return;
      }
      const now = performance.now();
      if (now - last > SCAN_GAP_MS) buf = '';
      last = now;

      if (e.key === 'Enter') {
        if (buf.length >= SCAN_MIN_LEN) {
          e.preventDefault();
          e.stopPropagation();
          handler.current(buf);
        }
        buf = '';
        return;
      }
      const ch = keyChar(e);
      if (ch) buf += ch;
    }

    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [enabled]);
}
