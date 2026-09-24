// Разбор прайса или накладной поставщика (Excel .xlsx или CSV).
//
// Поставщики присылают таблицы как попало: шапка не в первой строке,
// колонки называются «Наименование», «Номенклатура», «Цена опт.», «ШК»…
// Поэтому ищем строку заголовка сами и угадываем колонки по названиям,
// а владелец может поправить сопоставление руками перед загрузкой.

export type Field = 'barcode' | 'name' | 'category' | 'unit' | 'cost_price' | 'sale_price' | 'qty';

export const FIELD_LABELS: Record<Field, string> = {
  barcode: 'Штрихкод',
  name: 'Название',
  category: 'Категория',
  unit: 'Ед. изм.',
  cost_price: 'Закупочная цена',
  sale_price: 'Цена продажи',
  qty: 'Количество',
};

export const FIELDS = Object.keys(FIELD_LABELS) as Field[];

export type Mapping = Record<Field, number>; // -1 — колонки нет

// Порядок важен: сначала точные признаки, общее «цена» — в самом конце.
const RULES: [Field, RegExp, RegExp?][] = [
  ['barcode', /штрих|barcode|\bean|gtin|^шк$|^ш\/к/i],
  ['name', /наимен|назван|номенклат|^товар|name|product/i, /код|артикул|group|групп/i],
  ['category', /категор|групп|category|group/i],
  ['unit', /ед\.?\s*изм|единиц|^ед\.?$|unit/i],
  ['cost_price', /закуп|себест|опт|поставщ|приход|вход|cost|purchase/i],
  ['sale_price', /розн|продаж|sale|retail|рекоменд/i],
  ['qty', /кол-?во|количеств|qty|quantity|^шт\.?$|^кол\.?$/i],
  ['cost_price', /^цена|стоимост|price/i, /сумма|итог|total/i],
];

function emptyMapping(): Mapping {
  return Object.fromEntries(FIELDS.map((f) => [f, -1])) as Mapping;
}

export function mapHeader(header: string[]): Mapping {
  const map = emptyMapping();
  const used = new Set<number>();
  for (const [field, re, not] of RULES) {
    if (map[field] !== -1) continue;
    const i = header.findIndex((h, idx) => !used.has(idx) && re.test(h.trim()) && !(not && not.test(h)));
    if (i !== -1) {
      map[field] = i;
      used.add(i);
    }
  }
  return map;
}

const isCode = (v: string) => /^(\d{8}|\d{12,14})$/.test(v.replace(/\s/g, ''));

// Строка заголовка — та, где узнаётся больше всего колонок (среди первых 20).
// Если шапки нет вовсе, угадываем по содержимому: штрихкод — колонка из
// 8–14 цифр, название — колонка с самым длинным текстом.
export function detectTable(rows: string[][]): { headerRow: number; mapping: Mapping } {
  let best = { headerRow: -1, mapping: emptyMapping(), score: 0 };
  rows.slice(0, 20).forEach((r, i) => {
    const m = mapHeader(r);
    const score = FIELDS.filter((f) => m[f] !== -1).length;
    if (score > best.score && (m.barcode !== -1 || m.name !== -1)) best = { headerRow: i, mapping: m, score };
  });
  if (best.score >= 2) return { headerRow: best.headerRow, mapping: best.mapping };

  const mapping = emptyMapping();
  const sample = rows.slice(0, 50);
  const width = Math.max(0, ...sample.map((r) => r.length));
  let codeCol = -1;
  let codeHits = 0;
  let nameCol = -1;
  let nameLen = 0;
  for (let c = 0; c < width; c++) {
    const vals = sample.map((r) => (r[c] ?? '').trim()).filter(Boolean);
    const hits = vals.filter(isCode).length;
    if (hits > codeHits) {
      codeHits = hits;
      codeCol = c;
    }
    const len = vals.filter((v) => /[a-zа-яё]/i.test(v)).reduce((s, v) => s + v.length, 0);
    if (len > nameLen) {
      nameLen = len;
      nameCol = c;
    }
  }
  mapping.barcode = codeCol;
  mapping.name = nameCol === codeCol ? -1 : nameCol;
  return { headerRow: -1, mapping };
}

// --- Чтение файла -----------------------------------------------------------

function parseCsv(text: string): string[][] {
  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? undefined : text.indexOf('\n'));
  const delim = [';', '\t', ','].map((d) => [d, firstLine.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delim) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// Русский Excel сохраняет CSV в Windows-1251. Если UTF-8 даёт «кракозябры» — пробуем её.
function decodeText(buf: ArrayBuffer): string {
  const utf = new TextDecoder('utf-8').decode(buf);
  if (!utf.includes('�')) return utf.replace(/^﻿/, '');
  return new TextDecoder('windows-1251').decode(buf);
}

export async function readTable(file: File): Promise<string[][]> {
  const ext = file.name.toLowerCase().split('.').pop();
  if (ext === 'xls') {
    throw new Error('Старый формат .xls не читается. Откройте файл в Excel и сохраните как .xlsx (или CSV).');
  }
  let rows: string[][];
  if (ext === 'xlsx') {
    const { readSheet } = await import('read-excel-file/browser');
    // Числа оставляем строками: иначе у штрихкода пропадут ведущие нули.
    const data = await readSheet(file, { parseNumber: (s: string) => s });
    rows = data.map((r) => r.map((c) => (c == null ? '' : c instanceof Date ? c.toISOString().slice(0, 10) : String(c))));
  } else {
    rows = parseCsv(decodeText(await file.arrayBuffer()));
  }
  // Пустые строки не выкидываем: номера строк в отчёте должны совпадать с Excel.
  return rows;
}

// Число из ячейки: «1 234,50», «12.5 сом» → 1234.5 / 12.5.
export function cellNumber(v: string | undefined): number | null {
  if (!v) return null;
  const s = v.replace(/[\s ]/g, '').replace(',', '.').replace(/[^\d.-]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export interface ImportRow {
  line: number;
  barcode?: string;
  name?: string;
  category?: string;
  unit?: string;
  cost_price?: number | null;
  sale_price?: number | null;
  qty?: number | null;
}

// Строки таблицы → строки для сервера. Штрихкод из ячейки «4600…, 4601…» — берём первый.
export function toImportRows(rows: string[][], headerRow: number, m: Mapping): ImportRow[] {
  const get = (r: string[], f: Field) => (m[f] >= 0 ? (r[m[f]] ?? '').trim() : '');
  const out: ImportRow[] = [];
  rows.forEach((r, i) => {
    if (i <= headerRow) return;
    const codes = get(r, 'barcode')
      .split(/[,;|]+/)
      .map((c) => c.replace(/\s/g, ''))
      // Excel хранит код числом и съедает ведущий ноль: UPC 036000291452 → 36000291452.
      .map((c) => (/^(\d{7}|\d{11})$/.test(c) ? '0' + c : c))
      .filter(Boolean);
    const row: ImportRow = {
      line: i + 1,
      barcode: codes[0] || undefined,
      name: get(r, 'name') || undefined,
      category: get(r, 'category') || undefined,
      unit: get(r, 'unit') || undefined,
      cost_price: cellNumber(get(r, 'cost_price')),
      sale_price: cellNumber(get(r, 'sale_price')),
      qty: cellNumber(get(r, 'qty')),
    };
    // Строка «Итого» внизу накладной — не товар.
    if (!row.barcode && row.name && /^(итого|всего|total)/i.test(row.name)) return;
    if (row.barcode || row.name) out.push(row);
  });
  return out;
}
