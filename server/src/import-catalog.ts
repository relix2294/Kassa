// Загрузка справочника штрихкодов (barcode_catalog) из открытой базы.
//
//   npm run import-catalog                  — скачать открытую базу российского
//                                             рынка (1,8 млн кодов) и загрузить;
//   npm run import-catalog -- файл.csv      — загрузить свой CSV (или .zip с CSV);
//   … --source=имя                          — пометка источника в справочнике;
//   … --overwrite                           — перезаписать уже известные коды.
//
// Подходит любой CSV, где в заголовке есть колонки штрихкода и названия
// (Barcode/Штрихкод/EAN и Name/Наименование/Название). Разделитель —
// ; , или табуляция, определяется сам.
//
// Справочник только подсказывает название при заведении товара. Цены и
// остатки он не трогает, в кассе ничего без владельца не появляется.

import { createReadStream, createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import yauzl from 'yauzl';
import { pool } from './db.js';

// Открытая база «товары российского рынка 2021–2022», github.com/aioke/barcodes.
// Лицензия в репозитории не указана — используем только как подсказку названий.
const DEFAULT_URL = 'https://github.com/aioke/barcodes/raw/main/barcodes_csv.zip';
const DEFAULT_SOURCE = 'aioke';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BATCH = 2000;

const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}`));
const fileArg = args.find((a) => !a.startsWith('--'));
const overwrite = !!flag('overwrite');
const source = flag('source')?.split('=')[1] || (fileArg ? 'import' : DEFAULT_SOURCE);

// --- Колонки ---------------------------------------------------------------

const COLS = {
  barcode: /barcode|штрих|^ean|gtin|шк$/i,
  name: /^name$|наимен|назван|^товар|product/i,
  category: /categor|категор|группа/i,
  brand: /vendor|brand|бренд|марка|производит/i,
};

type ColMap = Partial<Record<keyof typeof COLS, number>>;

function mapColumns(header: string[]): ColMap {
  const map: ColMap = {};
  header.forEach((h, i) => {
    for (const [key, re] of Object.entries(COLS) as [keyof typeof COLS, RegExp][]) {
      if (map[key] === undefined && re.test(h.trim())) {
        map[key] = i;
        break;
      }
    }
  });
  return map;
}

// Коды товаров бывают 8 (EAN-8), 12 (UPC-A), 13 (EAN-13) или 14 (GTIN-14) цифр.
// Всё остальное — внутренние артикулы магазинов, они нам не помогут.
function splitCodes(cell: string): string[] {
  return cell.split(/[\s,;|]+/).filter((c) => /^(\d{8}|\d{12,14})$/.test(c));
}

function cleanName(s: string): string {
  return s
    .replace(/\s*\(\d{8,14}\)/g, '') // «… 0,25 л (5449000265098)» — код в названии лишний
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function cleanCategory(s: string | undefined): string | null {
  const v = (s ?? '').replace(/\s+в\s+(Москве|Санкт-Петербурге)$/i, '').trim();
  return v || null;
}

// --- Потоковый разбор CSV (кавычки, "" внутри кавычек, переносы строк в поле) ---

async function* csvRows(stream: Readable): AsyncGenerator<string[]> {
  const decoder = new StringDecoder('utf8');
  let delim: string | null = null;
  let field = '';
  let row: string[] = [];
  let quoted = false;
  let pendingQuote = false; // встретили " внутри кавычек — это конец поля или ""?
  let first = true;
  let headBuf = '';

  function* feed(text: string): Generator<string[]> {
    for (const ch of text) {
      if (quoted) {
        if (pendingQuote) {
          pendingQuote = false;
          if (ch === '"') {
            field += '"';
            continue;
          }
          quoted = false; // кавычка закрыла поле, символ обрабатываем ниже
        } else if (ch === '"') {
          pendingQuote = true;
          continue;
        } else {
          field += ch;
          continue;
        }
      }
      if (ch === '"' && field === '') quoted = true;
      else if (ch === delim) {
        row.push(field);
        field = '';
      } else if (ch === '\n') {
        row.push(field.replace(/\r$/, ''));
        field = '';
        yield row;
        row = [];
      } else field += ch;
    }
  }

  for await (const chunk of stream) {
    let text = decoder.write(chunk as Buffer);
    if (first) {
      // Разделитель определяем по первой строке заголовка.
      headBuf += text;
      const nl = headBuf.indexOf('\n');
      if (nl === -1) continue;
      const head = headBuf.slice(0, nl).replace(/^﻿/, '');
      const counts = [';', ',', '\t'].map((d) => [d, head.split(d).length] as const);
      delim = counts.sort((a, b) => b[1] - a[1])[0][0];
      text = headBuf.replace(/^﻿/, '');
      first = false;
    }
    yield* feed(text);
  }
  yield* feed(decoder.end() + '\n');
}

// --- Источник: файл, zip или скачивание ------------------------------------

async function download(url: string): Promise<string> {
  const dir = join(__dirname, '../data');
  mkdirSync(dir, { recursive: true });
  const target = join(dir, url.split('/').pop() || 'catalog.zip');
  if (existsSync(target)) {
    console.log(`  уже скачано: ${target}`);
    return target;
  }
  console.log(`  скачиваем ${url} …`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`не удалось скачать: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(target));
  return target;
}

