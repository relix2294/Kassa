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
  barcode: string;
  product_id: string;
  name: string;
  unit_price: number;
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
  }
}

export const db = new KassaDB();
