import { Router } from 'express';
import { withTx } from '../db.js';
import { writeLog } from '../lib/log.js';
import { broadcast } from '../lib/realtime.js';
import { productFor } from '../lib/sanitize.js';
import { getOpenShift } from './shifts.js';

export const receivingRouter = Router();

// Приём товара.
// Тело: { barcode, qty, cost_price, user_id }
// Товар должен уже существовать (новый заводится через POST /api/products).
// Пересчитываем среднюю скользящую себестоимость и увеличиваем остаток.
receivingRouter.post('/', async (req, res) => {
  const { barcode, qty, cost_price, product_id } = req.body ?? {};
  const user_id = req.user!.id;
  const isOwner = req.user!.role === 'owner';

  const qtyNum = Number(qty);
  if ((!barcode && !product_id) || !(qtyNum > 0)) {
    return res.status(400).json({ error: 'Нужен товар (barcode или product_id) и qty > 0' });
  }
  // Закупочную цену задаёт только владелец (п.4 ТЗ). У кассира приём идёт
  // по текущей средней себестоимости — она при этом не меняется.
  const costNum = isOwner ? Number(cost_price) : null;
  if (isOwner && !(costNum! >= 0)) {
    return res.status(400).json({ error: 'cost_price >= 0' });
  }

  // Приём привязываем к смене, чтобы можно было спросить «что принимали
  // в смену Азиза» (п.16 аудита). Смена не обязательна: товар могут принять
  // и вне смены, тогда shift_id останется пустым.
  const openShift = await getOpenShift(user_id);

  try {
    const result = await withTx(async (client) => {
      // Блокируем строку товара на время пересчёта.
      const found = product_id
        ? await client.query(`SELECT * FROM products WHERE id = $1 FOR UPDATE`, [product_id])
        : await client.query(`SELECT * FROM products WHERE barcode = $1 FOR UPDATE`, [barcode]);
      if (found.rows.length === 0) {
        return { notFound: true as const };
      }
      const product = found.rows[0];

      const oldStock = Number(product.stock);
      const oldCost = Number(product.cost_price);
      const newStock = oldStock + qtyNum;

      // Цена партии: владелец задаёт свою, у кассира — текущая средняя
      // (тогда средняя не меняется, а закупочные цены ему не показываются).
      const batchCost = costNum ?? oldCost;

      // Средняя скользящая: взвешенное среднее старого остатка и новой партии.
      const newCost =
        newStock > 0
          ? (oldStock * oldCost + qtyNum * batchCost) / newStock
          : batchCost;

      const upd = await client.query(
        `UPDATE products
            SET stock = $2, cost_price = $3, updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [product.id, newStock, Number(newCost.toFixed(2))],
      );

      const receipt = await client.query(
        `INSERT INTO stock_receipts (product_id, qty, cost_price, user_id, shift_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [product.id, qtyNum, batchCost, user_id ?? null, openShift?.id ?? null],
      );

      await writeLog(
        {
          type: 'receiving',
          entity: 'product',
          entityId: product.id,
          userId: user_id ?? null,
          details: {
            qty: qtyNum,
            cost_price: batchCost,
            cost_set_by_owner: isOwner,
            old_stock: oldStock,
            new_stock: newStock,
            new_cost_avg: Number(newCost.toFixed(2)),
          },
        },
        client,
      );

      return { product: upd.rows[0], receipt: receipt.rows[0] };
    });

    if ('notFound' in result) {
      return res.status(404).json({ error: 'not_found', message: 'Сначала заведите товар' });
    }

    broadcast('product_upsert', result.product, 'all');
    res.status(201).json({ product: productFor(req, result.product), receipt: isOwner ? result.receipt : undefined });
  } catch (err) {
    console.error('Ошибка приёма:', err);
    res.status(500).json({ error: 'internal' });
  }
});
