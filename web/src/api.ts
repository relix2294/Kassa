import type { Product, User, LogRow } from './types';
import { getToken, logout } from './auth';

// Тонкий клиент к серверному API. Базовый путь идёт через прокси Vite (/api).
async function req<T>(path: string, options?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options?.headers ?? {}),
    },
  });
  if (!res.ok) {
    // 401 на защищённых маршрутах — токен протух, разлогиниваем (кроме самого входа).
    if (res.status === 401 && !path.startsWith('/auth/')) logout();
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || res.statusText) as Error & { status?: number; body?: any };
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => req<{ ok: boolean }>('/health'),
  listProducts: () => req<Product[]>('/products'),
  getByBarcode: (barcode: string) => req<Product>(`/products/barcode/${encodeURIComponent(barcode)}`),
  lookupBarcode: (barcode: string) =>
    req<{ name: string | null; source: string | null }>(`/products/lookup/${encodeURIComponent(barcode)}`),
  createProduct: (p: Partial<Product> & { user_id?: string }) =>
    req<Product>('/products', { method: 'POST', body: JSON.stringify(p) }),
  updateProduct: (id: string, p: Partial<Product> & { user_id?: string }) =>
    req<Product>(`/products/${id}`, { method: 'PATCH', body: JSON.stringify(p) }),
  receive: (payload: { barcode: string; qty: number; cost_price?: number }) =>
    req<{ product: Product }>('/receiving', { method: 'POST', body: JSON.stringify(payload) }),
  createSale: (payload: {
    client_id: string;
    items: { barcode: string; qty: number }[];
    payment_method: 'cash' | 'card';
    cash_received?: number;
    shift_id?: string;
  }) => req<{ sale: any; duplicate?: boolean }>('/sales', { method: 'POST', body: JSON.stringify(payload) }),
  createReturn: (payload: {
    client_id: string;
    items: { barcode: string; qty: number; unit_price?: number }[];
    reason?: string;
    shift_id?: string;
  }) => req<{ ret: any; duplicate?: boolean }>('/returns', { method: 'POST', body: JSON.stringify(payload) }),
  listSales: (limit = 100) => req<any[]>(`/sales?limit=${limit}`),
  listReturns: (limit = 100) =>
    req<{
      id: string; total: number; reason: string | null; created_at: string;
      username: string | null; full_name: string | null;
      items: { name: string; qty: number; line_total: number }[];
    }[]>(`/returns?limit=${limit}`),
  currentShift: () => req<{ shift: any | null; expected?: number; stats?: any }>('/shifts/current'),
  openShift: (opening_cash: number) =>
    req<{ shift: any }>('/shifts/open', { method: 'POST', body: JSON.stringify({ opening_cash }) }),
  closeShift: (counted_cash: number) =>
    req<{ shift: any }>('/shifts/close', { method: 'POST', body: JSON.stringify({ counted_cash }) }),
  listShifts: (limit = 100) => req<any[]>(`/shifts?limit=${limit}`),
  summary: (period: string) =>
    req<{
      period: string; receipts: number; revenue: number; margin: number;
      cash: number; card: number; refunds_count: number; refunds_total: number;
    }>(`/dashboard/summary?period=${period}`),
  topProducts: (period: string) =>
    req<{ name: string; barcode: string; qty: number; revenue: number; margin: number }[]>(
      `/dashboard/top-products?period=${period}`,
    ),
  recentSales: (limit = 20) =>
    req<{ id: string; total: number; payment_method: string; created_at: string; username: string | null; full_name: string | null; items: string }[]>(
      `/dashboard/recent-sales?limit=${limit}`,
    ),
  logEvent: (type: string, details: any, user_id?: string) =>
    req('/logs/event', { method: 'POST', body: JSON.stringify({ type, details, user_id }) }),
  login: (username: string, pin: string) =>
    req<{ token: string; user: User }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, pin }),
    }),
  me: () => req<{ user: User }>('/auth/me'),
  listUsers: () => req<(User & { has_pin: boolean; created_at: string })[]>('/users'),
  createUser: (payload: { username: string; full_name?: string; pin: string; role?: 'owner' | 'cashier' }) =>
    req<User>('/users', { method: 'POST', body: JSON.stringify(payload) }),
  updateUser: (id: string, payload: { full_name?: string; is_blocked?: boolean; pin?: string }) =>
    req<User>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  listLogs: (limit = 200) => req<LogRow[]>(`/logs?limit=${limit}`),
  restock: () =>
    req<{ id: string; barcode: string; name: string; category: string | null; stock: number; min_stock: number; cost_price: number; sold_30d: number; days_left: number | null }[]>(
      '/analytics/restock',
    ),
  stale: (days: number) =>
    req<{ id: string; barcode: string; name: string; category: string | null; stock: number; cost_price: number; sale_price: number; last_sold_at: string | null; total_sold: number; frozen_money: number; days_since_sale: number | null }[]>(
      `/analytics/stale?days=${days}`,
    ),
  categories: () => req<{ category: string; count: string }[]>('/analytics/categories'),
  bulkPrice: (payload: {
    category?: string;
    product_ids?: string[];
    mode: 'percent' | 'set';
    field: 'sale_price' | 'cost_price';
    value: number;
  }) => req<{ updated: number; products: Product[] }>('/analytics/bulk-price', { method: 'POST', body: JSON.stringify(payload) }),
  saveInventory: (payload: { items: { barcode: string; counted_qty: number }[]; note?: string; apply?: boolean }) =>
    req<{ inventory: any; items: any[]; total_loss: number }>('/analytics/inventory', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  listInventories: (limit = 50) => req<any[]>(`/analytics/inventory?limit=${limit}`),
};
