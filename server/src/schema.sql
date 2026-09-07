-- Схема БД (сервер = бэкап + источник для кабинета владельца).
-- Идемпотентно: можно прогонять повторно.

-- Пользователи. Полноценные роли/логин — этап 3, здесь минимум для логирования.
CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text UNIQUE NOT NULL,
  full_name     text,
  role          text NOT NULL DEFAULT 'owner',   -- 'owner' | 'cashier'
  pin_hash      text,                            -- хеш PIN-кода для входа
  is_blocked    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- На случай апгрейда со старой схемы:
ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_hash text;

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

-- Продажи (чеки). Себестоимость снимаем на момент продажи — для маржи.
CREATE TABLE IF NOT EXISTS sales (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      text UNIQUE,                       -- id чека с кассы (идемпотентность при повторной отправке)
  total          numeric(12,2) NOT NULL,            -- сумма к оплате
  cost_total     numeric(12,2) NOT NULL DEFAULT 0,  -- сумма себестоимости (для маржи)
  payment_method text NOT NULL,                     -- 'cash' | 'card'
  cash_received  numeric(12,2),                     -- получено наличными (для сдачи)
  change_given   numeric(12,2),                     -- сдача
  user_id        uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);

CREATE TABLE IF NOT EXISTS sale_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id     uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id  uuid NOT NULL REFERENCES products(id),
  barcode     text NOT NULL,
  name        text NOT NULL,                        -- снимок названия на момент продажи
  qty         numeric(12,3) NOT NULL,
  unit_price  numeric(12,2) NOT NULL,               -- цена продажи на момент
  unit_cost   numeric(12,2) NOT NULL,               -- себестоимость на момент
  line_total  numeric(12,2) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_id);

-- Возвраты/обмены: товар возвращается на склад, деньги выходят из кассы.
CREATE TABLE IF NOT EXISTS returns (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   text UNIQUE,
  sale_id     uuid REFERENCES sales(id),            -- опциональная привязка к исходному чеку
  total       numeric(12,2) NOT NULL,               -- сумма возврата (деньги из кассы)
  reason      text,
  user_id     uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_returns_created ON returns(created_at);

CREATE TABLE IF NOT EXISTS return_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id   uuid NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  product_id  uuid NOT NULL REFERENCES products(id),
  barcode     text NOT NULL,
  name        text NOT NULL,
  qty         numeric(12,3) NOT NULL,
  unit_price  numeric(12,2) NOT NULL,
  line_total  numeric(12,2) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_return_items_return ON return_items(return_id);

-- Смены кассира. «Сколько должно быть по чекам» сравнивается с фактически сданным.
CREATE TABLE IF NOT EXISTS shifts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id),
  opened_at     timestamptz NOT NULL DEFAULT now(),
  opening_cash  numeric(12,2) NOT NULL DEFAULT 0,   -- размен на старте
  closed_at     timestamptz,
  expected_cash numeric(12,2),                      -- сколько должно быть в кассе по чекам
  counted_cash  numeric(12,2),                      -- фактически посчитано при закрытии
  difference    numeric(12,2),                      -- counted - expected (минус = недостача)
  status        text NOT NULL DEFAULT 'open'        -- 'open' | 'closed'
);

CREATE INDEX IF NOT EXISTS idx_shifts_user ON shifts(user_id);
CREATE INDEX IF NOT EXISTS idx_shifts_opened ON shifts(opened_at);
-- Не более одной открытой смены на пользователя.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_open_shift_per_user ON shifts(user_id) WHERE status = 'open';

-- Привязка чеков и возвратов к смене (для сверки кассы).
ALTER TABLE sales ADD COLUMN IF NOT EXISTS shift_id uuid REFERENCES shifts(id);
ALTER TABLE returns ADD COLUMN IF NOT EXISTS shift_id uuid REFERENCES shifts(id);

-- Инвентаризация: владелец считает реальный остаток, система показывает недостачу.
CREATE TABLE IF NOT EXISTS inventories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES users(id),
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_id  uuid NOT NULL REFERENCES inventories(id) ON DELETE CASCADE,
  product_id    uuid NOT NULL REFERENCES products(id),
  barcode       text NOT NULL,
  name          text NOT NULL,
  expected_qty  numeric(12,3) NOT NULL,   -- остаток по системе на момент пересчёта
  counted_qty   numeric(12,3) NOT NULL,   -- посчитано вручную
  difference    numeric(12,3) NOT NULL,   -- counted - expected (минус = недостача)
  unit_cost     numeric(12,2) NOT NULL,   -- себестоимость для оценки потерь
  loss_value    numeric(12,2) NOT NULL    -- difference * unit_cost
);

CREATE INDEX IF NOT EXISTS idx_inv_items_inventory ON inventory_items(inventory_id);
CREATE INDEX IF NOT EXISTS idx_inventories_created ON inventories(created_at);
