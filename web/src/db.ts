import Dexie, { type Table } from 'dexie';
import type { Product } from './types';

// Локальное хранилище кассы (истина живёт на устройстве, п.8 ТЗ).
// products — зеркало каталога с сервера.
// outbox — очередь операций, не доехавших до сервера (обрыв сети не теряет данные).

export interface OutboxItem {
  id?: number;
  kind: 'create_product' | 'update_product' | 'receiving' | 'sale' | 'return' | 'log_event';
  payload: any;
  createdAt: number;
  tries: number;
  // Кто совершил операцию. Отправляем только под этим же пользователем, иначе
  // сервер запишет чек на того, кто вошёл позже.
  userId?: string;
  // Операция не прошла и требует внимания владельца. Не удаляем никогда:
  // молча потерянный чек — это потерянные деньги без следа.
  failed?: 0 | 1;
  lastError?: string;
}

// Строка открытого чека (живёт локально — не теряется при обрыве/перезагрузке).
export interface CartLine {
  /** Ключ строки. Для товара без штрихкода используем его id. */
  key: string;
  barcode: string | null;
  product_id: string;
  name: string;
  unit: 'pcs' | 'kg';
  unit_price: number;
  /** Снимок акции на момент добавления (цену считает сервер, это для показа). */
  discount_price?: number | null;
  discount_left?: number | null;
  qty: number;
}

class KassaDB extends Dexie {
  products!: Table<Product, string>;
  outbox!: Table<OutboxItem, number>;
  cart!: Table<CartLine, string>;

  constructor() {
    super('kassa');
    this.version(1).stores({
      products: 'id, barcode, name, category',
      outbox: '++id, kind, createdAt',
    });
    // v2: открытый чек (корзина).
    this.version(2).stores({
      products: 'id, barcode, name, category',
      outbox: '++id, kind, createdAt',
      cart: 'barcode',
    });
    // v3: очередь знает автора операции и умеет помечать проблемные.
    this.version(3).stores({
      products: 'id, barcode, name, category',
      outbox: '++id, kind, createdAt, userId, failed',
      cart: 'barcode',
    });
    // v4: весовой товар и товар без штрихкода — ключ строки чека больше
    // не может быть штрихкодом, он не у всех есть.
    this.version(4)
      .stores({
        products: 'id, barcode, name, category',
        outbox: '++id, kind, createdAt, userId, failed',
        cart: 'key',
      })
      .upgrade(async (tx) => {
        await tx.table('cart').clear(); // открытый чек старого формата не переносим
      });
  }
}

export const db = new KassaDB();
