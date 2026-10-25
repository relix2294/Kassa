import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { api, type Range } from '../api';
import { onRealtimeEvent } from '../sync';
import ShiftRequests from '../components/ShiftRequests';
import ReturnRequests from '../components/ReturnRequests';
import ExpenseRequests from '../components/ExpenseRequests';
import BalanceCard from '../components/BalanceCard';
import ProductEditModal from '../components/ProductEditModal';
import Icon from '../components/Icon';
import { exportXlsx } from '../xlsx';
import { ColumnChart, RankBars, Donut, BarChart, useCountUp } from '../components/charts';
import RangeControl, { money } from '../components/RangeControl';
import type { LogRow, Product } from '../types';
import { isLowStock, LOW_STOCK_THRESHOLD } from '../stock';

type Tab = 'overview' | 'sales' | 'returns' | 'stock' | 'log';

export default function DashboardPage() {
  const [range, setRange] = useState<Range>({ period: '30d' });
  const [tab, setTab] = useState<Tab>('overview');
  const tabsRef = useRef<HTMLDivElement>(null);
  // Переключить вкладку и прокрутить к ней (чтобы на телефоне было видно,
  // что по нажатию «Пора закупить» реально открылся список остатков).
  const goTab = (t: Tab) => {
    setTab(t);
    setTimeout(() => tabsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  };

  const [summary, setSummary] = useState<any | null>(null);
  const [series, setSeries] = useState<any | null>(null);
  const [top, setTop] = useState<any[]>([]);
  const [topSort, setTopSort] = useState<'revenue' | 'margin' | 'qty'>('revenue');
  const [topOpen, setTopOpen] = useState(false); // «Подробнее»: 10 → 30 товаров
  const [cats, setCats] = useState<any[]>([]);
  const [cashiers, setCashiers] = useState<any[]>([]);
  const [hours, setHours] = useState<any[]>([]);
  const [weekday, setWeekday] = useState<any[]>([]);
  const [pay, setPay] = useState<any[]>([]);
  const [expenses, setExpenses] = useState<any[]>([]);
  const [recent, setRecent] = useState<any[]>([]);
  const [supPaid, setSupPaid] = useState(0); // оплачено поставщикам за период
  const [supDebt, setSupDebt] = useState(0); // текущий долг поставщикам (всего)

  const load = useCallback(async () => {
    try {
      const [s, ts, t, c, ca, h, wd, p, ex, r, sp, sup] = await Promise.all([
        api.summary(range), api.timeseries(range), api.topProducts(range, topSort, topOpen ? 30 : 10),
        api.byCategory(range), api.byCashier(range), api.byHour(range),
        api.byWeekday(range), api.paymentSplit(range), api.expensesByCategory(range), api.recentSales(15),
        api.supplierStats(range), api.listSuppliers(),
      ]);
      setSummary(s); setSeries(ts); setTop(t); setCats(c); setCashiers(ca);
      setHours(h); setWeekday(wd); setPay(p); setExpenses(ex); setRecent(r);
      setSupPaid(Number(sp.paid) || 0); setSupDebt(Number(sup.total_debt) || 0);
    } catch { /* ignore */ }
  }, [range, topSort, topOpen]);

  useEffect(() => { load(); }, [load]);
  useEffect(
    () => onRealtimeEvent((type) => {
      if (type === 'sale' || type === 'return' || type === 'shift' || type === 'data_updated') load();
    }),
    [load],
  );

  const WEEKDAYS = ['', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

  // Выгрузка отчёта в Excel (.xlsx) из уже загруженных данных.
  async function exportCsv() {
    if (!summary) return;
    const period = `${new Date(summary.from).toLocaleDateString('ru-RU')} — ${new Date(summary.to).toLocaleDateString('ru-RU')}`;
    await exportXlsx('kassa-otchet', `Кабинет · ${period}`, [
      { caption: 'Сводка', columns: [{ header: 'Показатель' }, { header: 'Значение', num: true }], rows: [
        ['Выручка (за вычетом возвратов)', Number(summary.net_revenue)],
        ['Маржа', Number(summary.margin)],
        ['Маржа, %', Number(summary.margin_pct)],
        ['Расходы', Number(summary.expenses)],
        ['Чистая прибыль', Number(summary.net_profit)],
        ['Средний чек', Number(summary.avg_check)],
        ['Чеков', Number(summary.receipts)],
        ['Наличные', Number(summary.cash)],
        ['Безнал', Number(summary.card)],
        ['Товаров продано', Number(summary.items)],
        ['Возвраты', Number(summary.refunds_total)],
      ] },
      { caption: 'Топ товаров', columns: [{ header: 'Товар' }, { header: 'Кол-во', num: true }, { header: 'Выручка', num: true }, { header: 'Маржа', num: true }],
        rows: top.map((p: any) => [p.name, Number(p.qty), Number(p.revenue), Number(p.margin)]) },
      { caption: 'По категориям', columns: [{ header: 'Категория' }, { header: 'Выручка', num: true }, { header: 'Маржа', num: true }],
        rows: cats.map((c: any) => [c.category, Number(c.revenue), Number(c.margin)]) },
      { caption: 'По кассирам', columns: [{ header: 'Кассир' }, { header: 'Чеков', num: true }, { header: 'Выручка', num: true }, { header: 'Маржа', num: true }],
        rows: cashiers.map((c: any) => [c.cashier, Number(c.receipts), Number(c.revenue), Number(c.margin)]) },
      { caption: 'По дням недели', columns: [{ header: 'День' }, { header: 'Выручка', num: true }, { header: 'Маржа', num: true }, { header: 'Чеков', num: true }],
        rows: weekday.map((w: any) => [WEEKDAYS[w.dow] || String(w.dow), Number(w.revenue), Number(w.margin), Number(w.receipts)]) },
      { caption: 'Расходы по категориям', columns: [{ header: 'Категория' }, { header: 'Сумма', num: true }],
        rows: expenseByCat.map((e) => [e.category, Number(e.total)]) },
    ]);
  }

  // Расходы: сворачиваем по категории (суммируем нал+безнал).
  const expenseByCat = Object.values(
    expenses.reduce((acc: Record<string, { category: string; total: number }>, e: any) => {
      const k = e.category;
      acc[k] = acc[k] || { category: k, total: 0 };
      acc[k].total += Number(e.total);
      return acc;
    }, {}),
  ).sort((a, b) => b.total - a.total);

  // Данные для трёх колец структуры.
  const PAY_META: Record<string, [string, string]> = {
    cash: ['Наличные', 'var(--ok)'], card: ['Безнал', 'var(--primary)'], mixed: ['Смешанная', 'var(--c3)'],
  };
  const payData = pay.map((p: any) => ({
    label: PAY_META[p.method]?.[0] ?? p.method, value: Number(p.total), color: PAY_META[p.method]?.[1] ?? 'var(--muted)',
  }));
  const revData = summary ? [
    { label: 'Маржа', value: Number(summary.margin), color: 'var(--ok)' },
    { label: 'Себестоимость', value: Math.max(0, Number(summary.revenue) - Number(summary.margin)), color: 'var(--primary)' },
  ] : [];
  const profitData = summary ? [
    { label: 'Чистая прибыль', value: Math.max(0, Number(summary.net_profit)), color: 'var(--ok)' },
    { label: 'Расходы', value: Number(summary.expenses), color: 'var(--c3)' },
  ] : [];

  // Временной ряд → точки для графика (подпись = дата/час).
  const points = (series?.points ?? []).map((p: any) => ({
    label: series.bucket === 'hour'
      ? new Date(p.bucket).toLocaleTimeString('ru-RU', { hour: '2-digit' })
      : new Date(p.bucket).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }),
    revenue: Number(p.revenue), margin: Number(p.margin), receipts: Number(p.receipts),
  }));

  // Перезапуск анимаций графиков при смене периода (а не на каждый realtime-тик).
  const animKey = `${range.period}:${range.from ?? ''}:${range.to ?? ''}`;

  // По часам дня: полная ось 0–23, чтобы видеть «кривую» дня целиком.
  const hourMap = new Map(hours.map((h: any) => [Number(h.hour), h]));
  const hoursBars = hours.length === 0 ? [] : Array.from({ length: 24 }, (_, hr) => {
    const h = hourMap.get(hr);
    return { label: String(hr).padStart(2, '0'), value: h ? Number(h.revenue) : 0, sub: h ? `${h.receipts} чек.` : 'нет продаж' };
  });
  // По дням недели: Пн–Вс по порядку (dow 1..7).
  const dowMap = new Map(weekday.map((w: any) => [Number(w.dow), w]));
  const weekdayBars = weekday.length === 0 ? [] : [1, 2, 3, 4, 5, 6, 7].map((dow) => {
    const w = dowMap.get(dow);
    return { label: WEEKDAYS[dow], value: w ? Number(w.revenue) : 0, sub: w ? `маржа ${money(w.margin)} · ${w.receipts} чек.` : 'нет продаж' };
  });

  return (
    <div className="page page--wide">
      <h1>Кабинет</h1>

      <BalanceCard />

      <ShiftRequests />
      <ReturnRequests />
      <ExpenseRequests />

      <AlertsStrip onStock={() => goTab('stock')} />

      <RangeControl range={range} onChange={setRange} />

      {summary && <KpiRow s={summary} paid={supPaid} debt={supDebt} />}

      <div className="dash-actions">
        <button className="btn btn--ghost" onClick={exportCsv} disabled={!summary}><Icon name="download" /> Скачать отчёт (Excel)</button>
      </div>

      <div className="seg seg--tabs" ref={tabsRef}>
        {([['overview', 'Обзор'], ['sales', 'Чеки'], ['returns', 'Возвраты'], ['stock', 'Остатки'], ['log', 'Журнал']] as [Tab, string][])
          .map(([k, lbl]) => (
            <button key={k} className={`seg__btn ${tab === k ? 'seg__btn--on' : ''}`} onClick={() => setTab(k)}>{lbl}</button>
          ))}
      </div>

      {tab === 'overview' && (
        <>
          <Card title="Динамика выручки и маржи">
            <ColumnChart key={animKey} points={points} />
          </Card>

          <div className="donut-grid">
            <Card title="Чем платят">
              <Donut key={animKey} data={payData} centerLabel="продажи" />
            </Card>
            <Card title="Маржа и себестоимость">
              <Donut key={animKey} data={revData} centerLabel="продажи" />
            </Card>
            <Card title="Прибыль и расходы">
              <Donut key={animKey} data={profitData} centerLabel="маржа" />
            </Card>
          </div>

          <Card title="Выручка по часам дня">
            <BarChart key={animKey} bars={hoursBars} format={money} />
          </Card>

          <Card
            title="Топ товаров"
            action={
              <div className="seg seg--mini">
                {([['revenue', 'выручка'], ['margin', 'маржа'], ['qty', 'кол-во']] as const).map(([k, l]) => (
                  <button key={k} className={`seg__btn ${topSort === k ? 'seg__btn--on' : ''}`} onClick={() => setTopSort(k)}>{l}</button>
                ))}
              </div>
            }
          >
            <RankBars key={`${animKey}:${topSort}`} items={top.map((p: any) => ({
              label: p.name,
              value: topSort === 'qty' ? Number(p.qty) : topSort === 'margin' ? Number(p.margin) : Number(p.revenue),
              sub: `${Number(p.qty)} ${p.unit === 'kg' ? 'кг' : 'шт'} · маржа ${money(p.margin)}`,
            }))} unitHint={topSort === 'qty' ? '' : undefined} />
            {(topOpen || top.length >= 10) && (
              <div className="top-more">
                <button className="btn btn--ghost" onClick={() => setTopOpen((v) => !v)}>
                  {topOpen ? 'Свернуть' : 'Подробнее'}
                </button>
              </div>
            )}
          </Card>

          <div className="chart-grid">
            <Card title="По категориям">
              <RankBars key={animKey} items={cats.map((c: any) => ({ label: c.category, value: Number(c.revenue), sub: `маржа ${money(c.margin)}` }))} />
            </Card>
            <Card title="По кассирам">
              <RankBars key={animKey} items={cashiers.map((c: any) => ({ label: c.cashier, value: Number(c.revenue), sub: `${c.receipts} чек. · маржа ${money(c.margin)}` }))} />
            </Card>
          </div>

          <Card title="По дням недели">
            <BarChart key={animKey} bars={weekdayBars} format={money} />
          </Card>

          <Card title="Расходы по категориям">
            <RankBars key={animKey} items={expenseByCat.map((e) => ({ label: e.category, value: e.total }))} />
          </Card>
        </>
      )}

      {tab === 'sales' && <RecentTab recent={recent} />}
      {tab === 'returns' && <ReturnsTab />}
      {tab === 'stock' && <StockTab />}
      {tab === 'log' && <LogTab />}
    </div>
  );
}

