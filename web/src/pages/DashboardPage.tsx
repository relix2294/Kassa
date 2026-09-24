import { useCallback, useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { api } from '../api';
import { onRealtimeEvent } from '../sync';
import type { LogRow, Product } from '../types';

type Period = 'today' | 'week' | 'month' | 'all';
type Tab = 'sales' | 'returns' | 'stock' | 'log';

const PERIOD_LABEL: Record<Period, string> = {
  today: 'Сегодня',
  week: 'Неделя',
  month: 'Месяц',
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
        // data_updated — на зеркале прилетел свежий снимок из магазина.
        if (type === 'sale' || type === 'return' || type === 'shift' || type === 'data_updated') load();
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
      {tab === 'returns' && <ReturnsTab />}
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

function SalesTab({ top, recent }: { top: any[]; recent: any[] }) {
  return (
    <>
      <h2 className="sect">Топ товаров</h2>
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
                {Number(s.total).toFixed(2)} {s.payment_method === 'cash' ? '💵' : '💳'}
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
function ReturnsTab() {
  const [rows, setRows] = useState<any[]>([]);

  const load = useCallback(() => {
    api.listReturns(100).then(setRows).catch(() => {});
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => onRealtimeEvent((t) => (t === 'return' || t === 'data_updated') && load()), [load]);

  if (rows.length === 0) return <p className="hint">Возвратов пока не было.</p>;

  // Сводка по кассирам — сразу видно, у кого возвратов заметно больше.
  const byUser = new Map<string, { count: number; total: number }>();
  for (const r of rows) {
    const who = r.full_name || r.username || '—';
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
                <div className="muted">{s.count} возвратов</div>
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

function StockTab() {
  const products = useLiveQuery(() => db.products.orderBy('name').toArray(), [], [] as Product[]);
  const low = products.filter((p) => p.min_stock > 0 && p.stock <= p.min_stock);

  return (
    <>
      {low.length > 0 && (
        <>
          <h2 className="sect">Пора закупить</h2>
          <div className="list">
            {low.map((p) => (
              <div key={p.id} className="list-item list-item--static">
                <div className="list-item__main">
                  <div className="list-item__name">{p.name}</div>
                  <div className="muted">минимум {p.min_stock}</div>
                </div>
                <div className="stock stock--low">{p.stock} {p.unit === 'kg' ? 'кг' : 'шт'}</div>
              </div>
            ))}
          </div>
        </>
      )}

      <h2 className="sect">Все остатки</h2>
      <div className="list">
        {products.map((p) => (
          <div key={p.id} className="list-item list-item--static">
            <div className="list-item__main">
              <div className="list-item__name">{p.name}</div>
              <div className="muted">
                прод. {p.sale_price} · закуп. {p.cost_price}
              </div>
            </div>
            <div className={`stock ${p.min_stock > 0 && p.stock <= p.min_stock ? 'stock--low' : ''}`}>{p.stock} {p.unit === 'kg' ? 'кг' : 'шт'}</div>
          </div>
        ))}
      </div>
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
};

function LogTab() {
  const [logs, setLogs] = useState<LogRow[]>([]);

  const load = useCallback(() => {
    api.listLogs(100).then(setLogs).catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => onRealtimeEvent((type) => (type === 'log' || type === 'data_updated') && load()), [load]);

  return (
    <div className="list">
      {logs.length === 0 && <p className="hint">Журнал пуст.</p>}
      {logs.map((l) => (
        <div key={l.id} className={`list-item list-item--static ${l.type === 'cash_discrepancy' ? 'list-item--alert' : ''}`}>
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
  );
}

function formatDetails(type: string, d: any): string {
  switch (type) {
    case 'sale':
      return `${d.total} · маржа ${d.margin} · ${d.payment_method === 'cash' ? 'наличные' : 'карта'}`;
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
    default:
      return '';
  }
}
