import { useEffect, useRef, useState } from 'react';
import { db } from '../db';
import { api } from '../api';
import { useGuardedClose } from '../components/Confirm';
import { useShift } from '../shift';

interface CountLine {
  barcode: string;
  name: string;
  expected: number;
  counted: string;
}

// Инвентаризация: скан товара → ввод фактического количества.
// Система показывает недостачу и её стоимость (п.6 ТЗ).
export default function InventoryPanel({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => void }) {
  const [barcode, setBarcode] = useState('');
  const [lines, setLines] = useState<CountLine[]>([]);
  const [note, setNote] = useState('');
  const [apply, setApply] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const scanRef = useRef<HTMLInputElement>(null);
  const { requestClose, guard } = useGuardedClose(lines.length > 0, onClose);
  const { shift } = useShift();

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
    setLines((prev) => {
      if (prev.some((l) => l.barcode === bc)) return prev;
      return [...prev, { barcode: p.barcode, name: p.name, expected: Number(p.stock), counted: String(p.stock) }];
    });
  }

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const items = lines.map((l) => ({ barcode: l.barcode, counted_qty: Number(l.counted) || 0 }));
      const r = await api.saveInventory({ items, note: note || undefined, apply });
      setResult(r);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  // Экран результата.
  if (result) {
    const shortage = result.items.filter((i: any) => Number(i.difference) !== 0);
    return (
      <div className="modal-backdrop" onClick={() => onDone('Инвентаризация сохранена')}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <h2>Результат пересчёта</h2>
          {shortage.length === 0 ? (
            <p className="hint">Всё сходится ✓</p>
          ) : (
            <div className="list">
              {shortage.map((i: any) => (
                <div key={i.id} className="list-item list-item--static">
                  <div className="list-item__main">
                    <div className="list-item__name">{i.name}</div>
                    <div className="muted">
                      было {i.expected_qty} → посчитано {i.counted_qty}
                    </div>
                  </div>
                  <div className={`stock ${Number(i.difference) < 0 ? 'stock--low' : ''}`}>
                    {Number(i.difference) > 0 ? '+' : ''}
                    {i.difference}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className={`shift-diff ${result.total_loss < 0 ? 'shift-diff--neg' : ''}`}>
            Итого: <b>{Number(result.total_loss).toFixed(2)}</b>
            {result.total_loss < 0 && ' (потери)'}
          </div>
          <button className="btn btn--primary" onClick={() => onDone('Инвентаризация сохранена')}>
            Готово
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop" onClick={requestClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Инвентаризация</h2>
        <p className="muted">Сканируйте товар и вводите фактическое количество.</p>

        {shift && (
          <div className="warn">
            Смена открыта — если сейчас пробивают чеки, остаток меняется прямо
            во время пересчёта и недостача посчитается неверно.
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            onScan(barcode);
          }}
        >
          <input
            ref={scanRef}
            inputMode="numeric"
            placeholder="Скан товара…"
            value={barcode}
            onChange={(e) => setBarcode(e.target.value)}
          />
        </form>

        {err && <div className="change change--neg">{err}</div>}

        <div className="cart">
          {lines.map((l) => {
            const diff = (Number(l.counted) || 0) - l.expected;
            return (
              <div key={l.barcode} className="cart-line">
                <div className="cart-line__main">
                  <div className="cart-line__name">{l.name}</div>
                  <div className="muted">
                    по системе {l.expected}
                    {diff !== 0 && (
                      <span className={diff < 0 ? 'diff-neg' : 'diff-pos'}>
                        {' '}
                        · {diff > 0 ? '+' : ''}
                        {diff}
                      </span>
                    )}
                  </div>
                </div>
                <input
                  className="count-input"
                  inputMode="decimal"
                  value={l.counted}
                  onChange={(e) =>
                    setLines((prev) => prev.map((x) => (x.barcode === l.barcode ? { ...x, counted: e.target.value } : x)))
                  }
                />
                <button
                  className="cart-line__del"
                  onClick={() => setLines((prev) => prev.filter((x) => x.barcode !== l.barcode))}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>

        <label className="field">
          <span>Заметка</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="напр. плановый пересчёт" />
        </label>

        <label className="check">
          <input type="checkbox" checked={apply} onChange={(e) => setApply(e.target.checked)} />
          <span>Привести остатки к посчитанным</span>
        </label>

        <div className="row">
          <button className="btn" onClick={requestClose} disabled={busy}>
            Отмена
          </button>
          <button className="btn btn--primary" onClick={save} disabled={busy || lines.length === 0}>
            Сохранить
          </button>
        </div>
      </div>
      {guard}
    </div>
  );
}
