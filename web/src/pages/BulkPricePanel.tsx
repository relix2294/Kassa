import { useEffect, useState } from 'react';
import NumberInput from '../components/NumberInput';
import { api } from '../api';
import { db } from '../db';
import { useLiveQuery } from 'dexie-react-hooks';
import type { Product } from '../types';

// Массовая смена цен по категории (п.6 ТЗ).
export default function BulkPricePanel({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => void }) {
  const [cats, setCats] = useState<{ category: string; count: string }[]>([]);
  const [category, setCategory] = useState('');
  const [field, setField] = useState<'sale_price' | 'cost_price'>('sale_price');
  const [mode, setMode] = useState<'percent' | 'set'>('percent');
  const [value, setValue] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Предпросмотр: владелец должен видеть, что именно изменится, до нажатия.
  // Опечатка в проценте (500 вместо 50) иначе молча переписывает всю категорию.
  const products = useLiveQuery(() => db.products.toArray(), [], [] as Product[]);
  const preview = (() => {
    const num = Number(value);
    if (!category || !Number.isFinite(num)) return [];
    return products
      .filter((p) => (p.category ?? '') === category)
      .slice(0, 8)
      .map((p) => {
        const old = Number(field === 'sale_price' ? p.sale_price : p.cost_price ?? 0);
        const next = mode === 'percent' ? Number((old * (1 + num / 100)).toFixed(2)) : num;
        return { name: p.name, old, next };
      });
  })();
  const affected = products.filter((p) => (p.category ?? '') === category).length;

  useEffect(() => {
    api.categories().then(setCats).catch(() => {});
  }, []);

  async function save() {
    const num = Number(value);
    if (!category) {
      setErr('Выберите категорию');
      return;
    }
    if (!Number.isFinite(num)) {
      setErr('Введите число');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await api.bulkPrice({ category, mode, field, value: num });
      onDone(`Обновлено товаров: ${r.updated}`);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Массовая смена цен</h2>

        <label className="field">
          <span>Категория</span>
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">— выберите —</option>
            {cats.map((c) => (
              <option key={c.category} value={c.category}>
                {c.category} ({c.count})
              </option>
            ))}
          </select>
        </label>

        <div className="field">
          <span>Что меняем</span>
          <div className="seg">
            <button className={`seg__btn ${field === 'sale_price' ? 'seg__btn--on' : ''}`} onClick={() => setField('sale_price')}>
              Цену продажи
            </button>
            <button className={`seg__btn ${field === 'cost_price' ? 'seg__btn--on' : ''}`} onClick={() => setField('cost_price')}>
              Закупочную
            </button>
          </div>
        </div>

        <div className="field">
          <span>Как меняем</span>
          <div className="seg">
            <button className={`seg__btn ${mode === 'percent' ? 'seg__btn--on' : ''}`} onClick={() => setMode('percent')}>
              На процент
            </button>
            <button className={`seg__btn ${mode === 'set' ? 'seg__btn--on' : ''}`} onClick={() => setMode('set')}>
              Задать значение
            </button>
          </div>
        </div>

        <label className="field">
          <span>{mode === 'percent' ? 'Процент (напр. 10 или −5)' : 'Новая цена'}</span>
          <NumberInput value={value} onValue={setValue} allowNegative={mode === 'percent'} placeholder={mode === 'percent' ? '10 или -5' : '15'} />
        </label>

        {preview.length > 0 && (
          <div className="preview">
            <div className="preview__title">Как изменится — {affected} товаров</div>
            {preview.map((r) => (
              <div key={r.name} className="preview__row">
                <span className="preview__name">{r.name}</span>
                <span className="muted">
                  {r.old} → <b className={r.next > r.old ? 'diff-pos' : r.next < r.old ? 'diff-neg' : ''}>{r.next}</b>
                </span>
              </div>
            ))}
            {affected > preview.length && <div className="muted">…и ещё {affected - preview.length}</div>}
          </div>
        )}

        {err && <div className="change change--neg">{err}</div>}

        <div className="row">
          <button className="btn" onClick={onClose} disabled={busy}>
            Отмена
          </button>
          <button className="btn btn--primary" onClick={save} disabled={busy}>
            Применить
          </button>
        </div>
      </div>
    </div>
  );
}
