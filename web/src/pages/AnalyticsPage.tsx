import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { onRealtimeEvent } from '../sync';
import InventoryPanel from './InventoryPanel';
import BulkPricePanel from './BulkPricePanel';

type Tab = 'restock' | 'movers' | 'basket' | 'stale' | 'tools';

export default function AnalyticsPage() {
  const [tab, setTab] = useState<Tab>('restock');
  const [toast, setToast] = useState<string | null>(null);

  function flash(m: string) {
    setToast(m);
    setTimeout(() => setToast(null), 3000);
  }

  return (
    <div className="page">
      <h1>Аналитика</h1>

      {/* Вкладок пять — на телефоне переносим во вторую строку, а не прячем
          за горизонтальной прокруткой, которую никто не замечает. */}
      <div className="seg seg--wrap">
        <button className={`seg__btn ${tab === 'restock' ? 'seg__btn--on' : ''}`} onClick={() => setTab('restock')}>
          Закупить
        </button>
        <button className={`seg__btn ${tab === 'movers' ? 'seg__btn--on' : ''}`} onClick={() => setTab('movers')}>
          Ходовые
        </button>
        <button className={`seg__btn ${tab === 'basket' ? 'seg__btn--on' : ''}`} onClick={() => setTab('basket')}>
          Вместе
        </button>
        <button className={`seg__btn ${tab === 'stale' ? 'seg__btn--on' : ''}`} onClick={() => setTab('stale')}>
          Залежалый
        </button>
        <button className={`seg__btn ${tab === 'tools' ? 'seg__btn--on' : ''}`} onClick={() => setTab('tools')}>
          Инструменты
        </button>
      </div>

      {tab === 'restock' && <RestockTab />}
      {tab === 'movers' && <MoversTab />}
      {tab === 'basket' && <BasketTab />}
      {tab === 'stale' && <StaleTab />}
      {tab === 'tools' && <ToolsTab onDone={flash} />}

      {toast && <div className="toast">{toast}</div>}
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
    return <p className="hint">Всё в порядке — ничего не заканчивается.</p>;
  }

  return (
    <>
      <p className="hint">
        Товар на минимуме или закончится в ближайшие 3 дня по темпу продаж. «Заказать» — чтобы хватило на неделю.
      </p>
      <div className="list">
        {rows.map((p) => {
          const u = p.unit === 'kg' ? 'кг' : 'шт';
          return (
            <div key={p.id} className="list-item list-item--static list-item--alert">
              <div className="list-item__main">
                <div className="list-item__name">{p.name}</div>
                <div className="muted">
                  {p.days_left != null
                    ? Number(p.days_left) < 1
                      ? 'закончится сегодня'
                      : `хватит на ~${p.days_left} дн`
                    : `минимум ${p.min_stock}`}
                  {p.per_day != null && ` · продаётся ~${p.per_day} ${u}/день`}
                  {p.below_min && p.days_left != null && ` · ниже минимума ${p.min_stock}`}
                </div>
                {Number(p.suggest_qty) > 0 && (
                  <div className="muted">
                    заказать: <b>{p.suggest_qty} {u}</b>
                  </div>
                )}
              </div>
              <div className="stock stock--low">{p.stock} {u}</div>
            </div>
          );
        })}
      </div>
    </>
  );
}

type MoverSort = 'receipts' | 'qty' | 'revenue' | 'margin';
const MOVER_SORT: { key: MoverSort; label: string }[] = [
  { key: 'receipts', label: 'Чаще берут' },
  { key: 'qty', label: 'Больше штук' },
  { key: 'revenue', label: 'Выручка' },
  { key: 'margin', label: 'Маржа' },
];
const MOVERS_SHOWN = 50;