// Проактивные подсказки владельцу: что пора закупить и сколько должны
// поставщикам. Показываем, только когда есть о чём сказать.
function AlertsStrip({ onStock }: { onStock: () => void }) {
  const navigate = useNavigate();
  const products = useLiveQuery(() => db.products.toArray(), [], [] as Product[]);
  const [debt, setDebt] = useState(0);

  useEffect(() => {
    api.listSuppliers().then((r) => setDebt(Number(r.total_debt) || 0)).catch(() => {});
    const off = onRealtimeEvent((t) => {
      if (t === 'data_updated') api.listSuppliers().then((r) => setDebt(Number(r.total_debt) || 0)).catch(() => {});
    });
    return off;
  }, []);

  const low = products.filter(isLowStock);
  if (low.length === 0 && debt <= 0) return null;

  return (
    <div className="alerts-strip">
      {low.length > 0 && (
        <button className="alert-chip alert-chip--warn" onClick={onStock}>
          <Icon name="cart" /> Пора закупить: <b>{low.length}</b> {low.length === 1 ? 'товар' : 'товаров'}
        </button>
      )}
      {debt > 0 && (
        <button className="alert-chip alert-chip--debt" onClick={() => navigate('/debts')}>
          <Icon name="wallet" /> Долг поставщикам: <b>{money(debt)}</b>
        </button>
      )}
    </div>
  );
}

