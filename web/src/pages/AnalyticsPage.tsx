import { useCallback, useEffect, useState } from 'react';
import { api, type Range } from '../api';
import { onRealtimeEvent } from '../sync';
import RangeControl, { money } from '../components/RangeControl';
import { ColumnChart, RankBars, Donut, BarChart } from '../components/charts';
import InventoryPanel from './InventoryPanel';
import WriteOffPanel from './WriteOffPanel';
import BulkPricePanel from './BulkPricePanel';
import CatalogPanel from './CatalogPanel';

type Tab = 'metrics' | 'restock' | 'stale' | 'tools';

const WEEKDAYS = ['', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

export default function AnalyticsPage() {
  const [tab, setTab] = useState<Tab>('metrics');
  const [toast, setToast] = useState<string | null>(null);

  function flash(m: string) {
    setToast(m);
    setTimeout(() => setToast(null), 3000);
  }

  return (
    <div className="page page--wide">
      <h1>Аналитика</h1>

      <div className="seg seg--tabs">
        {([['metrics', 'Показатели'], ['restock', 'Пора закупить'], ['stale', 'Залежалый'], ['tools', 'Инструменты']] as [Tab, string][])
          .map(([k, lbl]) => (
            <button key={k} className={`seg__btn ${tab === k ? 'seg__btn--on' : ''}`} onClick={() => setTab(k)}>{lbl}</button>
          ))}
      </div>

      {tab === 'metrics' && <MetricsTab />}
      {tab === 'restock' && <RestockTab />}
      {tab === 'stale' && <StaleTab />}
      {tab === 'tools' && <ToolsTab onDone={flash} />}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

// Card для аналитики (та же обёртка, что в Кабинете).
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

// «Показатели» — максимум аналитики по товарам и продажам за период.
function MetricsTab() {
  const [range, setRange] = useState<Range>({ period: '30d' });
  const [data, setData] = useState<any | null>(null);
  const [topSort, setTopSort] = useState<'revenue' | 'margin' | 'qty'>('margin');

  const load = useCallback(async () => {
    try {
      const [summary, series, cats, cashiers, hours, weekday, pay, abc, topM] = await Promise.all([
        api.summary(range), api.timeseries(range), api.byCategory(range), api.byCashier(range),
        api.byHour(range), api.byWeekday(range), api.paymentSplit(range), api.abc(range),
        api.topProducts(range, topSort, 15),
      ]);
      setData({ summary, series, cats, cashiers, hours, weekday, pay, abc, topM });
    } catch { /* ignore */ }
  }, [range, topSort]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => onRealtimeEvent((t) => (t === 'sale' || t === 'return' || t === 'data_updated') && load()), [load]);

  if (!data) return <p className="hint">Загружаю показатели…</p>;
  const { summary: s, series, cats, cashiers, hours, weekday, pay, abc, topM } = data;
  const animKey = `${range.period}:${range.from ?? ''}:${range.to ?? ''}`;

  const points = (series?.points ?? []).map((p: any) => ({
    label: series.bucket === 'hour'
      ? new Date(p.bucket).toLocaleTimeString('ru-RU', { hour: '2-digit' })
      : new Date(p.bucket).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }),
    revenue: Number(p.revenue), margin: Number(p.margin), receipts: Number(p.receipts),
  }));

  const hourMap = new Map<number, any>(hours.map((h: any) => [Number(h.hour), h]));
  const hoursBars = hours.length === 0 ? [] : Array.from({ length: 24 }, (_, hr) => {
    const h = hourMap.get(hr);
    return { label: String(hr).padStart(2, '0'), value: h ? Number(h.revenue) : 0, sub: h ? `${h.receipts} чек.` : 'нет продаж' };
  });
  const dowMap = new Map<number, any>(weekday.map((w: any) => [Number(w.dow), w]));
  const weekdayBars = weekday.length === 0 ? [] : [1, 2, 3, 4, 5, 6, 7].map((dow) => {
    const w = dowMap.get(dow);
    return { label: WEEKDAYS[dow], value: w ? Number(w.revenue) : 0, sub: w ? `маржа ${money(w.margin)} · ${w.receipts} чек.` : 'нет продаж' };
  });
  const PAY_META: Record<string, [string, string]> = {
    cash: ['Наличные', 'var(--ok)'], card: ['Безнал', 'var(--primary)'], mixed: ['Смешанная', 'var(--c3)'],
  };
  const payData = pay.map((p: any) => ({
    label: PAY_META[p.method]?.[0] ?? p.method, value: Number(p.total), color: PAY_META[p.method]?.[1] ?? 'var(--muted)',
  }));

  // ABC-анализ: по накопленной доле выручки. A — до 80%, B — до 95%, C — хвост.
  const abcTotal = abc.reduce((a: number, r: any) => a + Number(r.revenue), 0) || 1;
  let acc = 0;
  const abcRows = abc.map((r: any) => {
    acc += Number(r.revenue);
    const cum = (acc / abcTotal) * 100;
    const cls = cum <= 80 ? 'A' : cum <= 95 ? 'B' : 'C';
    return { ...r, share: (Number(r.revenue) / abcTotal) * 100, cum, cls };
  });
  const abcCount = { A: abcRows.filter((r: any) => r.cls === 'A').length, B: abcRows.filter((r: any) => r.cls === 'B').length, C: abcRows.filter((r: any) => r.cls === 'C').length };

  return (
    <>
      <RangeControl range={range} onChange={setRange} />

      {s && (
        <div className="kpi-grid">
          <MKpi label="Выручка" value={money(s.net_revenue)} big change={s.prev?.revenue_change} />
          <MKpi label={`Маржа · ${s.margin_pct}%`} value={money(s.margin)} big accent change={s.prev?.margin_change} />
          <MKpi label="Чистая прибыль" value={money(s.net_profit)} big accent />
          <MKpi label="Чеков" value={String(s.receipts)} />
          <MKpi label="Средний чек" value={money(s.avg_check)} />
          <MKpi label="Товаров продано" value={money(s.items)} />
        </div>
      )}

      <Card title="Динамика выручки и маржи">
        <ColumnChart key={animKey} points={points} />
      </Card>

      <Card
        title="ABC-анализ товаров"
        action={<span className="muted" style={{ fontSize: 12 }}>A: {abcCount.A} · B: {abcCount.B} · C: {abcCount.C}</span>}
      >
        <p className="hint">A — дают 80% выручки (главные), B — следующие 15%, C — хвост 5% (кандидаты на вывод).</p>
        <div className="report-table-wrap">
          <table className="report-table">
            <thead><tr><th>Товар</th><th className="num">Выручка</th><th className="num">Доля</th><th className="num">Класс</th></tr></thead>
            <tbody>
              {abcRows.slice(0, 40).map((r: any, i: number) => (
                <tr key={i}>
                  <td>{r.name}</td>
                  <td className="num">{money(r.revenue)}</td>
                  <td className="num">{r.share.toFixed(1)}%</td>
                  <td className="num"><span className={`abc-badge abc-${r.cls.toLowerCase()}`}>{r.cls}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
        <RankBars key={`${animKey}:${topSort}`} items={topM.map((p: any) => ({
          label: p.name,
          value: topSort === 'qty' ? Number(p.qty) : topSort === 'margin' ? Number(p.margin) : Number(p.revenue),
          sub: `${Number(p.qty)} ${p.unit === 'kg' ? 'кг' : 'шт'} · маржа ${money(p.margin)}`,
        }))} unitHint={topSort === 'qty' ? '' : undefined} />
      </Card>

      <div className="chart-grid">
        <Card title="По категориям">
          <RankBars key={animKey} items={cats.map((c: any) => ({ label: c.category, value: Number(c.revenue), sub: `маржа ${money(c.margin)}` }))} />
        </Card>
        <Card title="По кассирам">
          <RankBars key={animKey} items={cashiers.map((c: any) => ({ label: c.cashier, value: Number(c.revenue), sub: `${c.receipts} чек. · маржа ${money(c.margin)}` }))} />
        </Card>
      </div>

      <Card title="Выручка по часам дня">
        <BarChart key={animKey} bars={hoursBars} format={money} />
      </Card>
      <Card title="По дням недели">
        <BarChart key={animKey} bars={weekdayBars} format={money} />
      </Card>
      <Card title="Чем платят">
        <Donut key={animKey} data={payData} centerLabel="продажи" />
      </Card>
    </>
  );
}

function MKpi({ label, value, big, accent, change }: { label: string; value: string; big?: boolean; accent?: boolean; change?: number | null }) {
  return (
    <div className={`kpi ${big ? 'kpi--big' : ''}`}>
      <div className="kpi__label">{label}</div>
      <div className={`kpi__value ${accent ? 'kpi__value--accent' : ''}`}>{value}</div>
      {change != null && (
        <div className={`kpi__change ${change >= 0 ? 'kpi__change--up' : 'kpi__change--down'}`}>
          {change >= 0 ? '▲' : '▼'} {Math.abs(change)}% <span className="muted">к пред.</span>
        </div>
      )}
    </div>
  );
}

function RestockTab() {
  const [rows, setRows] = useState<any[]>([]);
  const load = useCallback(() => {
    api.restock().then(setRows).catch(() => {});
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => onRealtimeEvent((t) => (t === 'product_upsert' || t === 'sale') && load()), [load]);

  if (rows.length === 0) {
    return <p className="hint">Всё в порядке — товаров ниже минимума нет.</p>;
  }

  return (
    <>
      <p className="hint">Остаток на минимуме или ниже. Пора заказывать.</p>
      <div className="list">
        {rows.map((p) => (
          <div key={p.id} className="list-item list-item--static list-item--alert">
            <div className="list-item__main">
              <div className="list-item__name">{p.name}</div>
              <div className="muted">
                минимум {p.min_stock} · продано за 30 дн: {p.sold_30d}
                {p.days_left != null && ` · хватит на ~${p.days_left} дн`}
              </div>
            </div>
            <div className="stock stock--low">{p.stock} {p.unit === 'kg' ? 'кг' : 'шт'}</div>
          </div>
        ))}
      </div>
    </>
  );
}

function StaleTab() {
  const [days, setDays] = useState(30);
  const [rows, setRows] = useState<any[]>([]);

  useEffect(() => {
    api.stale(days).then(setRows).catch(() => {});
  }, [days]);

  const frozen = rows.reduce((s, r) => s + Number(r.frozen_money), 0);

  return (
    <>
      <div className="seg">
        {[14, 30, 60, 90].map((d) => (
          <button key={d} className={`seg__btn ${days === d ? 'seg__btn--on' : ''}`} onClick={() => setDays(d)}>
            {d} дн
          </button>
        ))}
      </div>

      {rows.length === 0 && <p className="hint">Залежалого товара нет — всё продаётся.</p>}

      {rows.length > 0 && (
        <>
          <div className="kpi kpi--big">
            <div className="kpi__label">Заморожено денег</div>
            <div className="kpi__value kpi__value--danger">{frozen.toFixed(2)}</div>
          </div>

          <div className="list" style={{ marginTop: 12 }}>
            {rows.map((p) => (
              <div key={p.id} className="list-item list-item--static">
                <div className="list-item__main">
                  <div className="list-item__name">{p.name}</div>
                  <div className="muted">
                    {p.last_sold_at
                      ? `не продавался ${p.days_since_sale} дн`
                      : 'ни разу не продавался'}
                    {' · '}
                    {p.stock} {p.unit === 'kg' ? 'кг' : 'шт'} × {p.cost_price}
                  </div>
                </div>
                <div className="stock">{Number(p.frozen_money).toFixed(2)}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function ToolsTab({ onDone }: { onDone: (m: string) => void }) {
  const [panel, setPanel] = useState<'none' | 'inventory' | 'price' | 'writeoff' | 'catalog'>('none');
  const [history, setHistory] = useState<any[]>([]);
  const [writeOffs, setWriteOffs] = useState<any[]>([]);

  const loadHistory = useCallback(() => {
    api.listInventories(10).then(setHistory).catch(() => {});
    api.listWriteOffs(10).then(setWriteOffs).catch(() => {});
  }, []);
  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  return (
    <>
      <div className="card">
        <div className="product-name">Инвентаризация</div>
        <p className="hint">Пересчитайте товар — система покажет недостачу и её стоимость.</p>
        <button className="btn btn--primary" onClick={() => setPanel('inventory')}>
          Начать пересчёт
        </button>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <div className="product-name">Списание товара</div>
        <p className="hint">Бой, порча, просрочка — уменьшить остаток и учесть как потерю.</p>
        <button className="btn btn--primary" onClick={() => setPanel('writeoff')}>
          Списать товар
        </button>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <div className="product-name">Массовая смена цен</div>
        <p className="hint">Поднять или опустить цены по всей категории сразу.</p>
        <button className="btn btn--primary" onClick={() => setPanel('price')}>
          Изменить цены
        </button>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <div className="product-name">Каталог товаров</div>
        <p className="hint">Сохранить всю базу товаров файлом или перенести в другой магазин.</p>
        <button className="btn btn--primary" onClick={() => setPanel('catalog')}>
          Сохранить / перенести
        </button>
      </div>

      {history.length > 0 && (
        <>
          <h2 className="sect">История инвентаризаций</h2>
          <div className="list">
            {history.map((h) => (
              <div key={h.id} className="list-item list-item--static">
                <div className="list-item__main">
                  <div className="list-item__name">
                    {new Date(h.created_at).toLocaleDateString('ru-RU')} · {h.items} поз.
                  </div>
                  <div className="muted">
                    {h.full_name || h.username}
                    {h.note ? ` · ${h.note}` : ''}
                  </div>
                </div>
                <div className={`stock ${Number(h.total_loss) < 0 ? 'stock--low' : ''}`}>
                  {Number(h.total_loss).toFixed(2)}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {writeOffs.length > 0 && (
        <>
          <h2 className="sect">Последние списания</h2>
          <div className="list">
            {writeOffs.map((w) => (
              <div key={w.id} className="list-item list-item--static">
                <div className="list-item__main">
                  <div className="list-item__name">
                    {w.name} · −{Number(w.qty)}
                  </div>
                  <div className="muted">
                    {new Date(w.created_at).toLocaleDateString('ru-RU')} · {w.reason}
                    {w.full_name || w.username ? ` · ${w.full_name || w.username}` : ''}
                  </div>
                </div>
                <div className="stock stock--low">−{Number(w.loss_value).toFixed(2)}</div>
              </div>
            ))}
          </div>
        </>
      )}

      {panel === 'inventory' && (
        <InventoryPanel
          onClose={() => setPanel('none')}
          onDone={(msg) => {
            onDone(msg);
            setPanel('none');
            loadHistory();
          }}
        />
      )}
      {panel === 'writeoff' && (
        <WriteOffPanel
          onClose={() => setPanel('none')}
          onDone={(msg) => {
            onDone(msg);
            setPanel('none');
            loadHistory();
          }}
        />
      )}
      {panel === 'catalog' && (
        <CatalogPanel onClose={() => setPanel('none')} onDone={(msg) => onDone(msg)} />
      )}
      {panel === 'price' && (
        <BulkPricePanel
          onClose={() => setPanel('none')}
          onDone={(msg) => {
            onDone(msg);
            setPanel('none');
          }}
        />
      )}
    </>
  );
}
