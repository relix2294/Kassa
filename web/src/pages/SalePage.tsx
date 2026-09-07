import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type CartLine } from '../db';
import { addToCart, cartTotal, clearCart, removeLine, setQty } from '../cart';
import { completeSale } from '../sync';
import { useCurrentUser } from '../session';
import { useShift, refreshShift } from '../shift';
import Keypad from '../components/Keypad';
import ReturnPanel from './ReturnPanel';

export default function SalePage() {
  const user = useCurrentUser();
  const navigate = useNavigate();
  const { shift, loaded } = useShift();
  const [barcode, setBarcode] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [payOpen, setPayOpen] = useState(false);
  const [qtyEdit, setQtyEdit] = useState<CartLine | null>(null);
  const [returnOpen, setReturnOpen] = useState(false);
  const scanRef = useRef<HTMLInputElement>(null);

  const lines = useLiveQuery(() => db.cart.toArray(), [], [] as CartLine[]);
  const total = cartTotal(lines);

  useEffect(() => {
    refreshShift();
  }, []);
  useEffect(() => {
    if (shift && !payOpen && !qtyEdit && !returnOpen) scanRef.current?.focus();
  }, [payOpen, qtyEdit, returnOpen, lines.length, shift]);

  function flash(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }

  async function onScan(code: string) {
    const bc = code.trim();
    setBarcode('');
    if (!bc) return;
    const product = await db.products.where('barcode').equals(bc).first();
    if (!product) {
      flash('Товара нет в базе — сначала приём');
      return;
    }
    await addToCart(product);
  }

  // Без открытой смены продавать нельзя (п.4 ТЗ).
  if (loaded && !shift) {
    return (
      <div className="page">
        <h1>Продажа</h1>
        <div className="card">
          <p className="hint">Смена закрыта. Откройте смену, чтобы продавать.</p>
          <button className="btn btn--primary btn--big" onClick={() => navigate('/shift')}>
            Перейти к смене
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="page page--sale">
      <div className="sale-head">
        <h1>Продажа</h1>
        <button className="btn btn--ghost" onClick={() => setReturnOpen(true)}>
          Возврат
        </button>
      </div>

      <form
        className="scan-row"
        onSubmit={(e) => {
          e.preventDefault();
          onScan(barcode);
        }}
      >
        <input
          ref={scanRef}
          autoFocus
          inputMode="numeric"
          placeholder="Скан штрихкода…"
          value={barcode}
          onChange={(e) => setBarcode(e.target.value)}
        />
      </form>

      <div className="cart">
        {lines.length === 0 && <p className="hint">Отсканируйте товар, чтобы начать чек.</p>}
        {lines.map((l) => (
          <div key={l.barcode} className="cart-line">
            <div className="cart-line__main">
              <div className="cart-line__name">{l.name}</div>
              <div className="muted">
                {l.unit_price} × {l.qty} = <b>{Number((l.unit_price * l.qty).toFixed(2))}</b>
              </div>
            </div>
            <div className="qty-ctrl">
              <button className="qty-btn" onClick={() => setQty(l.barcode, l.qty - 1)}>
                −
              </button>
              <button className="qty-num" onClick={() => setQtyEdit(l)}>
                {l.qty}
              </button>
              <button className="qty-btn" onClick={() => setQty(l.barcode, l.qty + 1)}>
                +
              </button>
            </div>
            <button className="cart-line__del" onClick={() => removeLine(l.barcode, user?.id)} title="Отменить позицию">
              ×
            </button>
          </div>
        ))}
      </div>

      {lines.length > 0 && (
        <div className="sale-footer">
          <button className="btn" onClick={() => clearCart()}>
            Очистить
          </button>
          <button className="btn btn--primary btn--pay" onClick={() => setPayOpen(true)}>
            Оплатить {total}
          </button>
        </div>
      )}

      {qtyEdit && (
        <QtyModal
          line={qtyEdit}
          onClose={() => setQtyEdit(null)}
          onSave={(q) => {
            setQty(qtyEdit.barcode, q);
            setQtyEdit(null);
          }}
        />
      )}

      {payOpen && (
        <PaymentModal
          total={total}
          onClose={() => setPayOpen(false)}
          onPay={async (method, received) => {
            try {
              const items = lines.map((l) => ({ barcode: l.barcode, qty: l.qty }));
              const r = await completeSale(items, method, received, user?.id);
              await clearCart();
              setPayOpen(false);
              flash(r.queued ? 'Нет сети — чек в очереди' : 'Оплачено ✓');
            } catch (e: any) {
              flash(`Ошибка: ${e.message}`);
            }
          }}
        />
      )}

      {returnOpen && <ReturnPanel onClose={() => setReturnOpen(false)} onDone={(m) => flash(m)} />}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function QtyModal({ line, onClose, onSave }: { line: CartLine; onClose: () => void; onSave: (q: number) => void }) {
  const [val, setVal] = useState(String(line.qty));
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{line.name}</h2>
        <div className="keypad-value">{val || '0'}</div>
        <Keypad value={val} onChange={setVal} allowDecimal />
        <div className="row">
          <button className="btn" onClick={onClose}>
            Отмена
          </button>
          <button className="btn btn--primary" onClick={() => onSave(Number(val) || 0)}>
            ОК
          </button>
        </div>
      </div>
    </div>
  );
}

function PaymentModal({
  total,
  onClose,
  onPay,
}: {
  total: number;
  onClose: () => void;
  onPay: (method: 'cash' | 'card', received?: number) => void;
}) {
  const [method, setMethod] = useState<'cash' | 'card' | null>(null);
  const [received, setReceived] = useState('');
  const change = Number(received) - total;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>К оплате: {total}</h2>

        {method === null && (
          <div className="pay-methods">
            <button className="btn btn--primary btn--big" onClick={() => setMethod('cash')}>
              💵 Наличные
            </button>
            <button className="btn btn--primary btn--big" onClick={() => onPay('card')}>
              💳 Карта
            </button>
          </div>
        )}

        {method === 'cash' && (
          <>
            <label className="field">
              <span>Получено наличными</span>
              <div className="keypad-value">{received || '0'}</div>
            </label>
            <Keypad value={received} onChange={setReceived} allowDecimal />
            <div className={`change ${change < 0 ? 'change--neg' : ''}`}>
              Сдача: <b>{received === '' ? '—' : change.toFixed(2)}</b>
            </div>
            <div className="row">
              <button className="btn" onClick={() => setMethod(null)}>
                Назад
              </button>
              <button
                className="btn btn--primary"
                disabled={received === '' || change < 0}
                onClick={() => onPay('cash', Number(received))}
              >
                Провести
              </button>
            </div>
          </>
        )}

        {method === null && (
          <button className="btn" onClick={onClose}>
            Отмена
          </button>
        )}
      </div>
    </div>
  );
}
