import { Router } from 'express';
import { withTx } from '../db.js';
import { writeLog } from '../lib/log.js';
import { broadcast } from '../lib/realtime.js';

export const receivingRouter = Router();

// Приём товара.
// Тело: { barcode, qty, cost_price, user_id }
// Товар должен уже существовать (новый заводится через POST /api/products).
// Пересчитываем среднюю скользящую себестоимость и увеличиваем остаток.
receivingRouter.post('/', async (req, res) => {
  const { barcode, qty, cost_price } = req.body ?? {};
  const user_id = req.user!.id;

  const qtyNum = Number(qty);
  const costNum = Number(cost_price);
  if (!barcode || !(qtyNum > 0) || !(costNum >= 0)) {
    return res.status(400).json({ error: 'Нужны barcode, qty > 0 и cost_price >= 0' });
  }

  try {
    const result = await withTx(async (client) => {
      // Блокируем строку товара на время пересчёта.
      const found = await client.query(
        `SELECT * FROM products WHERE barcode = $1 FOR UPDATE`,
        [barcode],
      );
      if (found.rows.length === 0) {
        return { notFound: true as const };
      }
      const product = found.rows[0];

      const oldStock = Number(product.stock);
      const oldCost = Number(product.cost_price);
      const newStock = oldStock + qtyNum;

      // Средняя скользящая: взвешенное среднее старого остатка и новой партии.
      const newCost =
        newStock > 0
          ? (oldStock * oldCost + qtyNum * costNum) / newStock
          : costNum;

      const upd = await client.query(
        `UPDATE products
            SET stock = $2, cost_price = $3, updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [product.id, newStock, Number(newCost.toFixed(2))],
      );

      const receipt = await client.query(
        `INSERT INTO stock_receipts (product_id, qty, cost_price, user_id)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [product.id, qtyNum, costNum, user_id ?? null],
      );

      await writeLog(
        {
          type: 'receiving',
          entity: 'product',
          entityId: product.id,
          userId: user_id ?? null,
          details: {
            qty: qtyNum,
            cost_price: costNum,
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

    broadcast('product_upsert', result.product);
    res.status(201).json(result);
  } catch (err) {
    console.error('Ошибка приёма:', err);
    res.status(500).json({ error: 'internal' });
  }
});
