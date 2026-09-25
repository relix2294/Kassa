// Поиск названия товара по штрихкоду.
//
// ПРОВЕРЕНО 09.09.2026 на Open Food Facts (риск №1 из ТЗ, п.10):
//   Таджикистан — всего 40 товаров на всю страну, у части из них
//   название пустое. Узбекистан — 1646, Киргизия — 202.
// ПРОВЕРЕНО 23.09.2026 на открытой базе российского рынка (1,8 млн кодов):
//   Россия 514 тыс., Беларусь 102 тыс., Турция 13 тыс., Узбекистан 423,
//   Таджикистан — ни одного настоящего.
// Вывод: одной базы на всё нет, поэтому источники идут по очереди:
//   1. свой справочник barcode_catalog — мгновенно и без интернета
//      (открытые базы, прайсы поставщиков, прошлые ответы сервисов);
//   2. barcodes.tj — реестр GS1 Таджикистана, для местных кодов 488;
//   3. своя база по BARCODE_LOOKUP_URL, если владелец её настроил;
//   4. Open Food / Beauty / Products Facts — мировые открытые базы еды,
//      косметики и бытовой химии.
// Подсказка НИКОГДА не блокирует заведение товара: короткий таймаут,
// любая ошибка молча превращается в «названия нет».

import { query } from '../db.js';

// Штрихкод в том виде, в каком храним: без пробелов и управляющих символов
// (Tab/CR от сканера). Пустое — значит штрихкода нет.
export function cleanBarcode(raw: unknown): string | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) raw = String(Math.trunc(raw));
  if (typeof raw !== 'string') return null;
  const v = raw.replace(/[\s\x00-\x1f\x7f]/g, '');
  return v || null;
}

// Все написания одного кода: UPC-A (12 цифр) — это EAN-13 с нулём впереди.
// Та же логика, что в кассе (web/src/scan.ts).
export function barcodeVariants(code: string): string[] {
  if (/^\d{12}$/.test(code)) return [code, '0' + code];
  if (/^0\d{12}$/.test(code)) return [code, code.slice(1)];
  return [code];
}

export interface BarcodeInfo {
  name: string | null;
  category?: string | null;
  brand?: string | null;
  source: string | null;
}

// Ждать дольше секунды-полутора нельзя: кассир стоит с коробкой в руках.
const TIMEOUT_MS = 1500;
const USER_AGENT = 'Kassa-POS/1.0 (retail POS, Tajikistan)';

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
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  laquo: '«', raquo: '»', ndash: '–', mdash: '—', hellip: '…',
};

function decodeHtml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// Страница товара на barcodes.tj озаглавлена «<код> - <название>»
// (например «4883000111756 - Ирис «Амири»»). Берём заголовок страницы
// или og:title; страница без товара называется просто «Barcodes».
export function parseBarcodesTj(html: string, code: string): string | null {
  const titles = [
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1],
    /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1],
  ];
  for (const raw of titles) {
    if (!raw) continue;
    const t = decodeHtml(raw).replace(/\s+/g, ' ').trim();
    const m = /^(\d{8,14})\s*[-–—:]\s*(.+)$/.exec(t);
    if (!m || m[1] !== code) continue;
    let name = m[2].trim();
    // «"Пирожки с картошкой"» — внешние кавычки вокруг всего названия лишние.
    if (/^".*"$/.test(name)) name = name.slice(1, -1).trim();
    if (name.length > 1) return name;
  }
  return null;
}

async function fromBarcodesTj(code: string): Promise<string | null> {
  // В реестре GS1 Таджикистана только коды его участников — с префиксом 488.
  if (!/^488\d{10}$/.test(code)) return null;
  const html = await fetchText(`https://barcodes.tj/${code}`);
  return html ? parseBarcodesTj(html, code) : null;
}

async function fromCustom(code: string): Promise<string | null> {
  const custom = process.env.BARCODE_LOOKUP_URL;
  if (!custom) return null;
  return pickName(await fetchJson(custom.replace('{barcode}', encodeURIComponent(code))));
}

// Open Food Facts и его «братья» на том же движке: Open Beauty Facts —
// косметика и гигиена (шампуни, дезодоранты), Open Products Facts — бытовая
// химия и прочее (порошки). Базы мировые, в том числе турецкие, польские,
// казахские коды — те, под которыми товар приходит к нам, а не в Россию.
const OPEN_FACTS = [
  { host: 'world.openfoodfacts.org', source: 'openfoodfacts' },
  { host: 'world.openbeautyfacts.org', source: 'openbeautyfacts' },
  { host: 'world.openproductsfacts.org', source: 'openproductsfacts' },
];

async function fromOpenFacts(
  host: string,
  code: string,
): Promise<{ name: string; brand: string | null } | null> {
  const data = await fetchJson(
    `https://${host}/api/v2/product/${encodeURIComponent(code)}?fields=product_name,product_name_ru,generic_name,generic_name_ru,brands`,
  );
  const name = pickName(data);
  if (!name) return null;
  const brands = data?.product?.brands;
  const brand = typeof brands === 'string' && brands.trim() ? brands.split(',')[0].trim() : null;
  // «Шампунь» без марки мало что говорит — добавим марку, если её нет в названии.
  const full = brand && !name.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${name}` : name;
  return { name: full, brand };
}

// Запомнить найденное в справочнике: следующий такой скан — без сети.
export async function saveToCatalog(
  e: { barcode: string; name: string; category?: string | null; brand?: string | null; source: string },
  overwrite = false,
) {
  await query(
    `INSERT INTO barcode_catalog (barcode, name, category, brand, source)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (barcode) DO ${overwrite
       ? `UPDATE SET name = EXCLUDED.name,
            category = COALESCE(EXCLUDED.category, barcode_catalog.category),
            brand = COALESCE(EXCLUDED.brand, barcode_catalog.brand),
            source = EXCLUDED.source, updated_at = now()`
       : 'NOTHING'}`,
    [e.barcode, e.name, e.category ?? null, e.brand ?? null, e.source],
  );
}

export async function lookupBarcode(barcode: string): Promise<BarcodeInfo> {
  const code = cleanBarcode(barcode);
  if (!code) return { name: null, source: null };

  // 1. Свой справочник.
  try {
    const rows = await query(
      `SELECT * FROM barcode_catalog WHERE barcode = ANY($1) LIMIT 1`,
      [barcodeVariants(code)],
    );
    if (rows[0]) {
      return { name: rows[0].name, category: rows[0].category, brand: rows[0].brand, source: rows[0].source };
    }
  } catch {
    // справочника нет (не прогнали миграцию) — идём во внешние базы
  }

  // 2–4. Внешние источники спрашиваем одновременно, чтобы уложиться в таймаут,
  // а берём ответ по старшинству.
  const [tj, custom, ...open] = await Promise.all([
    fromBarcodesTj(code),
    fromCustom(code),
    ...OPEN_FACTS.map((o) => fromOpenFacts(o.host, code)),
  ]);
  const i = open.findIndex(Boolean);
  const found: BarcodeInfo | null = tj
    ? { name: tj, source: 'barcodes.tj' }
    : custom
      ? { name: custom, source: 'custom' }
      : i >= 0
        ? { name: open[i]!.name, brand: open[i]!.brand, source: OPEN_FACTS[i].source }
        : null;
  if (!found?.name) return { name: null, source: null };

  await saveToCatalog({ barcode: code, name: found.name, brand: found.brand, source: found.source! }).catch(() => {});
  return found;
}
