import { useEffect, useState } from 'react';
import { api } from '../api';

// Массовая смена цен по категории (п.6 ТЗ).
export default function BulkPricePanel({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => void }) {
  const [cats, setCats] = useState<{ category: string; count: string }[]>([]);
  const [category, setCategory] = useState('');
  const [field, setField] = useState<'sale_price' | 'cost_price'>('sale_price');
  const [mode, setMode] = useState<'percent' | 'set'>('percent');
  const [value, setValue] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
          <input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder={mode === 'percent' ? '10' : '15'} />
        </label>

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
