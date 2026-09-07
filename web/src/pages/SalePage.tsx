import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type CartLine } from '../db';
import { addToCart, cartTotal, clearCart, removeLine, setQty } from '../cart';
import { completeSale } from '../sync';
import { useCurrentUser } from '../session';
import { useShift, refreshShift } from '../shift';
import { useIsDesktop } from '../useMedia';
import Keypad from '../components/Keypad';
import PaymentForm from '../components/PaymentForm';
import ReturnPanel from './ReturnPanel';

export default function SalePage() {
  const user = useCurrentUser();
  const navigate = useNavigate();
  const isDesktop = useIsDesktop();
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

  // Фокус всегда в поле скана — сканер печатает «вслепую».
  useEffect(() => {
    if (shift && !payOpen && !qtyEdit && !returnOpen) scanRef.current?.focus();
  }, [payOpen, qtyEdit, returnOpen, lines.length, shift]);

  // Горячие клавиши кассы (десктоп): F2 — оплата, Esc — закрыть/очистить.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'F2' && lines.length > 0 && !payOpen && !returnOpen && !qtyEdit) {
        e.preventDefault();
        setPayOpen(true);
      }
      if (e.key === 'Escape') {
        if (qtyEdit) setQtyEdit(null);
        else if (returnOpen) setReturnOpen(false);
        else if (payOpen) setPayOpen(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lines.length, payOpen, returnOpen, qtyEdit]);

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

  async function pay(method: 'cash' | 'card', received?: number) {
    try {
      const items = lines.map((l) => ({ barcode: l.barcode, qty: l.qty }));
      const r = await completeSale(items, method, received, user?.id);
      await clearCart();
      setPayOpen(false);
      flash(r.queued ? 'Нет сети — чек в очереди' : 'Оплачено ✓');
    } catch (e: any) {
      flash(`Ошибка: ${e.message}`);
    }
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

  const cart = (
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
  );

  const scanForm = (
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
  );

  return (
    <div className={`page ${isDesktop ? 'page--sale-desk' : 'page--sale'}`}>
      {isDesktop ? (
        // Десктоп кассы: слева чек, справа постоянная панель оплаты.
        <>
          <div className="sale-main">
            <div className="sale-head">
              <h1>Продажа</h1>
              <button className="btn btn--ghost" onClick={() => setReturnOpen(true)}>
                Возврат
              </button>
            </div>
            {scanForm}
            {cart}
            {lines.length > 0 && (
              <button className="btn btn--clear" onClick={() => clearCart()}>
                Очистить чек
              </button>
            )}
          </div>

          <aside className="sale-side">
            <PaymentForm total={total} disabled={lines.length === 0} onPay={pay} />
            <div className="hotkeys">
              <span>
                <kbd>F2</kbd> оплата
              </span>
              <span>
                <kbd>Esc</kbd> закрыть
              </span>
            </div>
          </aside>
        </>
      ) : (
        // Телефон: чек на весь экран, оплата — модалкой.
        <>
          <div className="sale-head">
            <h1>Продажа</h1>
            <button className="btn btn--ghost" onClick={() => setReturnOpen(true)}>
              Возврат
            </button>
          </div>
          {scanForm}
          {cart}
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
        </>
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

      {payOpen && !isDesktop && (
        <div className="modal-backdrop" onClick={() => setPayOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <PaymentForm total={total} onPay={pay} onCancel={() => setPayOpen(false)} />
          </div>
        </div>
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
