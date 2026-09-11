export interface Product {
  id: string;
  /** У весового товара и выпечки штрихкода может не быть. */
  barcode: string | null;
  /** 'pcs' — штучный, 'kg' — весовой (цена за килограмм). */
  unit: 'pcs' | 'kg';
  name: string;
  category: string | null;
  sale_price: number;
  cost_price: number;
  /** Акционная цена (задаёт владелец). null — скидки нет. */
  discount_price: number | null;
  /** Сколько ещё единиц по акции. null — без лимита, 0 — акция кончилась. */
  discount_left: number | null;
  stock: number;
  min_stock: number;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface User {
  id: string;
  username: string;
  full_name: string | null;
  role: 'owner' | 'cashier';
  is_blocked: boolean;
}

export interface LogRow {
  id: string;
  type: string;
  entity: string | null;
  entity_id: string | null;
  user_id: string | null;
  username: string | null;
  full_name: string | null;
  details: any;
  created_at: string;
}
