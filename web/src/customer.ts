// Связь между окном кассира и окном покупателя (второй экран POS-терминала).
// Оба окна — одна вкладка одного origin на одном компьютере, поэтому
// BroadcastChannel доставляет сообщения мгновенно, без сервера и без сети.
//
// Сам чек экран клиента читает напрямую из Dexie (db.cart) — IndexedDB общий
// для всех окон, и Dexie обновляет подписки между окнами сам. Через канал шлём
// только «моментные» события: оплату и сдачу.

export type CustomerMsg =
  | { type: 'paid'; change: number } // продажа проведена, показать «спасибо»/сдачу
  | { type: 'ping' }; // кассир открыл экран клиента — можно поприветствовать

const channel = 'BroadcastChannel' in window ? new BroadcastChannel('kassa-customer') : null;

export function postCustomer(msg: CustomerMsg) {
  channel?.postMessage(msg);
}

export function onCustomer(cb: (msg: CustomerMsg) => void): () => void {
  if (!channel) return () => {};
  const handler = (e: MessageEvent) => cb(e.data as CustomerMsg);
  channel.addEventListener('message', handler);
  return () => channel.removeEventListener('message', handler);
}
