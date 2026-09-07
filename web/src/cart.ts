import { db, type CartLine } from './db';
import type { Product } from './types';
import { logLineCancel } from './sync';

// Операции с открытым чеком (корзиной). Всё пишется в Dexie, поэтому
// чек не теряется при перезагрузке или обрыве сети (п.8 ТЗ).

export async function addToCart(product: Product, qty = 1) {
  const existing = await db.cart.get(product.barcode);
  if (existing) {
    await db.cart.update(product.barcode, { qty: Number(existing.qty) + qty });
  } else {
    const line: CartLine = {
      barcode: product.barcode,
      product_id: product.id,
      name: product.name,
      unit_price: Number(product.sale_price),
      qty,
    };
    await db.cart.put(line);
  }
}

export async function setQty(barcode: string, qty: number) {
  if (qty <= 0) {
    await removeLine(barcode);
    return;
  }
  await db.cart.update(barcode, { qty });
}

// Удаление позиции из чека — фиксируем в журнале.
export async function removeLine(barcode: string, userId?: string) {
  const line = await db.cart.get(barcode);
  await db.cart.delete(barcode);
  if (line) {
    logLineCancel({ barcode: line.barcode, name: line.name, qty: line.qty }, userId);
  }
}

export async function clearCart() {
  await db.cart.clear();
}

export function cartTotal(lines: CartLine[]): number {
  return Number(lines.reduce((s, l) => s + l.unit_price * l.qty, 0).toFixed(2));
}
