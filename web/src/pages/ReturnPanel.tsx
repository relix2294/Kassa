import { useEffect, useRef, useState } from 'react';
import { db } from '../db';
import { completeReturn } from '../sync';
import { useCurrentUser } from '../session';

interface RetLine {
  barcode: string;
  name: string;
  unit_price: number;
  qty: number;
}

// Возврат/обмен: товар возвращается на склад, деньги выходят из кассы (п.5 ТЗ).
export default function ReturnPanel({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => void }) {
  const user = useCurrentUser();
  const [barcode, setBarcode] = useState('');
  const [lines, setLines] = useState<RetLine[]>([]);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    scanRef.current?.focus();
  }, []);

  const total = Number(lines.reduce((s, l) => s + l.unit_price * l.qty, 0).toFixed(2));

  async function onScan(code: string) {
    const bc = code.trim();
    setBarcode('');
    if (!bc) return;
    const p = await db.products.where('barcode').equals(bc).first();
    if (!p) {
      setErr('Товара нет в базе');
      setTimeout(() => setErr(null), 2000);
      return;
    }
    setLines((prev) => {
      const ex = prev.find((l) => l.barcode === bc);
      if (ex) return prev.map((l) => (l.barcode === bc ? { ...l, qty: l.qty + 1 } : l));
      return [...prev, { barcode: p.barcode, name: p.name, unit_price: Number(p.sale_price), qty: 1 }];
    });
  }

  async function confirm() {
    try {
      const items = lines.map((l) => ({ barcode: l.barcode, qty: l.qty, unit_price: l.unit_price }));
      const r = await completeReturn(items, reason || undefined, user?.id);
      onDone(r.queued ? 'Нет сети — возврат в очереди' : `Возврат оформлен: −${total}`);
      onClose();
    } catch (e: any) {
      setErr(`Ошибка: ${e.message}`);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Возврат товара</h2>
        <p className="muted">Товар вернётся на склад, деньги выйдут из кассы.</p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            onScan(barcode);
          }}
        >
          <input ref={scanRef} inputMode="numeric" placeholder="Скан возвращаемого товара…" value={barcode} onChange={(e) => setBarcode(e.target.value)} />
        </form>

        {err && <div className="change change--neg">{err}</div>}

        <div className="cart">
          {lines.map((l) => (
            <div key={l.barcode} className="cart-line">
              <div className="cart-line__main">
                <div className="cart-line__name">{l.name}</div>
                <div className="muted">
                  {l.unit_price} × {l.qty} = <b>{Number((l.unit_price * l.qty).toFixed(2))}</b>
                </div>
              </div>
              <button
                className="cart-line__del"
                onClick={() => setLines((prev) => prev.filter((x) => x.barcode !== l.barcode))}
              >
                ×
              </button>
            </div>
          ))}
        </div>

        <label className="field">
          <span>Причина (необязательно)</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="напр. брак" />
        </label>

        <div className="row">
          <button className="btn" onClick={onClose}>
            Отмена
          </button>
          <button className="btn btn--primary" disabled={lines.length === 0} onClick={confirm}>
            Вернуть {total > 0 ? `−${total}` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
