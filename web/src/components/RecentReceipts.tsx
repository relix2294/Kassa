import { useEffect, useState } from 'react';
import { api } from '../api';

type Receipt = {
  id: string; created_at: string; total: number;
  payment_method: 'cash' | 'card' | 'mixed';
  cash_amount: number; card_amount: number; cash_received: number | null; change_given: number | null;
  items: { name: string; qty: number; unit_price: number; line_total: number }[];
};

const PAY_LABEL: Record<string, string> = { cash: '💵 наличные', card: '💳 карта', mixed: '💵➕💳 смешанная' };

// Последние чеки текущей смены на экране кассы. Кассир может открыть любой и
// посмотреть состав — например, сверить с покупателем, что именно пробили.
export default function RecentReceipts({ reloadKey }: { reloadKey: number }) {
  const [rows, setRows] = useState<Receipt[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.recentReceipts(4).then((r) => { if (alive) setRows(r); }).catch(() => {});
    return () => { alive = false; };
  }, [reloadKey]);

  if (rows.length === 0) return null;

  const t = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="recent-receipts">
      <div className="recent-receipts__title">Последние чеки</div>
      <div className="list">
        {rows.map((r) => {
          const open = openId === r.id;
          return (
            <div key={r.id} className="list-item list-item--static" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <button
                className="recent-receipts__row"
                onClick={() => setOpenId(open ? null : r.id)}
              >
                <div className="list-item__main">
                  <div className="list-item__name">{r.total} смн · {PAY_LABEL[r.payment_method] || r.payment_method}</div>
                  <div className="muted">{t(r.created_at)} · {r.items.length} поз. · нажмите, чтобы {open ? 'свернуть' : 'открыть'}</div>
                </div>
                <div className="stock">{open ? '▲' : '▼'}</div>
              </button>
              {open && (
                <div className="recent-receipts__items">
                  {r.items.map((it, i) => (
                    <div key={i} className="recent-receipts__item">
                      <span>{it.name} × {it.qty}</span>
                      <b>{it.line_total}</b>
                    </div>
                  ))}
                  {r.payment_method !== 'card' && r.cash_received != null && (
                    <div className="recent-receipts__item muted">
                      <span>Получено наличными {r.cash_received}, сдача {r.change_given ?? 0}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