function openZipCsv(path: string): Promise<Readable> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      zip.on('entry', (entry: yauzl.Entry) => {
        if (/\.(csv|txt)$/i.test(entry.fileName) && !entry.fileName.startsWith('__MACOSX')) {
          zip.openReadStream(entry, (e, s) => (e || !s ? reject(e) : resolve(s)));
        } else zip.readEntry();
      });
      zip.on('end', () => reject(new Error('в архиве нет CSV-файла')));
      zip.readEntry();
    });
  });
}

// --- Загрузка ----------------------------------------------------------------

async function flush(batch: { barcode: string; name: string; category: string | null; brand: string | null }[]) {
  if (batch.length === 0) return 0;
  const conflict = overwrite
    ? `DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category, brand = EXCLUDED.brand,
         source = EXCLUDED.source, updated_at = now()`
    : 'DO NOTHING';
  // В одной пачке код может повториться — для DO UPDATE это ошибка, убираем дубли.
  const uniq = [...new Map(batch.map((b) => [b.barcode, b])).values()];
  const res = await pool.query(
    `INSERT INTO barcode_catalog (barcode, name, category, brand, source)
     SELECT b, n, c, v, $5 FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS t(b, n, c, v)
     ON CONFLICT (barcode) ${conflict}`,
    [uniq.map((b) => b.barcode), uniq.map((b) => b.name), uniq.map((b) => b.category), uniq.map((b) => b.brand), source],
  );
  return res.rowCount ?? 0;
}

async function main() {
  console.log('Загрузка справочника штрихкодов');
  const path = fileArg ?? (await download(DEFAULT_URL));
  if (!existsSync(path)) throw new Error(`файл не найден: ${path}`);
  const stream = /\.zip$/i.test(path) ? await openZipCsv(path) : createReadStream(path);

  await pool.query(`CREATE TABLE IF NOT EXISTS barcode_catalog (
    barcode text PRIMARY KEY, name text NOT NULL, category text, brand text,
    source text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);

  let cols: ColMap | null = null;
  let batch: Parameters<typeof flush>[0] = [];
  let rows = 0;
  let added = 0;
  const started = Date.now();

  for await (const r of csvRows(stream)) {
    if (!cols) {
      cols = mapColumns(r);
      if (cols.barcode === undefined || cols.name === undefined) {
        throw new Error(`в заголовке не нашлись колонки штрихкода и названия: ${r.join(' | ')}`);
      }
      continue;
    }
    rows++;
    const name = cleanName(r[cols.name!] ?? '');
    if (name.length < 2) continue;
    for (const barcode of splitCodes(r[cols.barcode!] ?? '')) {
      batch.push({
        barcode,
        name,
        category: cleanCategory(cols.category !== undefined ? r[cols.category] : undefined),
        brand: cols.brand !== undefined ? r[cols.brand]?.trim() || null : null,
      });
    }
    if (batch.length >= BATCH) {
      added += await flush(batch);
      batch = [];
      if (rows % 100000 < BATCH) process.stdout.write(`\r  строк: ${rows.toLocaleString('ru')}, добавлено: ${added.toLocaleString('ru')}`);
    }
  }
  added += await flush(batch);

  const [{ count }] = (await pool.query(`SELECT count(*)::int AS count FROM barcode_catalog`)).rows;
  console.log(
    `\n✓ Готово за ${Math.round((Date.now() - started) / 1000)} с: строк ${rows.toLocaleString('ru')}, ` +
      `добавлено кодов ${added.toLocaleString('ru')}. Всего в справочнике: ${count.toLocaleString('ru')}.`,
  );
  await pool.end();
}

main().catch(async (err) => {
  console.error('\nОшибка загрузки справочника:', err.message ?? err);
  await pool.end().catch(() => {});
  process.exit(1);
});
