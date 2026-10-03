import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { api } from '../api';
import { onRealtimeEvent } from '../sync';
import type { LogRow, Product } from '../types';

type Period = 'today' | 'week' | 'month' | 'all';
type Tab = 'sales' | 'returns' | 'stock' | 'log';

const PERIOD_LABEL: Record<Period, string> = {
  today: 'Сегодня',
  // Это скользящие 7 и 30 дней, а не календарная неделя/месяц — так и подписываем.
  week: '7 дней',
  month: '30 дней',
  all: 'Всё время',
};

export default function DashboardPage() {
  const [period, setPeriod] = useState<Period>('today');
  const [tab, setTab] = useState<Tab>('sales');
  const [summary, setSummary] = useState<any | null>(null);
  const [top, setTop] = useState<any[]>([]);
  const [recent, setRecent] = useState<any[]>([]);

  const load = useCallback(async () => {
    try {
      const [s, t, r] = await Promise.all([
        api.summary(period),
        api.topProducts(period),
        api.recentSales(15),
      ]);
      setSummary(s);
      setTop(t);
      setRecent(r);
    } catch {
      /* ignore */
    }
  }, [period]);

  useEffect(() => {
    load();
  }, [load]);

  // Живое обновление: новая продажа/возврат/смена — перезагружаем цифры.
  useEffect(
    () =>
      onRealtimeEvent((type) => {
        if (type === 'sale' || type === 'return' || type === 'shift') load();
      }),
    [load],
  );

  return (
    <div className="page">
      <h1>Кабинет</h1>

      <div className="seg">
        {(Object.keys(PERIOD_LABEL) as Period[]).map((p) => (
          <button key={p} className={`seg__btn ${period === p ? 'seg__btn--on' : ''}`} onClick={() => setPeriod(p)}>
            {PERIOD_LABEL[p]}
          </button>
        ))}
      </div>

      {summary && (
        <div className="kpi-grid">
          <Kpi
            label={summary.refunds_total > 0 ? 'Выручка за вычетом возвратов' : 'Выручка'}
            value={summary.net_revenue ?? summary.revenue}
            big
          />
          <Kpi label="Маржа" value={summary.margin} big accent />
          <Kpi label="Чеков" value={summary.receipts} />
          <Kpi label="Наличными" value={summary.cash} />
          <Kpi label="Картой" value={summary.card} />
          <Kpi label="Возвраты" value={summary.refunds_total} danger={summary.refunds_total > 0} />
        </div>
      )}

      <div className="seg seg--tabs">
        <button className={`seg__btn ${tab === 'sales' ? 'seg__btn--on' : ''}`} onClick={() => setTab('sales')}>
          Продажи
        </button>
        <button className={`seg__btn ${tab === 'returns' ? 'seg__btn--on' : ''}`} onClick={() => setTab('returns')}>
          Возвраты
        </button>
        <button className={`seg__btn ${tab === 'stock' ? 'seg__btn--on' : ''}`} onClick={() => setTab('stock')}>
          Остатки
        </button>
        <button className={`seg__btn ${tab === 'log' ? 'seg__btn--on' : ''}`} onClick={() => setTab('log')}>
          Журнал
        </button>
      </div>

      {tab === 'sales' && <SalesTab top={top} recent={recent} />}
      {tab === 'returns' && <ReturnsTab period={period} />}
      {tab === 'stock' && <StockTab />}
      {tab === 'log' && <LogTab />}
    </div>
  );
}

