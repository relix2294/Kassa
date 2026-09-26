import { Router } from 'express';
import { query, withTx } from '../db.js';
import { writeLog } from '../lib/log.js';
import { broadcast } from '../lib/realtime.js';
import { lookupBarcode } from '../lib/barcode.js';
import { requireOwner } from '../lib/auth.js';
import { productFor, productsFor } from '../lib/sanitize.js';

export const productsRouter = Router();

// Экранирование значения для CSV.
function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Выгрузка каталога в CSV — только владелец. Это ваша ручная база местных
// товаров (штрихкод + название + цены). Остаток НЕ выгружаем: каталог
// переносимый, в новом магазине у товара свой остаток.
productsRouter.get('/export', requireOwner, async (_req, res) => {
  const rows = await query(
    `SELECT barcode, name, category, unit, sale_price, cost_price, min_stock
       FROM products WHERE is_archived = false ORDER BY name`,
  );
  const header = ['barcode', 'name', 'category', 'unit', 'sale_price', 'cost_price', 'min_stock'];
  const lines = [header.join(',')];
  for (const r of rows as any[]) {
    lines.push([r.barcode, r.name, r.category, r.unit, r.sale_price, r.cost_price, r.min_stock].map(csvCell).join(','));
  }
  // BOM — чтобы Excel открыл кириллицу правильно.
  const csv = '﻿' + lines.join('\r\n');
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="kassa-catalog-${date}.csv"`);
  res.send(csv);
});

// Загрузка каталога — только владелец. Тело: { products: [{barcode,name,...}] }.
// Существующие товары НЕ трогаем (защита от перезаписи цен): только добавляем
// новые. Остаток у добавленных = 0 (примут отдельно). Идеально для второго
// магазина: развернул систему → загрузил каталог → та же продукция.
productsRouter.post('/import', requireOwner, async (req, res) => {
  const items = req.body?.products;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Пустой каталог' });
  }
  const result = await withTx(async (client) => {
    let added = 0;
    let skipped = 0;
    for (const it of items) {
      const name = String(it?.name ?? '').trim();
      if (!name) { skipped++; continue; }
      const barcode = it?.barcode != null && String(it.barcode).trim() ? String(it.barcode).trim() : null;

      const exists = barcode
        ? (await client.query(`SELECT id FROM products WHERE barcode = $1`, [barcode])).rows[0]
        : (await client.query(`SELECT id FROM products WHERE barcode IS NULL AND lower(name) = lower($1)`, [name])).rows[0];
      if (exists) { skipped++; continue; }

      const unit = it?.unit === 'kg' ? 'kg' : 'pcs';
      await client.query(
        `INSERT INTO products (barcode, name, category, sale_price, cost_price, min_stock, unit)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [barcode, name, (it?.category ?? '') || null,
         Number(it?.sale_price) || 0, Number(it?.cost_price) || 0, Number(it?.min_stock) || 0, unit],
      );
      added++;
    }
    await writeLog(
      { type: 'catalog_import', entity: 'product', entityId: null, userId: req.user!.id, details: { added, skipped } },
      client,
    );
    return { added, skipped };
  });
  res.json(result);
});

// Список всех товаров. Кассиру отдаём без закупочных цен.
productsRouter.get('/', async (req, res) => {
  const rows = await query(
    `SELECT * FROM products WHERE is_archived = false ORDER BY name`,
  );
  res.json(productsFor(req, rows));
});

// Поиск товара по штрихкоду (для сканера).
productsRouter.get('/barcode/:barcode', async (req, res) => {
  const rows = await query(`SELECT * FROM products WHERE barcode = $1`, [req.params.barcode]);
  if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
  res.json(productFor(req, rows[0]));
});

// Подсказка названия по штрихкоду из внешней базы (для заведения нового товара).
productsRouter.get('/lookup/:barcode', async (req, res) => {
  const info = await lookupBarcode(req.params.barcode);
  res.json(info);
});

