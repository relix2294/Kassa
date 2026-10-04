import { useState } from 'react';
import type { Range } from '../api';

export const PRESETS: { key: string; label: string }[] = [
  { key: 'today', label: 'Сегодня' },
  { key: 'yesterday', label: 'Вчера' },
  { key: '7d', label: '7 дней' },
  { key: '30d', label: '30 дней' },
  { key: '90d', label: '90 дней' },
  { key: 'year', label: 'Год' },
  { key: 'all', label: 'Всё время' },
];

export const money = (n: number) =>
  new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(Number(n) || 0);

// Выбор периода: пресеты + произвольный диапазон дат.
export default function RangeControl({ range, onChange }: { range: Range; onChange: (r: Range) => void }) {
  const [custom, setCustom] = useState(range.period === 'custom');
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(range.from ?? today);
  const [to, setTo] = useState(range.to ?? today);

  return (
    <div className="range-control">
      <div className="seg seg--wrap">
        {PRESETS.map((p) => (
          <button key={p.key}
            className={`seg__btn ${!custom && range.period === p.key ? 'seg__btn--on' : ''}`}
            onClick={() => { setCustom(false); onChange({ period: p.key }); }}>
            {p.label}
          </button>
        ))}
        <button className={`seg__btn ${custom ? 'seg__btn--on' : ''}`} onClick={() => setCustom(true)}>Выбрать даты</button>
      </div>
      {custom && (
        <div className="range-custom">
          <label className="field"><span>С</span><input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="field"><span>По</span><input type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} /></label>
          <button className="btn btn--primary" onClick={() => onChange({ period: 'custom', from, to })}>Показать</button>
        </div>
      )}
    </div>
  );
}