function Kpi({
  label,
  value,
  big,
  accent,
  danger,
}: {
  label: string;
  value: number;
  big?: boolean;
  accent?: boolean;
  danger?: boolean;
}) {
  return (
    <div className={`kpi ${big ? 'kpi--big' : ''}`}>
      <div className="kpi__label">{label}</div>
      <div className={`kpi__value ${accent ? 'kpi__value--accent' : ''} ${danger ? 'kpi__value--danger' : ''}`}>
        {value}
      </div>
    </div>
  );
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

// Способ оплаты значком. Смешанная раньше показывалась как «карта».
function payIcon(method: string): string {
  return method === 'cash' ? '💵' : method === 'mixed' ? '💵+💳' : '💳';
}

function payLabel(method: string): string {
  return method === 'cash' ? 'наличные' : method === 'mixed' ? 'наличные + карта' : 'карта';
}

function SalesTab({ top, recent }: { top: any[]; recent: any[] }) {
  return (
    <>
      <h2 className="sect">Топ-10 по выручке</h2>
      <p className="hint">Полный список, что чаще всего берут и на сколько хватит остатка, — Аналитика → «Ходовые».</p>
      {top.length === 0 && <p className="hint">Продаж за период нет.</p>}
      <div className="list">
        {top.map((p) => (
          <div key={p.barcode} className="list-item list-item--static">
            <div className="list-item__main">
              <div className="list-item__name">{p.name}</div>
              <div className="muted">{p.qty} {p.unit === 'kg' ? 'кг' : 'шт'} · маржа {Number(p.margin).toFixed(2)}</div>
            </div>
            <div className="stock">{Number(p.revenue).toFixed(2)}</div>
          </div>
        ))}
      </div>

      <h2 className="sect">Последние чеки</h2>
      {recent.length === 0 && <p className="hint">Чеков пока нет.</p>}
      <div className="list">
        {recent.map((s) => (
          <div key={s.id} className="list-item list-item--static">
            <div className="list-item__main">
              <div className="list-item__name">
                {Number(s.total).toFixed(2)} {payIcon(s.payment_method)}
              </div>
              <div className="muted">
                {new Date(s.created_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })} ·{' '}
                {s.full_name || s.username} · {s.items} поз.
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// Возвраты идут без чека, поэтому владелец должен видеть каждый целиком:
// кто оформил, что вернули, на сколько и по какой причине.
function ReturnsTab({ period }: { period: Period }) {
  const [rows, setRows] = useState<any[]>([]);

  // Тот же период, что и у цифр сверху.
  const load = useCallback(() => {
    api.listReturns(200, period).then(setRows).catch(() => {});
  }, [period]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => onRealtimeEvent((t) => t === 'return' && load()), [load]);

  if (rows.length === 0) return <p className="hint">За этот период возвратов не было.</p>;

  // Сводка по кассирам — сразу видно, у кого возвратов заметно больше.
  const byUser = new Map<string, { count: number; total: number }>();
  for (const r of rows) {
    const who = r.full_name || r.username || 'не указан';
    const cur = byUser.get(who) ?? { count: 0, total: 0 };
    byUser.set(who, { count: cur.count + 1, total: cur.total + Number(r.total) });
  }

  return (
    <>
      <h2 className="sect">Кто оформлял</h2>
      <div className="list">
        {[...byUser.entries()]
          .sort((a, b) => b[1].total - a[1].total)
          .map(([who, s]) => (
            <div key={who} className="list-item list-item--static">
              <div className="list-item__main">
                <div className="list-item__name">{who}</div>
                <div className="muted">{s.count} {plural(s.count, 'возврат', 'возврата', 'возвратов')}</div>
              </div>
              <div className="stock stock--low">−{s.total.toFixed(2)}</div>
            </div>
          ))}
      </div>

      <h2 className="sect">Все возвраты</h2>
      <div className="list">
        {rows.map((r) => (
          <div key={r.id} className="list-item list-item--static list-item--alert">
            <div className="list-item__main">
              <div className="list-item__name">
                −{Number(r.total).toFixed(2)} · {r.reason || 'без причины'}
              </div>
              <div className="muted">
                {new Date(r.created_at).toLocaleString('ru-RU', {
                  day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
                })}
                {' · '}
                {r.full_name || r.username}
              </div>
              <div className="log-details">
                {r.items.map((i: any) => `${i.name} × ${i.qty}`).join(', ')}
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

type StockFilter = 'all' | 'low' | 'out';
const STOCK_RENDER_LIMIT = 100;

function StockTab() {
  const products = useLiveQuery(() => db.products.orderBy('name').toArray(), [], [] as Product[]);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<StockFilter>('all');

  const isLow = (p: Product) => p.min_stock > 0 && p.stock <= p.min_stock && p.stock > 0;
  const counts = {
    all: products.length,
    low: products.filter(isLow).length,
    out: products.filter((p) => p.stock <= 0).length,
  };

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return products.filter((p) => {
      if (filter === 'low' && !isLow(p)) return false;
      if (filter === 'out' && p.stock > 0) return false;
      if (!s) return true;
      return p.name.toLowerCase().includes(s) || (p.barcode ?? '').includes(s) || (p.category ?? '').toLowerCase().includes(s);
    });
  }, [products, q, filter]);
  const shown = filtered.slice(0, STOCK_RENDER_LIMIT);

  // Сумма денег в товаре на складе — сколько вложено в остатки.
  const stockValue = products.reduce((sum, p) => sum + Math.max(p.stock, 0) * Number(p.cost_price ?? 0), 0);

  return (
    <>
      <div className="kpi" style={{ marginBottom: 12 }}>
        <div className="kpi__label">Товара на складе по закупке</div>
        <div className="kpi__value">{stockValue.toFixed(2)}</div>
      </div>

      <div className="reasons" style={{ marginBottom: 10 }}>
        <button className={`chip ${filter === 'all' ? 'chip--on' : ''}`} onClick={() => setFilter('all')}>
          Все · {counts.all}
        </button>
        <button className={`chip ${filter === 'low' ? 'chip--on' : ''}`} onClick={() => setFilter('low')}>
          Ниже минимума · {counts.low}
        </button>
        <button className={`chip ${filter === 'out' ? 'chip--on' : ''}`} onClick={() => setFilter('out')}>
          Закончились · {counts.out}
        </button>
      </div>
      <input
        className="search"
        placeholder="Поиск по названию, штрихкоду, категории"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />

      {filtered.length === 0 && <p className="hint">Ничего не нашлось.</p>}
      <div className="list">
        {shown.map((p) => {
          const low = p.stock <= 0 || isLow(p);
          return (
            <div key={p.id} className="list-item list-item--static">
              <div className="list-item__main">
                <div className="list-item__name">{p.name}</div>
                <div className="muted">
                  прод. {p.sale_price} · закуп. {p.cost_price}
                  {p.min_stock > 0 && ` · мин. ${p.min_stock}`}
                </div>
              </div>
              <div className={`stock ${low ? 'stock--low' : ''}`}>{p.stock} {p.unit === 'kg' ? 'кг' : 'шт'}</div>
            </div>
          );
        })}
      </div>
      {filtered.length > shown.length && (
        <p className="hint">
          Показано {shown.length} из {filtered.length}. Уточните поиск, чтобы найти нужный товар.
        </p>
      )}
    </>
  );
}

// Человекочитаемые названия событий журнала.
const LOG_LABEL: Record<string, string> = {
  sale: 'Продажа',
  return: 'Возврат',
  line_cancel: 'Отмена позиции',
  receiving: 'Приём товара',
  product_create: 'Новый товар',
  product_update: 'Изменена карточка',
  price_change: 'Изменена цена',
  shift_open: 'Открыта смена',
  shift_close: 'Закрыта смена',
  cash_discrepancy: 'Расхождение по кассе',
  user_create: 'Добавлен сотрудник',
  user_block: 'Сотрудник заблокирован',
  user_unblock: 'Сотрудник разблокирован',
  user_pin_reset: 'Смена PIN',
  cart_clear: 'Очищен чек',
  late_sale: 'Чек пришёл после закрытия смены',
  late_return: 'Возврат пришёл после закрытия смены',
  inventory: 'Инвентаризация',
  discount_set: 'Назначена скидка',
  discount_clear: 'Снята скидка',
  product_archive: 'Товар убран из работы',
  product_restore: 'Товар возвращён в работу',
};

// Группы для фильтра журнала: владелец ищет либо «где деньги», либо
// «кто что менял в товарах», либо «что отменяли на кассе».
type LogGroup = 'all' | 'money' | 'cancel' | 'goods' | 'staff';
const LOG_GROUPS: { key: LogGroup; label: string; types?: string[] }[] = [
  { key: 'all', label: 'Всё' },
  { key: 'money', label: 'Деньги и смены', types: ['sale', 'return', 'late_sale', 'late_return', 'shift_open', 'shift_close', 'cash_discrepancy'] },
  { key: 'cancel', label: 'Отмены на кассе', types: ['line_cancel', 'cart_clear'] },
  { key: 'goods', label: 'Товары и цены', types: ['receiving', 'product_create', 'product_update', 'price_change', 'discount_set', 'discount_clear', 'product_archive', 'product_restore', 'inventory'] },
  { key: 'staff', label: 'Сотрудники', types: ['user_create', 'user_block', 'user_unblock', 'user_pin_reset'] },
];

function LogTab() {
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [group, setGroup] = useState<LogGroup>('all');
  const [who, setWho] = useState('');

  const load = useCallback(() => {
    api.listLogs(500).then(setLogs).catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => onRealtimeEvent((type) => type === 'log' && load()), [load]);

  const people = useMemo(
    () => [...new Set(logs.map((l) => l.full_name || l.username).filter(Boolean) as string[])].sort(),
    [logs],
  );
  const types = LOG_GROUPS.find((g) => g.key === group)?.types;
  const shown = logs.filter(
    (l) => (!types || types.includes(l.type)) && (!who || (l.full_name || l.username) === who),
  );

  return (
    <>
      <div className="reasons" style={{ marginBottom: 10 }}>
        {LOG_GROUPS.map((g) => (
          <button key={g.key} className={`chip ${group === g.key ? 'chip--on' : ''}`} onClick={() => setGroup(g.key)}>
            {g.label}
          </button>
        ))}
      </div>
      {people.length > 1 && (
        <div className="reasons" style={{ marginBottom: 10 }}>
          <button className={`chip ${who === '' ? 'chip--on' : ''}`} onClick={() => setWho('')}>
            Все сотрудники
          </button>
          {people.map((p) => (
            <button key={p} className={`chip ${who === p ? 'chip--on' : ''}`} onClick={() => setWho(p)}>
              {p}
            </button>
          ))}
        </div>
      )}

      <div className="list">
        {shown.length === 0 && <p className="hint">{logs.length === 0 ? 'Журнал пуст.' : 'Под фильтр ничего не попало.'}</p>}
        {shown.map((l) => (
          <div
            key={l.id}
            className={`list-item list-item--static ${l.type === 'cash_discrepancy' ? 'list-item--alert' : ''}`}
          >
            <div className="list-item__main">
              <div className="list-item__name">{LOG_LABEL[l.type] || l.type}</div>
              <div className="muted">
                {new Date(l.created_at).toLocaleString('ru-RU', {
                  day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
                })}
                {(l.full_name || l.username) && ` · ${l.full_name || l.username}`}
              </div>
              {l.details && <div className="log-details">{formatDetails(l.type, l.details)}</div>}
            </div>
          </div>
        ))}
      </div>
      {logs.length >= 500 && <p className="hint">Показаны последние 500 событий.</p>}
    </>
  );
}

function formatDetails(type: string, d: any): string {
  switch (type) {
    case 'sale':
      return `${d.total} · маржа ${d.margin} · ${payLabel(d.payment_method)}`;
    case 'return':
      return `−${d.total}${d.reason ? ` · ${d.reason}` : ''}`;
    case 'line_cancel':
      return `${d.name} × ${d.qty}`;
    case 'receiving':
      return `+${d.qty} по ${d.cost_price} → остаток ${d.new_stock}`;
    case 'price_change':
      return `${d.field === 'sale_price' ? 'продажи' : 'закупочная'}: ${d.old} → ${d.new}`;
    case 'shift_open':
      return `размен ${d.opening_cash}`;
    case 'shift_close':
    case 'cash_discrepancy':
      return `ожидалось ${d.expected}, посчитано ${d.counted} → ${d.difference > 0 ? '+' : ''}${d.difference}`;
    case 'product_create':
      return `${d.name} · ${d.sale_price}`;
    case 'cart_clear':
      return `${(d.items ?? []).map((i: any) => `${i.name} × ${i.qty}`).join(', ')} · на ${d.total}`;
    case 'late_sale':
    case 'late_return':
      return `${d.total} · расхождение смены теперь ${d.new_difference ?? '—'}`;
    case 'inventory':
      return `${d.items} поз. · итог ${d.total_loss}${d.applied ? ' · остатки исправлены' : ''}`;
    case 'discount_set':
      return `${d.name}: ${d.old_price} → ${d.discount_price}${d.limit != null ? ` · лимит ${d.limit}` : ''}`;
    case 'discount_clear':
    case 'product_archive':
    case 'product_restore':
      return d.name ?? '';
    default:
      return '';
  }
}