const intFmt = (n: number) => String(Math.round(n));

function KpiRow({ s, paid, debt }: { s: any; paid: number; debt: number }) {
  return (
    <div className="kpi-grid">
      <Kpi label="Выручка" num={s.net_revenue} big change={s.prev?.revenue_change} />
      <Kpi label={`Маржа · ${s.margin_pct}%`} num={s.margin} big accent change={s.prev?.margin_change} />
      <Kpi label="Средний чек" num={s.avg_check} />
      <Kpi label="Чеков" num={s.receipts} format={intFmt} />
      <Kpi label="Наличные" num={s.cash} />
      <Kpi label="Безнал" num={s.card} />
      <Kpi label="Товаров продано" num={s.items} format={intFmt} />
      <Kpi label="Возвраты" num={s.refunds_total} danger={s.refunds_total > 0} />
      <Kpi label="Расходы" num={s.expenses} danger={s.expenses > 0} />
      <Kpi label="Оплачено поставщикам" num={paid} />
      <Kpi label="Долг поставщикам" num={debt} danger={debt > 0} />
      <Kpi label="Чистая прибыль" num={s.net_profit} big accent />
    </div>
  );
}

function Kpi({ label, num, format = money, big, accent, danger, change }: {
  label: string; num: number; format?: (n: number) => string;
  big?: boolean; accent?: boolean; danger?: boolean; change?: number | null;
}) {
  // Число плавно «докручивается» от прежнего к новому — плитка «живая».
  const shown = useCountUp(Number(num) || 0);
  return (
    <div className={`kpi ${big ? 'kpi--big' : ''}`}>
      <div className="kpi__label">{label}</div>
      <div className={`kpi__value ${accent ? 'kpi__value--accent' : ''} ${danger ? 'kpi__value--danger' : ''}`}>{format(shown)}</div>
      {change != null && (
        <div className={`kpi__change ${change >= 0 ? 'kpi__change--up' : 'kpi__change--down'}`}>
          {change >= 0 ? '▲' : '▼'} {Math.abs(change)}% <span className="muted">к пред.</span>
        </div>
      )}
    </div>
  );
}

