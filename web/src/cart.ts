import { db, type CartLine } from './db';
import type { Product } from './types';
import { logLineCancel, logCartClear } from './sync';

// Операции с открытым чеком (корзиной). Всё пишется в Dexie, поэтому
// чек не теряется при перезагрузке или обрыве сети (п.8 ТЗ).

// Ключ строки: штрихкод, если он есть, иначе id товара. У весового товара
// и выпечки штрихкода нет, а строка чека всё равно нужна уникальная.
function lineKey(product: Product): string {
  return product.barcode || product.id;
}

// qty: для штучного — количество, для весового — вес в килограммах.
export async function addToCart(product: Product, qty = 1) {
  const key = lineKey(product);
  const existing = await db.cart.get(key);

  if (existing) {
    await db.cart.update(key, { qty: Number((Number(existing.qty) + qty).toFixed(3)) });
    return;
  }

  const line: CartLine = {
    key,
    barcode: product.barcode,
    product_id: product.id,
    name: product.name,
    unit: product.unit === 'kg' ? 'kg' : 'pcs',
    unit_price: Number(product.sale_price),
    discount_price: product.discount_price ?? null,
    discount_left: product.discount_left ?? null,
    qty,
  };
  await db.cart.put(line);
}

// Сумма строки с учётом акции (совпадает с расчётом сервера). При лимите
// количества часть единиц идёт по акции, часть — по обычной цене.
export function lineTotal(l: CartLine): number {
  const active = l.discount_price != null && (l.discount_left == null || l.discount_left > 0);
  if (!active) return Number((l.unit_price * l.qty).toFixed(2));
  const dUnits = l.discount_left == null ? l.qty : Math.min(l.qty, l.discount_left);
  return Number((dUnits * (l.discount_price as number) + (l.qty - dUnits) * l.unit_price).toFixed(2));
}

// Есть ли на строке действующая акция.
export function lineHasDiscount(l: CartLine): boolean {
  return l.discount_price != null && (l.discount_left == null || l.discount_left > 0);
}

export async function setQty(key: string, qty: number) {
  if (qty <= 0) {
    await removeLine(key);
    return;
  }
  await db.cart.update(key, { qty: Number(qty.toFixed(3)) });
}

// Удаление позиции из чека — фиксируем в журнале.
export async function removeLine(key: string) {
  const line = await db.cart.get(key);
  await db.cart.delete(key);
  if (line) {
    logLineCancel({ barcode: line.barcode, name: line.name, qty: line.qty });
  }
}

// Очистка чека — это удаление уже набранных позиций. По ТЗ чек нельзя
// удалить бесследно, поэтому пишем в журнал состав и сумму.
export async function clearCart(logIt = false) {
  if (logIt) {
    const lines = await db.cart.toArray();
    if (lines.length > 0) {
      logCartClear({
        items: lines.map((l) => ({ name: l.name, qty: l.qty })),
        total: cartTotal(lines),
      });
    }
  }
  await db.cart.clear();
}

export function cartTotal(lines: CartLine[]): number {
  return Number(lines.reduce((s, l) => s + lineTotal(l), 0).toFixed(2));
}

// Как показать количество: «2 шт» или «0.35 кг».
export function formatQty(line: { qty: number; unit: 'pcs' | 'kg' }): string {
  return line.unit === 'kg' ? `${Number(line.qty)} кг` : `${Number(line.qty)} шт`;
}
