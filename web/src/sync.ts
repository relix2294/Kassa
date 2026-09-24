import { db, type OutboxItem } from './db';
import { api } from './api';
import { getToken, getUser } from './auth';
import type { Product } from './types';

// Слой синхронизации между локальной кассой и сервером.
// - при старте тянем каталог с сервера в Dexie;
// - слушаем WebSocket, чтобы держать каталог свежим (изменения с других устройств);
// - мутации сначала пробуем онлайн; при обрыве кладём в outbox и повторяем.

type Listener = () => void;
const onlineListeners = new Set<Listener>();
export let isOnline = navigator.onLine;
// Когда пропала связь — чтобы плашка могла сказать, как давно её нет.
export let offlineSince: number | null = isOnline ? null : Date.now();

function setOnline(v: boolean) {
  if (isOnline !== v) {
    isOnline = v;
    offlineSince = v ? null : Date.now();
    onlineListeners.forEach((l) => l());
  }
}

// Проверка связи раз в несколько секунд. Без неё обрыв интернета может
// остаться незамеченным: «мёртвый» WebSocket закрывается не сразу, а браузер
// шлёт событие offline только когда отваливается сама сетевая карта.
const PING_EVERY = 5000;
const PING_TIMEOUT = 4000;
async function ping() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PING_TIMEOUT);
  try {
    const res = await fetch('/api/health', { cache: 'no-store', signal: ctrl.signal });
    setOnline(res.ok);
  } catch {
    setOnline(false);
  } finally {
    clearTimeout(timer);
  }
}
export function onOnlineChange(l: Listener) {
  onlineListeners.add(l);
  return () => {
    onlineListeners.delete(l);
  };
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

// --- Подписка на события realtime (для кабинета владельца) ---
type EventListener = (type: string, payload: any) => void;
const eventListeners = new Set<EventListener>();

export function onRealtimeEvent(l: EventListener) {
  eventListeners.add(l);
  return () => {
    eventListeners.delete(l);
  };
}

// --- WebSocket: живые обновления каталога ---
let ws: WebSocket | null = null;

function connectRealtime() {
  const token = getToken();
  // Без токена подключаться нет смысла: сервер закроет соединение.
  if (!token) {
    setTimeout(connectRealtime, 2000);
    return;
  }

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    setOnline(true);
    // Первым сообщением представляемся — сервер узнаёт роль.
    ws?.send(JSON.stringify({ type: 'auth', token }));
  };
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'product_upsert' && msg.payload) {
        db.products.put(msg.payload as Product);
      }
      // Товар убрали из работы — он не должен оставаться в кассе.
      if (msg.type === 'product_archive' && msg.payload?.id) {
        if (msg.payload.is_archived) db.products.delete(msg.payload.id);
        else pullProducts();
      }
      eventListeners.forEach((l) => l(msg.type, msg.payload));
    } catch {
      /* ignore */
    }
  };
  ws.onclose = () => {
    setOnline(false);
    ws = null;
    setTimeout(connectRealtime, 2000); // переподключение
  };
  ws.onerror = () => ws?.close();
}

// Смена пользователя — переподключаемся, чтобы сервер увидел новую роль.
export function reconnectRealtime() {
  if (ws) ws.close(); // onclose сам поставит переподключение
  else connectRealtime();
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
    case 'sale':
      await api.createSale(item.payload);
      return;
    case 'return':
      await api.createReturn(item.payload);
      return;
    case 'log_event':
      await api.logEvent(item.payload.type, item.payload.details);
      return;
  }
}

async function enqueue(kind: OutboxItem['kind'], payload: any) {
  await db.outbox.add({
    kind,
    payload,
    createdAt: Date.now(),
    tries: 0,
    userId: getUser()?.id, // операцию отправим только под этим же пользователем
    failed: 0,
  });
  notifyQueue();
}

// Сколько операций ждёт отправки и сколько застряло — для индикатора в шапке.
type QueueListener = () => void;
const queueListeners = new Set<QueueListener>();
export function onQueueChange(l: QueueListener) {
  queueListeners.add(l);
  return () => {
    queueListeners.delete(l);
  };
}
function notifyQueue() {
  queueListeners.forEach((l) => l());
}

export async function queueStats(): Promise<{ pending: number; failed: number }> {
  const all = await db.outbox.toArray();
  return {
    pending: all.filter((i) => !i.failed).length,
    failed: all.filter((i) => i.failed).length,
  };
}

export async function listFailed(): Promise<OutboxItem[]> {
  return db.outbox.filter((i) => !!i.failed).toArray();
}

// Повторить застрявшую операцию вручную (владелец разобрался с причиной).
export async function retryFailed(id: number) {
  await db.outbox.update(id, { failed: 0, tries: 0, lastError: undefined });
  notifyQueue();
  await flushOutbox();
}

