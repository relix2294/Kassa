import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { onRealtimeEvent } from '../sync';
import InventoryPanel from './InventoryPanel';
import WriteOffPanel from './WriteOffPanel';
import BulkPricePanel from './BulkPricePanel';

type Tab = 'restock' | 'stale' | 'tools';

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

      <div className="seg">
        <button className={`seg__btn ${tab === 'restock' ? 'seg__btn--on' : ''}`} onClick={() => setTab('restock')}>
          Пора закупить
        </button>
        <button className={`seg__btn ${tab === 'stale' ? 'seg__btn--on' : ''}`} onClick={() => setTab('stale')}>
          Залежалый
        </button>
        <button className={`seg__btn ${tab === 'tools' ? 'seg__btn--on' : ''}`} onClick={() => setTab('tools')}>
          Инструменты
        </button>
      </div>

      {tab === 'restock' && <RestockTab />}
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
  const [panel, setPanel] = useState<'none' | 'inventory' | 'price' | 'writeoff'>('none');
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
