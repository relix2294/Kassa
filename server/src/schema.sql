-- Схема БД (сервер = бэкап + источник для кабинета владельца).
-- Идемпотентно: можно прогонять повторно.

-- Пользователи. Полноценные роли/логин — этап 3, здесь минимум для логирования.
CREATE TABLE IF NOT EXISTS users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username    text UNIQUE NOT NULL,
  full_name   text,
  role        text NOT NULL DEFAULT 'owner',   -- 'owner' | 'cashier'
  is_blocked  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Товары. Остаток и себестоимость (средняя скользящая) хранятся прямо в карточке.
CREATE TABLE IF NOT EXISTS products (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  barcode     text UNIQUE NOT NULL,
  name        text NOT NULL,
  category    text,
  sale_price  numeric(12,2) NOT NULL DEFAULT 0,   -- цена продажи
  cost_price  numeric(12,2) NOT NULL DEFAULT 0,   -- средняя скользящая себестоимость
  stock       numeric(12,3) NOT NULL DEFAULT 0,   -- текущий остаток
  min_stock   numeric(12,3) NOT NULL DEFAULT 0,   -- минимальный остаток («пора закупить»)
  is_archived boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);

-- Приёмка: каждое поступление товара. Нужна для истории и расчёта средней.
CREATE TABLE IF NOT EXISTS stock_receipts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  uuid NOT NULL REFERENCES products(id),
  qty         numeric(12,3) NOT NULL,             -- сколько принято
  cost_price  numeric(12,2) NOT NULL,             -- закупочная за единицу в этой приёмке
  user_id     uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_receipts_product ON stock_receipts(product_id);
CREATE INDEX IF NOT EXISTS idx_receipts_created ON stock_receipts(created_at);

-- Журнал действий (продукт построен на прозрачности).
CREATE TABLE IF NOT EXISTS activity_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type        text NOT NULL,          -- 'receiving' | 'product_create' | 'product_update' | 'price_change' | ...
  entity      text,                   -- 'product' | 'shift' | 'sale' | ...
  entity_id   uuid,
  user_id     uuid REFERENCES users(id),
  details     jsonb,                  -- произвольные детали (что изменилось, старое/новое значение)
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_log_created ON activity_log(created_at);
CREATE INDEX IF NOT EXISTS idx_log_type ON activity_log(type);
