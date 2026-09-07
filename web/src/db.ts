import Dexie, { type Table } from 'dexie';
import type { Product } from './types';

// Локальное хранилище кассы (истина живёт на устройстве, п.8 ТЗ).
// products — зеркало каталога с сервера.
// outbox — очередь операций, не доехавших до сервера (обрыв сети не теряет данные).

export interface OutboxItem {
  id?: number;
  kind: 'create_product' | 'update_product' | 'receiving';
  payload: any;
  createdAt: number;
  tries: number;
}

class KassaDB extends Dexie {
  products!: Table<Product, string>;
  outbox!: Table<OutboxItem, number>;

  constructor() {
    super('kassa');
    this.version(1).stores({
      products: 'id, barcode, name, category',
      outbox: '++id, kind, createdAt',
    });
  }
}

export const db = new KassaDB();
