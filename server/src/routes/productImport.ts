import type { Request, Response } from 'express';
import { withTx, query } from '../db.js';
import { writeLog } from '../lib/log.js';
import { broadcast } from '../lib/realtime.js';
import { barcodeVariants, cleanBarcode, saveToCatalog } from '../lib/barcode.js';
import { receiveInTx } from './receiving.js';
import { getOpenShift } from './shifts.js';

// Импорт прайса или накладной поставщика — только владелец.
//
// Так магазины и заводят товар без ручного набора: поставщик присылает
// Excel со штрихкодами, названиями и ценами. Касса разбирает файл у себя
// (web/src/importFile.ts) и присылает сюда уже строки.
//
// Тело: {
//   rows: [{ line, barcode?, name?, category?, unit?, cost_price?, sale_price?, qty? }],
//   markup?:        наценка в %, если в файле нет цены продажи;
//   receive?:       оприходовать количество из файла (накладная), иначе — только карточки;
//   update_prices?: обновить цену продажи у уже заведённых товаров;
//   category?:      категория для строк, где её нет.
// }
//
// Чужих товаров не трогает: уже заведённый товар не переименовывается и не
// меняет цену, если владелец явно не попросил. Всё в одной транзакции —
// либо файл принят целиком, либо ничего.

const MAX_ROWS = 5000;

interface InRow {
  line?: number;
  barcode?: unknown;
  name?: unknown;
  category?: unknown;
  unit?: unknown;
  cost_price?: unknown;
  sale_price?: unknown;
  qty?: unknown;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(typeof v === 'string' ? v.replace(/\s/g, '').replace(',', '.') : v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : typeof v === 'number' ? String(v) : '';
}

export async function importProducts(req: Request, res: Response) {
  const { rows, markup, receive, update_prices, category } = req.body ?? {};
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'В файле нет строк' });
  }
  if (rows.length > MAX_ROWS) {
    return res.status(400).json({ error: `Слишком большой файл: не больше ${MAX_ROWS} строк за раз` });
  }
  const markupNum = num(markup);
  const defaultCategory = str(category) || null;
  const userId = req.user!.id;
  const openShift = receive ? await getOpenShift(userId) : null;

  const skipped: { line: number; reason: string }[] = [];
  const warnings: { line: number; text: string }[] = [];
  let created = 0;
  let pricesUpdated = 0;
  let received = 0;
  const touched = new Map<string, any>();
  const forCatalog: { barcode: string; name: string; category: string | null }[] = [];

  // Строки без названия: вдруг справочник знает этот код.
  const noName = (rows as InRow[]).map((r) => cleanBarcode(r.barcode)).filter((b): b is string => !!b);
  const known = new Map<string, string>();
  if (noName.length) {
    const found = await query(`SELECT barcode, name FROM barcode_catalog WHERE barcode = ANY($1)`, [
      noName.flatMap(barcodeVariants),
    ]).catch(() => []);
    for (const f of found) known.set(f.barcode, f.name);
  }

  await withTx(async (client) => {
    for (const [i, r] of (rows as InRow[]).entries()) {
      const line = Number(r.line) || i + 1;
      const barcode = cleanBarcode(r.barcode);
      let name = str(r.name);
      const cost = num(r.cost_price);
      const sale = num(r.sale_price);
      const qty = num(r.qty);
      const unit = /^(кг|kg|килограмм)/i.test(str(r.unit)) ? 'kg' : 'pcs';
      const cat = str(r.category) || defaultCategory;

      if (!barcode && !name) continue; // пустая строка или итог таблицы
      if ((cost ?? 0) < 0 || (sale ?? 0) < 0 || (qty ?? 0) < 0) {
        skipped.push({ line, reason: 'отрицательная цена или количество' });
        continue;
      }

      // Ищем уже заведённый товар: по штрихкоду, а без него — по точному названию.
      const found = barcode
        ? await client.query(`SELECT * FROM products WHERE barcode = ANY($1) FOR UPDATE`, [barcodeVariants(barcode)])
        : await client.query(
            `SELECT * FROM products WHERE barcode IS NULL AND lower(name) = lower($1) AND is_archived = false FOR UPDATE`,
            [name],
          );
      let product = found.rows[0];

      if (product?.is_archived) {
        skipped.push({ line, reason: `«${product.name}» убран из работы — верните его в «Товарах»` });
        continue;
      }

      if (product) {
        if (update_prices && sale != null && sale > 0 && Number(product.sale_price) !== sale) {
          const upd = await client.query(
            `UPDATE products SET sale_price = $2, updated_at = now() WHERE id = $1 RETURNING *`,
            [product.id, sale],
          );
          await writeLog(
            {
              type: 'price_change', entity: 'product', entityId: product.id, userId,
              details: { field: 'sale_price', old: product.sale_price, new: sale, via: 'import' },
            },
            client,
          );
          product = upd.rows[0];
          pricesUpdated++;
        }
      } else {
        if (!name && barcode) {
          name = barcodeVariants(barcode).map((b) => known.get(b)).find(Boolean) ?? '';
        }
        if (!name) {
          skipped.push({ line, reason: 'нет названия' });
          continue;
        }
        const salePrice =
          sale != null && sale > 0
            ? sale
            : cost != null && cost > 0 && markupNum != null
              ? Number((cost * (1 + markupNum / 100)).toFixed(2))
              : 0;
        if (salePrice === 0) warnings.push({ line, text: `«${name}» заведён без цены продажи — укажите её до продажи` });

        const ins = await client.query(
          `INSERT INTO products (barcode, name, category, sale_price, cost_price, min_stock, unit)
           VALUES ($1, $2, $3, $4, $5, 0, $6) RETURNING *`,
          [barcode, name, cat, salePrice, cost ?? 0, unit],
        );
        product = ins.rows[0];
        await writeLog(
          {
            type: 'product_create', entity: 'product', entityId: product.id, userId,
            details: { barcode, name, sale_price: salePrice, cost_price: cost, via: 'import' },
          },
          client,
        );
        created++;
      }

      // Накладная: товар пришёл на склад. Себестоимость — средняя скользящая, как при обычном приёме.
      if (receive && qty != null && qty > 0) {
        const r2 = await receiveInTx(client, product, {
          qty,
          cost,
          userId,
          shiftId: openShift?.id ?? null,
          isOwner: true,
        });
        product = r2.product;
        received++;
      }

      touched.set(product.id, product);
      if (barcode && name) forCatalog.push({ barcode, name, category: cat });
    }

    await writeLog(
      {
        type: 'product_import', entity: 'product', userId,
        details: { rows: rows.length, created, prices_updated: pricesUpdated, received, skipped: skipped.length },
      },
      client,
    );
  });

  // Прайс поставщика — самый точный источник названий: запоминаем в справочнике.
  for (const c of forCatalog) {
    await saveToCatalog({ ...c, source: 'supplier' }, true).catch(() => {});
  }
  for (const p of touched.values()) broadcast('product_upsert', p, 'all');

  res.json({ created, prices_updated: pricesUpdated, received, skipped, warnings });
}