// «Ходовые»: что быстрее всего уходит — его брать больше и не допускать «закончилось».
// «Чаще берут» — по числу чеков: не зависит от того, штучный товар или весовой.
function MoversTab() {
  const [days, setDays] = useState(7);
  const [sort, setSort] = useState<MoverSort>('receipts');
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  const [rows, setRows] = useState<Awaited<ReturnType<typeof api.movers>>>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(() => {
    api
      .movers(days)
      .then((r) => {
        setRows(r);
        setLoaded(true);
      })
      .catch(() => {});
  }, [days]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => onRealtimeEvent((t) => t === 'sale' && load()), [load]);

  const sorted = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = s ? rows.filter((r) => r.name.toLowerCase().includes(s)) : rows;
    return [...list].sort((a, b) => Number(b[sort]) - Number(a[sort]));
  }, [rows, sort, q]);
  const shown = all ? sorted : sorted.slice(0, MOVERS_SHOWN);

  return (
    <>
      <div className="seg">
        {[7, 14, 30].map((d) => (
          <button key={d} className={`seg__btn ${days === d ? 'seg__btn--on' : ''}`} onClick={() => setDays(d)}>
            {d} дн
          </button>
        ))}
      </div>
      <div className="reasons" style={{ margin: '10px 0' }}>
        {MOVER_SORT.map((o) => (
          <button key={o.key} className={`chip ${sort === o.key ? 'chip--on' : ''}`} onClick={() => setSort(o.key)}>
            {o.label}
          </button>
        ))}
      </div>

      {loaded && rows.length === 0 && <p className="hint">За этот период продаж нет.</p>}

      {rows.length > 0 && (
        <>
          <input className="search" placeholder="Найти товар…" value={q} onChange={(e) => setQ(e.target.value)} />
          <p className="hint">
            Справа — остаток и на сколько дней его хватит при таком темпе. Красным — меньше 3 дней: брать больше.
          </p>
          {sorted.length === 0 && <p className="hint">Ничего не нашлось.</p>}
          <div className="list">
            {shown.map((r, i) => {
              const u = r.unit === 'kg' ? 'кг' : 'шт';
              const left = r.days_left != null ? Number(r.days_left) : null;
              return (
                <div key={r.id} className="list-item list-item--static">
                  <div className="list-item__main">
                    <div className="list-item__name">
                      <span className="muted">{i + 1}.</span> {r.name}
                    </div>
                    <div className="muted">
                      в {r.receipts} чеках · {Number(r.qty)} {u} (~{r.per_day}/день)
                    </div>
                    <div className="muted">
                      выручка {Number(r.revenue).toFixed(2)} · маржа {Number(r.margin).toFixed(2)}
                      {r.margin_pct != null && ` (${r.margin_pct}%)`}
                    </div>
                  </div>
                  <div className="list-item__side">
                    <div className={`stock ${left != null && left < 3 ? 'stock--low' : ''}`}>
                      {r.stock} {u}
                    </div>
                    <div className="muted">
                      {Number(r.stock) <= 0 ? 'нет на складе' : left != null ? `на ~${left} дн` : ''}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {!all && sorted.length > MOVERS_SHOWN && (
            <button className="btn btn--ghost" style={{ marginTop: 12 }} onClick={() => setAll(true)}>
              Показать все ({sorted.length})
            </button>
          )}
        </>
      )}
    </>
  );
}

// «Что покупают вместе»: работает ли товар-магнит (дешёвые сигареты и т.п.)
// и что предлагать к нему на кассе.
function BasketTab() {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<Awaited<ReturnType<typeof api.basket>> | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(() => {
    api.basket(days).then(setData).catch(() => {});
  }, [days]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => onRealtimeEvent((t) => t === 'sale' && load()), [load]);

  if (selected) {
    return <BasketDetail productId={selected} days={days} onBack={() => setSelected(null)} />;
  }

  const singlePct = data && data.receipts ? Math.round((100 * data.single_receipts) / data.receipts) : 0;

  return (
    <>
      <div className="seg">
        {[3, 7, 14, 30].map((d) => (
          <button key={d} className={`seg__btn ${days === d ? 'seg__btn--on' : ''}`} onClick={() => setDays(d)}>
            {d} дн
          </button>
        ))}
      </div>

      {data && data.receipts === 0 && <p className="hint">За этот период чеков нет.</p>}

      {data && data.receipts > 0 && (
        <>
          <div className="kpi-grid">
            <div className="kpi">
              <div className="kpi__label">Товаров в чеке</div>
              <div className="kpi__value">{data.avg_positions}</div>
            </div>
            <div className="kpi">
              <div className="kpi__label">Средний чек</div>
              <div className="kpi__value">{data.avg_check.toFixed(2)}</div>
            </div>
            <div className="kpi">
              <div className="kpi__label">Чеков</div>
              <div className="kpi__value">{data.receipts}</div>
            </div>
            <div className="kpi">
              <div className="kpi__label">Чеков из 1 товара</div>
              <div className="kpi__value">{singlePct}%</div>
            </div>
          </div>

          <h2 className="sect">Берут ли что-то ещё</h2>
          <p className="hint">
            Доля чеков с товаром, где купили и другое. Меньше 40% — товар приводит покупателя, но не продаёт остальное.
            Нажмите на товар — покажу, что к нему берут.
          </p>
          <div className="list">
            {data.products.map((p) => {
              const pct = Number(p.attach_pct);
              return (
                <button key={p.id} className="list-item" onClick={() => setSelected(p.id)}>
                  <div className="list-item__main">
                    <div className="list-item__name">{p.name}</div>
                    <div className="muted">
                      в {p.receipts} чеках · средний чек {Number(p.avg_check).toFixed(2)}
                    </div>
                  </div>
                  <div className={`stock ${pct < 40 ? 'stock--low' : ''}`}>{pct}%</div>
                </button>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}

function BasketDetail({ productId, days, onBack }: { productId: string; days: number; onBack: () => void }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.basketFor>> | null>(null);

  useEffect(() => {
    api.basketFor(productId, days).then(setData).catch(() => {});
  }, [productId, days]);

  const companionsMargin = data ? data.companions.reduce((s, c) => s + Number(c.margin), 0) : 0;

  return (
    <>
      <button className="btn btn--ghost" onClick={onBack}>
        ← Назад
      </button>

      {data && (
        <>
          <h2 className="sect">{data.product.name}</h2>
          <div className="kpi-grid">
            <div className="kpi">
              <div className="kpi__label">Чеков с товаром</div>
              <div className="kpi__value">{data.receipts}</div>
            </div>
            <div className="kpi">
              <div className="kpi__label">Взяли что-то ещё</div>
              <div className={`kpi__value ${data.attach_pct >= 40 ? 'kpi__value--accent' : 'kpi__value--danger'}`}>
                {data.attach_pct}%
              </div>
            </div>
            <div className="kpi">
              <div className="kpi__label">Средний чек с ним</div>
              <div className="kpi__value">{data.avg_check.toFixed(2)}</div>
            </div>
            <div className="kpi">
              <div className="kpi__label">Маржа с покупок к нему</div>
              <div className="kpi__value">{companionsMargin.toFixed(2)}</div>
            </div>
          </div>

          {data.companions.length === 0 ? (
            <p className="hint" style={{ marginTop: 12 }}>К этому товару пока ничего не берут.</p>
          ) : (
            <>
              <h2 className="sect">Что берут вместе</h2>
              <p className="hint">Самые частые — их и предлагать на кассе, и ставить рядом.</p>
              <div className="list">
                {data.companions.map((c) => (
                  <div key={c.id} className="list-item list-item--static">
                    <div className="list-item__main">
                      <div className="list-item__name">{c.name}</div>
                      <div className="muted">
                        в {c.receipts} чеках · {Number(c.qty)} {c.unit === 'kg' ? 'кг' : 'шт'} · маржа{' '}
                        {Number(c.margin).toFixed(2)}
                      </div>
                    </div>
                    <div className="stock">{c.share_pct}%</div>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
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
  const [panel, setPanel] = useState<'none' | 'inventory' | 'price'>('none');
  const [history, setHistory] = useState<any[]>([]);

  const loadHistory = useCallback(() => {
    api.listInventories(10).then(setHistory).catch(() => {});
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
        <div className="product-name">Массовая смена цен</div>
        <p className="hint">Поднять или опустить цены по всей категории сразу.</p>
        <button className="btn btn--primary" onClick={() => setPanel('price')}>
          Изменить цены
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