const MAX_TRIES = 5;

let flushing = false;
export async function flushOutbox() {
  if (flushing) return;
  flushing = true;
  try {
    const currentUserId = getUser()?.id;
    const items = await db.outbox.orderBy('createdAt').toArray();

    for (const item of items) {
      if (item.failed) continue; // ждёт разбора владельцем

      // Операция отправляется только под своим автором: иначе сервер запишет
      // чек на того, кто вошёл позже, и в его смену.
      if (item.userId && item.userId !== currentUserId) continue;

      try {
        const product = await applyOutboxItem(item);
        if (product) await db.products.put(product);
        await db.outbox.delete(item.id!);
        setOnline(true);
        notifyQueue();
      } catch (err: any) {
        // Сети нет — не трогаем очередь, попробуем в следующий тик.
        if (err.status === undefined) {
          setOnline(false);
          break;
        }
        // Сервер ответил ошибкой. Пробуем ещё несколько раз, но НИКОГДА
        // не удаляем: пропавший чек — это деньги в кассе без записи.
        const tries = item.tries + 1;
        await db.outbox.update(item.id!, {
          tries,
          lastError: String(err.message || err.status),
          failed: tries >= MAX_TRIES ? 1 : 0,
        });
        notifyQueue();
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
  barcode?: string;
  product_id?: string;
  qty: number;
  cost_price?: number;
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

// Оптимистично меняем остаток локально (до подтверждения сервером).
async function adjustLocalStock(item: { barcode?: string; product_id?: string }, delta: number) {
  const p = item.product_id
    ? await db.products.get(item.product_id)
    : await db.products.where('barcode').equals(item.barcode!).first();
  if (p) await db.products.update(p.id, { stock: Number((Number(p.stock) + delta).toFixed(3)) });
}

// Провести продажу. items — строки корзины. Возвращает сдачу.
export async function completeSale(
  items: { barcode?: string; product_id?: string; qty: number; expected_price?: number }[],
  paymentMethod: 'cash' | 'card' | 'mixed',
  cashReceived: number | undefined,
  shiftId?: string,
  cardAmount?: number,
): Promise<{ queued: boolean }> {
  const client_id = crypto.randomUUID();
  // shift_id фиксируем на момент продажи: если чек уйдёт в очередь и доедет
  // после закрытия смены, он всё равно попадёт в свою смену.
  const payload = {
    client_id,
    items,
    payment_method: paymentMethod,
    cash_received: cashReceived,
    card_amount: cardAmount,
    shift_id: shiftId,
  };
  // Оптимистичное списание остатка.
  for (const it of items) await adjustLocalStock(it, -Number(it.qty));
  try {
    await api.createSale(payload);
    return { queued: false };
  } catch (err: any) {
    if (err.status !== undefined) {
      // Ошибка сервера — откатываем оптимистичное списание.
      for (const it of items) await adjustLocalStock(it, Number(it.qty));
      throw err;
    }
    await enqueue('sale', payload);
    return { queued: true };
  }
}

// Оформить возврат. items — что вернуть (с ценой из чека, если известна).
export async function completeReturn(
  items: { barcode?: string; product_id?: string; qty: number; unit_price?: number }[],
  reason: string | undefined,
  shiftId?: string,
): Promise<{ queued: boolean }> {
  const client_id = crypto.randomUUID();
  const payload = { client_id, items, reason, shift_id: shiftId };
  for (const it of items) await adjustLocalStock(it, Number(it.qty));
  try {
    await api.createReturn(payload);
    return { queued: false };
  } catch (err: any) {
    if (err.status !== undefined) {
      for (const it of items) await adjustLocalStock(it, -Number(it.qty));
      throw err;
    }
    await enqueue('return', payload);
    return { queued: true };
  }
}

// События прозрачности: отмена позиции и очистка чека. Никогда не теряем —
// при любой ошибке кладём в очередь, иначе след пропадает (п.22 аудита).
async function logEvent(type: string, details: any) {
  try {
    await api.logEvent(type, details);
  } catch {
    await enqueue('log_event', { type, details });
  }
}

export const logLineCancel = (details: any) => logEvent('line_cancel', details);
export const logCartClear = (details: any) => logEvent('cart_clear', details);

// --- Запуск ---
export function initSync() {
  window.addEventListener('online', () => {
    setOnline(true);
    flushOutbox();
  });
  window.addEventListener('offline', () => setOnline(false));
  pullProducts();
  setInterval(ping, PING_EVERY);
  connectRealtime();
  // Раз в секунду: разбираем очередь (п.8 — зеркалирование раз в секунду).
  setInterval(flushOutbox, 1000);
}
