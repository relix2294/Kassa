import { useEffect, useRef, useState } from 'react';
import NumberInput from '../components/NumberInput';
import { db } from '../db';
import { api } from '../api';
import { pullProducts } from '../sync';
import { useGuardedClose } from '../components/Confirm';
import ProductPicker from '../components/ProductPicker';
import type { Product } from '../types';

// Быстрое списание: бой, порча, просрочка. Уменьшает остаток и учитывается
// как потеря. Отдельно от инвентаризации — разовый акт по одному товару.
const REASONS = ['Бой', 'Порча', 'Просрочка', 'Пересорт', 'Кража'];

export default function WriteOffPanel({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => void }) {
  const [barcode, setBarcode] = useState('');
  const [product, setProduct] = useState<Product | null>(null);
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const scanRef = useRef<HTMLInputElement>(null);
  const { requestClose, guard } = useGuardedClose(product !== null || reason.trim() !== '', onClose);

  useEffect(() => {
    scanRef.current?.focus();
  }, []);

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
    setProduct(p);
  }

  async function save() {
    if (!product) {
      setErr('Выберите товар');
      return;
    }
    if (reason.trim().length < 2) {
      setErr('Укажите причину');
      return;
    }
    const n = Number(qty) || 0;
    if (!(n > 0)) {
      setErr('Количество больше нуля');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.writeOff({ product_id: product.id, qty: n, reason: reason.trim() });
      await pullProducts(); // обновим остаток локально
      onDone(`Списано: ${product.name} −${n}`);
      onClose();
    } catch (e: any) {
      setErr(e.message || 'Не удалось списать');
    } finally {
      setBusy(false);
    }
  }

  const loss = product ? (Number(qty) || 0) * Number(product.cost_price) : 0;

  return (
    <div className="modal-backdrop" onClick={requestClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Списание товара</h2>
        <p className="muted">Бой, порча, просрочка. Остаток уменьшится, потеря попадёт в журнал.</p>

        {!product ? (
          <>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                onScan(barcode);
              }}
            >
              <NumberInput ref={scanRef} mode="int" placeholder="Скан товара…" value={barcode} onValue={setBarcode} />
            </form>
            <button className="btn btn--ghost btn--pick" onClick={() => setPickerOpen(true)}>
              🔎 Найти товар по названию
            </button>
          </>
        ) : (
          <>
            <div className="list-item list-item--static">
              <div className="list-item__main">
                <div className="list-item__name">{product.name}</div>
                <div className="muted">
                  на складе {Number(product.stock)} {product.unit === 'kg' ? 'кг' : 'шт'}
                </div>
              </div>
              <button className="btn btn--link" onClick={() => setProduct(null)} disabled={busy}>
                сменить
              </button>
            </div>

            <label className="field">
              <span>Сколько списать{product.unit === 'kg' ? ', кг' : ', шт'}</span>
              <NumberInput value={qty} onValue={setQty} mode={product.unit === 'kg' ? 'decimal' : 'int'} autoFocus />
            </label>

            <div className="field">
              <span>Причина</span>
              <div className="reasons">
                {REASONS.map((r) => (
                  <button
                    key={r}
                    type="button"
                    className={`chip ${reason === r ? 'chip--on' : ''}`}
                    onClick={() => setReason(r)}
                  >
                    {r}
                  </button>
                ))}
              </div>
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="или своя причина" />
            </div>

            {loss > 0 && (
              <div className="shift-diff shift-diff--neg">
                Потеря по себестоимости: <b>{loss.toFixed(2)}</b>
              </div>
            )}
          </>
        )}

        {err && <div className="change change--neg">{err}</div>}

        <div className="row">
          <button className="btn" onClick={requestClose} disabled={busy}>
            Отмена
          </button>
          <button
            className="btn btn--primary"
            onClick={save}
            disabled={busy || !product || reason.trim().length < 2 || !(Number(qty) > 0)}
          >
            Списать
          </button>
        </div>
      </div>
      {guard}
      {pickerOpen && (
        <ProductPicker
          onClose={() => setPickerOpen(false)}
          onPick={(p, q) => {
            setProduct(p);
            // Весовой товар в выборе спрашивает вес — переносим его в количество.
            if (p.unit === 'kg' && q > 0) setQty(String(q));
            setPickerOpen(false);
          }}
        />
      )}
    </div>
  );
}
