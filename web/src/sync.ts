import { db, type OutboxItem } from './db';
import { api } from './api';
import type { Product } from './types';

// Слой синхронизации между локальной кассой и сервером.
// - при старте тянем каталог с сервера в Dexie;
// - слушаем WebSocket, чтобы держать каталог свежим (изменения с других устройств);
// - мутации сначала пробуем онлайн; при обрыве кладём в outbox и повторяем.

type Listener = () => void;
const onlineListeners = new Set<Listener>();
export let isOnline = navigator.onLine;

function setOnline(v: boolean) {
  if (isOnline !== v) {
    isOnline = v;
    onlineListeners.forEach((l) => l());
  }
}
export function onOnlineChange(l: Listener) {
  onlineListeners.add(l);
  return () => onlineListeners.delete(l);
}

// --- Первичная загрузка каталога ---
export async function pullProducts() {
  try {
    const products = await api.listProducts();
    await db.products.bulkPut(products);
    setOnline(true);
  } catch {
    setOnline(false);
  }
}

// --- WebSocket: живые обновления каталога ---
function connectRealtime() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => setOnline(true);
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'product_upsert' && msg.payload) {
        db.products.put(msg.payload as Product);
      }
    } catch {
      /* ignore */
    }
  };
  ws.onclose = () => {
    setOnline(false);
    setTimeout(connectRealtime, 2000); // переподключение
  };
  ws.onerror = () => ws.close();
}

// --- Outbox: очередь операций при обрыве сети ---
async function applyOutboxItem(item: OutboxItem): Promise<Product | void> {
  switch (item.kind) {
    case 'create_product':
      return api.createProduct(item.payload);
    case 'update_product':
      return api.updateProduct(item.payload.id, item.payload);
    case 'receiving':
      return (await api.receive(item.payload)).product;
  }
}

async function enqueue(kind: OutboxItem['kind'], payload: any) {
  await db.outbox.add({ kind, payload, createdAt: Date.now(), tries: 0 });
}

let flushing = false;
export async function flushOutbox() {
  if (flushing) return;
  flushing = true;
  try {
    const items = await db.outbox.orderBy('createdAt').toArray();
    for (const item of items) {
      try {
        const product = await applyOutboxItem(item);
        if (product) await db.products.put(product);
        await db.outbox.delete(item.id!);
        setOnline(true);
      } catch (err: any) {
        // Сетевая ошибка — прекращаем, попробуем в следующий тик.
        if (err.status === undefined) {
          setOnline(false);
          break;
        }
        // Ошибка валидации (4xx) — операцию не повторить, убираем из очереди.
        await db.outbox.update(item.id!, { tries: item.tries + 1 });
        if (item.tries + 1 >= 5) await db.outbox.delete(item.id!);
      }
    }
  } finally {
    flushing = false;
  }
}

// --- Публичные мутации: сначала онлайн, при обрыве — в outbox ---
export async function createProduct(payload: any): Promise<{ queued: boolean; product?: Product }> {
  try {
    const product = await api.createProduct(payload);
    await db.products.put(product);
    return { queued: false, product };
  } catch (err: any) {
    if (err.status !== undefined) throw err; // ошибка сервера — показать пользователю
    await enqueue('create_product', payload);
    return { queued: true };
  }
}

export async function updateProductRemote(
  id: string,
  payload: any,
): Promise<{ queued: boolean; product?: Product }> {
  try {
    const product = await api.updateProduct(id, payload);
    await db.products.put(product);
    return { queued: false, product };
  } catch (err: any) {
    if (err.status !== undefined) throw err;
    await enqueue('update_product', { id, ...payload });
    return { queued: true };
  }
}

export async function receiveGoods(payload: {
  barcode: string;
  qty: number;
  cost_price: number;
  user_id?: string;
}): Promise<{ queued: boolean; product?: Product }> {
  try {
    const { product } = await api.receive(payload);
    await db.products.put(product);
    return { queued: false, product };
  } catch (err: any) {
    if (err.status !== undefined) throw err;
    await enqueue('receiving', payload);
    return { queued: true };
  }
}

// --- Запуск ---
export function initSync() {
  window.addEventListener('online', () => {
    setOnline(true);
    flushOutbox();
  });
  window.addEventListener('offline', () => setOnline(false));
  pullProducts();
  connectRealtime();
  // Раз в секунду: разбираем очередь (п.8 — зеркалирование раз в секунду).
  setInterval(flushOutbox, 1000);
}
