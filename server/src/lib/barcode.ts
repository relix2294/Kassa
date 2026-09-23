// Поиск названия товара по штрихкоду во внешней базе.
//
// ПРОВЕРЕНО 09.09.2026 на Open Food Facts (риск №1 из ТЗ, п.10):
//   Таджикистан — всего 40 товаров на всю страну, у части из них
//   название пустое. Узбекистан — 1646, Киргизия — 202.
// Вывод: полагаться на внешнюю базу нельзя. Местные товары в ней
// практически отсутствуют, и владельцу всё равно придётся вводить
// названия руками. Поэтому:
//   - подсказка остаётся приятным бонусом (иногда срабатывает на импорте);
//   - она НИКОГДА не блокирует заведение товара: короткий таймаут,
//     любая ошибка молча превращается в «названия нет».

// Штрихкод в том виде, в каком храним: без пробелов и управляющих символов
// (Tab/CR от сканера). Пустое — значит штрихкода нет.
export function cleanBarcode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.replace(/[\s\x00-\x1f\x7f]/g, '');
  return v || null;
}

interface BarcodeInfo {
  name: string | null;
  source: string | null;
}

// Ждать дольше секунды нельзя: кассир стоит с коробкой в руках.
const TIMEOUT_MS = 1500;

// Достаём название из типичных полей разных баз, включая русские.
function pickName(data: any): string | null {
  const p = data?.product ?? data;
  const candidates = [
    p?.product_name_ru,
    p?.product_name,
    p?.generic_name_ru,
    p?.generic_name,
    p?.title,
    p?.name,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 1) return c.trim();
  }
  return null;
}

async function fetchJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': 'Kassa-POS/1.0 (retail POS, Tajikistan)' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function lookupBarcode(barcode: string): Promise<BarcodeInfo> {
  const code = encodeURIComponent(barcode.trim());
  if (!code) return { name: null, source: null };

  // Своя база, если владелец её настроил (URL с плейсхолдером {barcode}).
  const custom = process.env.BARCODE_LOOKUP_URL;
  if (custom) {
    const data = await fetchJson(custom.replace('{barcode}', code));
    const name = pickName(data);
    if (name) return { name, source: 'custom' };
  }

  // Open Food Facts — бесплатная, без ключа. Помогает в основном на импорте.
  const off = await fetchJson(
    `https://world.openfoodfacts.org/api/v2/product/${code}?fields=product_name,product_name_ru,generic_name,generic_name_ru,brands`,
  );
  const name = pickName(off);
  if (name) return { name, source: 'openfoodfacts' };

  return { name: null, source: null };
}