function Card({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="dash-card">
      <div className="dash-card__head">
        <h2 className="dash-card__title">{title}</h2>
        {action}
      </div>
      {children}
    </div>
  );
}

function RecentTab({ recent }: { recent: any[] }) {
  return (
    <>
      <h2 className="sect">Последние чеки</h2>
      {recent.length === 0 && <p className="hint">Чеков пока нет.</p>}
      <div className="list">
        {recent.map((s) => (
          <div key={s.id} className="list-item list-item--static">
            <div className="list-item__main">
              <div className="list-item__name" style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                {money(s.total)} <Icon name={s.payment_method === 'cash' ? 'cash' : s.payment_method === 'card' ? 'card' : 'mixed'} />
              </div>
              <div className="muted">
                {new Date(s.created_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                {' · '}{s.full_name || s.username} · {s.items} поз.
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// Возвраты идут без чека, поэтому владелец должен видеть каждый целиком.
function ReturnsTab() {
  const [rows, setRows] = useState<any[]>([]);
  const load = useCallback(() => { api.listReturns(100).then(setRows).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => onRealtimeEvent((t) => (t === 'return' || t === 'data_updated') && load()), [load]);

  if (rows.length === 0) return <p className="hint">Возвратов пока не было.</p>;

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
        {[...byUser.entries()].sort((a, b) => b[1].total - a[1].total).map(([who, s]) => (
          <div key={who} className="list-item list-item--static">
            <div className="list-item__main">
              <div className="list-item__name">{who}</div>
              <div className="muted">{s.count} возвратов</div>
            </div>
            <div className="stock stock--low">−{money(s.total)}</div>
          </div>
        ))}
      </div>

      <h2 className="sect">Все возвраты</h2>
      <div className="list">
        {rows.map((r) => (
          <div key={r.id} className="list-item list-item--static list-item--alert">
            <div className="list-item__main">
              <div className="list-item__name">−{money(r.total)} · {r.reason || 'без причины'}</div>
              <div className="muted">
                {new Date(r.created_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                {' · '}{r.full_name || r.username}
              </div>
              <div className="log-details">{r.items.map((i: any) => `${i.name} × ${i.qty}`).join(', ')}</div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function StockTab() {
  const products = useLiveQuery(() => db.products.orderBy('name').toArray(), [], [] as Product[]);
  const [editing, setEditing] = useState<Product | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // Низкий остаток — по единому правилу, сортируем от самых пустых.
  const low = products.filter(isLowStock).sort((a, b) => a.stock - b.stock);
  return (
    <>
      {low.length > 0 && (
        <>
          <h2 className="sect">Пора закупить <span className="muted">({low.length})</span></h2>
          <div className="list">
            {low.map((p) => (
              <button key={p.id} className="list-item" onClick={() => setEditing(p)}>
                <div className="list-item__main">
                  <div className="list-item__name">{p.name}</div>
                  <div className="muted">{p.min_stock > 0 ? `минимум ${p.min_stock}` : `порог ${LOW_STOCK_THRESHOLD}`}</div>
                </div>
                <div className="stock stock--low">{p.stock} {p.unit === 'kg' ? 'кг' : 'шт'}</div>
              </button>
            ))}
          </div>
        </>
      )}
      <h2 className="sect">Все остатки <span className="muted">(нажмите, чтобы изменить)</span></h2>
      <div className="list">
        {products.map((p) => (
          <button key={p.id} className="list-item" onClick={() => setEditing(p)}>
            <div className="list-item__main">
              <div className="list-item__name">{p.name}</div>
              <div className="muted">прод. {p.sale_price} · закуп. {p.cost_price}</div>
            </div>
            <div className={`stock ${isLowStock(p) ? 'stock--low' : ''}`}>{p.stock} {p.unit === 'kg' ? 'кг' : 'шт'}</div>
          </button>
        ))}
      </div>

      {editing && (
        <ProductEditModal
          product={editing}
          onClose={() => setEditing(null)}
          onSaved={(m) => { setEditing(null); setToast(m); setTimeout(() => setToast(null), 2500); }}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}

const LOG_LABEL: Record<string, string> = {
  sale: 'Продажа', return: 'Возврат', line_cancel: 'Отмена позиции', cart_clear: 'Очистка чека',
  receiving: 'Приём товара', product_create: 'Новый товар', product_update: 'Изменена карточка',
  price_change: 'Изменена цена', stock_adjust: 'Правка остатка', shift_open: 'Открыта смена',
  shift_close: 'Закрыта смена', cash_discrepancy: 'Расхождение по кассе', handover_discrepancy: 'Расхождение при приёме',
  cash_withdraw: 'Изъятие из кассы', accountable_adjust: 'Сверка подотчёта', shift_request: 'Запрос по смене', return_request: 'Запрос на возврат',
  catalog_import: 'Импорт каталога', write_off: 'Списание', inventory: 'Инвентаризация',
  user_create: 'Добавлен сотрудник', user_block: 'Сотрудник заблокирован', user_unblock: 'Сотрудник разблокирован',
  user_pin_reset: 'Смена PIN',
};

function LogTab() {
  const [logs, setLogs] = useState<LogRow[]>([]);
  const load = useCallback(() => { api.listLogs(100).then(setLogs).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => onRealtimeEvent((type) => (type === 'log' || type === 'data_updated') && load()), [load]);

  return (
    <div className="list">
      {logs.length === 0 && <p className="hint">Журнал пуст.</p>}
      {logs.map((l) => (
        <div key={l.id} className={`list-item list-item--static ${l.type.includes('discrepancy') ? 'list-item--alert' : ''}`}>
          <div className="list-item__main">
            <div className="list-item__name">{LOG_LABEL[l.type] || l.type}</div>
            <div className="muted">
              {new Date(l.created_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
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
    case 'sale': return `${d.total} · маржа ${d.margin} · ${d.payment_method === 'cash' ? 'наличные' : d.payment_method === 'card' ? 'карта' : 'смешанная'}`;
    case 'return': return `−${d.total}${d.reason ? ` · ${d.reason}` : ''}`;
    case 'line_cancel': return `${d.name} × ${d.qty}`;
    case 'receiving': return `+${d.qty} по ${d.cost_price} → остаток ${d.new_stock}`;
    case 'price_change': return `${d.field === 'sale_price' ? 'продажи' : 'закупочная'}: ${d.old} → ${d.new}`;
    case 'shift_open': return `размен ${d.opening_cash}`;
    case 'cash_withdraw': return `−${d.amount}${d.note ? ` · ${d.note}` : ''}`;
    case 'product_create': return `${d.name} · ${d.sale_price}`;
    default: return '';
  }
}