// Создать товар — только владелец (кассир не задаёт цены).
productsRouter.post('/', requireOwner, async (req, res) => {
  const { barcode, name, category, sale_price, cost_price, min_stock, unit } = req.body ?? {};
  const user_id = req.user!.id;
  // Штрихкод не обязателен: у весового товара и выпечки его обычно нет.
  if (!name) {
    return res.status(400).json({ error: 'Название обязательно' });
  }
  const cleanBarcode = typeof barcode === 'string' && barcode.trim() ? barcode.trim() : null;
  const cleanUnit = unit === 'kg' ? 'kg' : 'pcs';
  try {
    const rows = await query(
      `INSERT INTO products (barcode, name, category, sale_price, cost_price, min_stock, unit)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [cleanBarcode, name, category ?? null, sale_price ?? 0, cost_price ?? 0, min_stock ?? 0, cleanUnit],
    );
    const product = rows[0];
    await writeLog({
      type: 'product_create',
      entity: 'product',
      entityId: product.id,
      userId: user_id ?? null,
      details: { barcode, name, sale_price, cost_price },
    });
    broadcast('product_upsert', product, 'all');
    res.status(201).json(product);
  } catch (err: any) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Товар с таким штрихкодом уже есть' });
    }
    throw err;
  }
});

// Обновить карточку — только владелец. Изменения цен фиксируем в журнале отдельно.
productsRouter.patch('/:id', requireOwner, async (req, res) => {
  const { id } = req.params;
  const { name, category, sale_price, cost_price, min_stock, unit, stock } = req.body ?? {};
  const user_id = req.user!.id;

  // Остаток правит только владелец (это ручная корректировка, напр. ошибка приёма).
  // Отрицательным быть не может.
  let stockNum: number | null = null;
  if (stock !== undefined && stock !== null && stock !== '') {
    stockNum = Number(stock);
    if (!Number.isFinite(stockNum) || stockNum < 0) {
      return res.status(400).json({ error: 'Остаток не может быть отрицательным' });
    }
  }

  const before = (await query(`SELECT * FROM products WHERE id = $1`, [id]))[0];
  if (!before) return res.status(404).json({ error: 'not_found' });

  const rows = await query(
    `UPDATE products SET
        name       = COALESCE($2, name),
        category   = COALESCE($3, category),
        sale_price = COALESCE($4, sale_price),
        cost_price = COALESCE($5, cost_price),
        min_stock  = COALESCE($6, min_stock),
        unit       = COALESCE($7, unit),
        stock      = COALESCE($8, stock),
        updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [id, name ?? null, category ?? null, sale_price ?? null, cost_price ?? null, min_stock ?? null,
     unit === 'kg' || unit === 'pcs' ? unit : null, stockNum],
  );
  const after = rows[0];

  // Ручная правка остатка — отдельным типом в журнал (прозрачность: кто, было→стало).
  if (stockNum != null && Number(stockNum) !== Number(before.stock)) {
    await writeLog({
      type: 'stock_adjust', entity: 'product', entityId: id, userId: user_id ?? null,
      details: { name: before.name, old: Number(before.stock), new: Number(after.stock) },
    });
  }

  // Лог изменения цен (отдельным типом — важно для прозрачности).
  if (sale_price != null && Number(sale_price) !== Number(before.sale_price)) {
    await writeLog({
      type: 'price_change', entity: 'product', entityId: id, userId: user_id ?? null,
      details: { field: 'sale_price', old: before.sale_price, new: after.sale_price },
    });
  }
  if (cost_price != null && Number(cost_price) !== Number(before.cost_price)) {
    await writeLog({
      type: 'price_change', entity: 'product', entityId: id, userId: user_id ?? null,
      details: { field: 'cost_price', old: before.cost_price, new: after.cost_price },
    });
  }
  await writeLog({
    type: 'product_update', entity: 'product', entityId: id, userId: user_id ?? null,
    details: { changed: Object.keys(req.body ?? {}).filter((k) => k !== 'user_id') },
  });

  broadcast('product_upsert', after, 'all');
  res.json(after);
});

// Назначить или снять скидку на товар — только владелец.
// Тело: { discount_price, discount_limit }  или  { clear: true }
//   discount_price — акционная цена (должна быть меньше обычной);
//   discount_limit — сколько единиц продать по акции (пусто = без лимита).
productsRouter.post('/:id/discount', requireOwner, async (req, res) => {
  const { id } = req.params;
  const { discount_price, discount_limit, clear } = req.body ?? {};

  const before = (await query(`SELECT * FROM products WHERE id = $1`, [id]))[0];
  if (!before) return res.status(404).json({ error: 'not_found' });

  if (clear) {
    const rows = await query(
      `UPDATE products SET discount_price = NULL, discount_left = NULL, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [id],
    );
    await writeLog({ type: 'discount_clear', entity: 'product', entityId: id, userId: req.user!.id, details: { name: before.name } });
    broadcast('product_upsert', rows[0], 'all');
    return res.json(rows[0]);
  }

  const price = Number(discount_price);
  if (!(price >= 0)) return res.status(400).json({ error: 'Укажите акционную цену' });
  if (price >= Number(before.sale_price)) {
    return res.status(400).json({ error: 'Акционная цена должна быть меньше обычной' });
  }
  const limit = discount_limit === '' || discount_limit == null ? null : Number(discount_limit);
  if (limit != null && !(limit > 0)) return res.status(400).json({ error: 'Лимит количества должен быть больше нуля' });

  const rows = await query(
    `UPDATE products SET discount_price = $2, discount_left = $3, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, price, limit],
  );
  await writeLog({
    type: 'discount_set', entity: 'product', entityId: id, userId: req.user!.id,
    details: { name: before.name, old_price: before.sale_price, discount_price: price, limit },
  });
  broadcast('product_upsert', rows[0], 'all');
  res.json(rows[0]);
});

// Убрать товар из работы. Не удаляем: на него ссылаются проданные чеки
// и приёмки, история должна остаться целой.
productsRouter.post('/:id/archive', requireOwner, async (req, res) => {
  const { id } = req.params;
  const archive = req.body?.archive !== false;

  const rows = await query(
    `UPDATE products SET is_archived = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, archive],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'not_found' });

  await writeLog({
    type: archive ? 'product_archive' : 'product_restore',
    entity: 'product',
    entityId: id,
    userId: req.user!.id,
    details: { name: rows[0].name, barcode: rows[0].barcode },
  });

  broadcast('product_archive', { id, is_archived: archive }, 'all');
  res.json(rows[0]);
});

// Архив — чтобы владелец мог вернуть случайно убранный товар.
productsRouter.get('/archived', requireOwner, async (req, res) => {
  const rows = await query(`SELECT * FROM products WHERE is_archived = true ORDER BY name`);
  res.json(productsFor(req, rows));
});

// Присвоить товару без штрих-кода внутренний код — чтобы напечатать ценник
// со сканируемым штрих-кодом (местные/весовые/фасованные товары). Только владелец.
// Префикс «2» — общепринятый диапазон внутримагазинных кодов.
function genInternalBarcode(): string {
  let s = '2';
  for (let i = 0; i < 11; i++) s += Math.floor(Math.random() * 10);
  return s;
}

productsRouter.post('/:id/assign-barcode', requireOwner, async (req, res) => {
  const p = (await query(`SELECT * FROM products WHERE id = $1`, [req.params.id]))[0];
  if (!p) return res.status(404).json({ error: 'not_found' });
  if (p.barcode) return res.json(p); // уже есть — не трогаем

  let code = '';
  for (let tries = 0; tries < 25; tries++) {
    code = genInternalBarcode();
    const dup = await query(`SELECT 1 FROM products WHERE barcode = $1`, [code]);
    if (dup.length === 0) break;
    code = '';
  }
  if (!code) return res.status(500).json({ error: 'Не удалось сгенерировать код, попробуйте ещё раз' });

  const upd = (await query(`UPDATE products SET barcode = $2, updated_at = now() WHERE id = $1 RETURNING *`, [req.params.id, code]))[0];
  await writeLog({
    type: 'barcode_assign', entity: 'product', entityId: p.id, userId: req.user!.id,
    details: { name: p.name, barcode: code },
  });
  broadcast('product_upsert', upd, 'all');
  res.json(upd);
});
