import { useEffect, useRef, useState } from 'react';
import ScanInput from '../components/ScanInput';
import { findByScan, notFoundMessage, useScanCapture } from '../scan';
import { beepError, beepOk } from '../beep';
import { completeReturn } from '../sync';
import { useCurrentUser } from '../session';
import { useShift } from '../shift';
import { useGuardedClose } from '../components/Confirm';
import ProductPicker from '../components/ProductPicker';
import type { Product } from '../types';

// Частые причины — чтобы кассир не писал руками и владельцу было что группировать.
const REASONS = ['Брак', 'Не подошёл', 'Передумал', 'Ошибка кассира', 'Просрочен'];

interface RetLine {
  key: string;
  product_id: string;
  name: string;
  unit: 'pcs' | 'kg';
  unit_price: number;
  qty: number;
}

// Возврат/обмен: товар возвращается на склад, деньги выходят из кассы (п.5 ТЗ).
export default function ReturnPanel({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => void }) {
  const user = useCurrentUser();
  const { shift } = useShift();
  const [barcode, setBarcode] = useState('');
  const [lines, setLines] = useState<RetLine[]>([]);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const { requestClose, guard } = useGuardedClose(lines.length > 0 || reason.trim() !== '', onClose);

  useEffect(() => {
    scanRef.current?.focus();
  }, []);

  const total = Number(lines.reduce((s, l) => s + l.unit_price * l.qty, 0).toFixed(2));

  // Добавить товар в возврат. Весовой приходит с указанным весом из выбора,
  // штучный — по единице (скан или +1).
  function addLine(p: Product, qty: number) {
    const key = p.barcode || p.id;
    setLines((prev) => {
      const ex = prev.find((l) => l.key === key);
      if (ex) return prev.map((l) => (l.key === key ? { ...l, qty: Number((l.qty + qty).toFixed(3)) } : l));
      return [
        ...prev,
        {
          key,
          product_id: p.id,
          name: p.name,
          unit: p.unit === 'kg' ? 'kg' : 'pcs',
          unit_price: Number(p.sale_price),
          qty,
        },
      ];
    });
  }

  async function onScan(code: string) {
    setBarcode('');
    const r = await findByScan(code);
    if (!r) return;
    if (r.kind !== 'product') {
      beepError();
      setErr(notFoundMessage(r));
      setTimeout(() => setErr(null), 3000);
      return;
    }
    // Весовая этикетка несёт вес — возвращаем ровно его.
    addLine(r.product, r.qty ?? 1);
    beepOk();
  }

  useScanCapture(onScan, !pickerOpen);

  async function confirm() {
    // Возврат идёт без чека — причина обязательна, это единственный след.
    if (reason.trim().length < 3) {
      setErr('Укажите причину возврата');
      return;
    }
    try {
      const items = lines.map((l) => ({ product_id: l.product_id, qty: l.qty, unit_price: l.unit_price }));
      const r = await completeReturn(items, reason.trim(), shift?.id);
      onDone(r.queued ? 'Нет сети — возврат в очереди' : `Возврат оформлен: −${total}`);
      onClose();
    } catch (e: any) {
      setErr(`Ошибка: ${e.message}`);
    }
  }

  return (
    <div className="modal-backdrop" onClick={requestClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Возврат товара</h2>
        <p className="muted">Товар вернётся на склад, деньги выйдут из кассы.</p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            onScan(barcode);
          }}
        >
          <ScanInput
            ref={scanRef}
            placeholder="Скан возвращаемого товара…"
            value={barcode}
            onValue={setBarcode}
            onCamera={onScan}
          />
        </form>

        {/* Весовой товар и выпечку сканером не вернуть — выбираем из списка. */}
        <button className="btn btn--ghost btn--pick" onClick={() => setPickerOpen(true)}>
          Товар без штрихкода
        </button>

        {err && <div className="change change--neg">{err}</div>}

        <div className="cart">
          {lines.map((l) => (
            <div key={l.key} className="cart-line">
              <div className="cart-line__main">
                <div className="cart-line__name">{l.name}</div>
                <div className="muted">
                  {l.unit_price}{l.unit === 'kg' ? ' /кг' : ''} × {l.qty}{l.unit === 'kg' ? ' кг' : ' шт'} ={' '}
                  <b>{Number((l.unit_price * l.qty).toFixed(2))}</b>
                </div>
              </div>
              <button
                className="cart-line__del"
                onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}
              >
                ×
              </button>
            </div>
          ))}
        </div>

        <div className="field">
          <span>Причина возврата — обязательно</span>
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
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="или напишите свою"
          />
        </div>

        <div className="row">
          <button className="btn" onClick={requestClose}>
            Отмена
          </button>
          <button
            className="btn btn--primary"
            disabled={lines.length === 0 || reason.trim().length < 3}
            onClick={confirm}
          >
            Вернуть {total > 0 ? `−${total}` : ''}
          </button>
        </div>
      </div>
      {guard}
      {pickerOpen && (
        <ProductPicker
          onClose={() => setPickerOpen(false)}
          onPick={(product, qty) => {
            addLine(product, qty);
            setPickerOpen(false);
          }}
        />
      )}
    </div>
  );
}
