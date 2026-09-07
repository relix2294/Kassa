import type { Product, User, LogRow } from './types';

// Тонкий клиент к серверному API. Базовый путь идёт через прокси Vite (/api).
async function req<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
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
  receive: (payload: { barcode: string; qty: number; cost_price: number; user_id?: string }) =>
    req<{ product: Product }>('/receiving', { method: 'POST', body: JSON.stringify(payload) }),
  createSale: (payload: {
    client_id: string;
    items: { barcode: string; qty: number }[];
    payment_method: 'cash' | 'card';
    cash_received?: number;
    user_id?: string;
  }) => req<{ sale: any; duplicate?: boolean }>('/sales', { method: 'POST', body: JSON.stringify(payload) }),
  createReturn: (payload: {
    client_id: string;
    items: { barcode: string; qty: number; unit_price?: number }[];
    reason?: string;
    user_id?: string;
  }) => req<{ ret: any; duplicate?: boolean }>('/returns', { method: 'POST', body: JSON.stringify(payload) }),
  listSales: (limit = 100) => req<any[]>(`/sales?limit=${limit}`),
  logEvent: (type: string, details: any, user_id?: string) =>
    req('/logs/event', { method: 'POST', body: JSON.stringify({ type, details, user_id }) }),
  listUsers: () => req<User[]>('/users'),
  listLogs: (limit = 200) => req<LogRow[]>(`/logs?limit=${limit}`),
};
