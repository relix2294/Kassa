import type { Product } from './types';

// Единое правило «низкого остатка» для всего фронтенда (синхронно с сервером,
// TELEGRAM_LOW_STOCK_THRESHOLD): если у товара задан свой минимум — сравниваем
// с ним; если не задан — с общим порогом. Так дашборд, «Товары», аналитика,
// Telegram и выгрузка считают одинаково.
export const LOW_STOCK_THRESHOLD = 4;

export function isLowStock(p: Product): boolean {
  if (p.is_archived) return false;
  return p.min_stock > 0 ? p.stock <= p.min_stock : p.stock < LOW_STOCK_THRESHOLD;
}
