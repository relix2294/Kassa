import { useState } from 'react';

// Лёгкие графики на чистом SVG — без внешних библиотек (меньше вес, работает
// офлайн как PWA). Цвета берём из темы (var(--primary)=выручка, --ok=маржа,
// --off=третий) — они валидированы и сами подстраиваются под светлую/тёмную.

const fmt = (n: number) =>
  Math.abs(n) >= 1000 ? (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + 'к' : String(Math.round(n * 100) / 100);

type Pt = { label: string; revenue: number; margin: number; receipts: number };

// Столбцы по времени: выручка (столбик) + маржа (линия). Одна ось (обе — деньги).
export function ColumnChart({ points, height = 200 }: { points: Pt[]; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  if (points.length === 0) return <Empty />;
  const W = 760;
  const H = height;
  const padL = 44, padR = 12, padT = 14, padB = 26;
  const iw = W - padL - padR;
  const ih = H - padT - padB;
  const max = Math.max(1, ...points.map((p) => Math.max(Number(p.revenue), Number(p.margin))));
  const n = points.length;
  const gap = n > 1 ? iw / n : iw;
  const bw = Math.max(2, Math.min(34, gap * 0.62));
  const x = (i: number) => padL + gap * i + (gap - bw) / 2;
  const y = (v: number) => padT + ih - (v / max) * ih;
  // Точки для линии маржи — по центрам столбиков.
  const cx = (i: number) => x(i) + bw / 2;
  const line = points.map((p, i) => `${cx(i)},${y(Number(p.margin))}`).join(' ');
  // Подписи оси X: показываем не более ~8, чтобы не слипались.
  const everyX = Math.ceil(n / 8);

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} className="chart__svg" preserveAspectRatio="xMidYMid meet"
           onMouseLeave={() => setHover(null)}>
        {/* сетка + подписи оси Y (3 линии) */}
        {[0, 0.5, 1].map((t) => {
          const yy = padT + ih - t * ih;
          return (
            <g key={t}>
              <line x1={padL} y1={yy} x2={W - padR} y2={yy} className="chart__grid" />
              <text x={padL - 6} y={yy + 4} className="chart__ytick" textAnchor="end">{fmt(max * t)}</text>
            </g>
          );
        })}
        {/* столбики выручки */}
        {points.map((p, i) => {
          const h = Math.max(0, ih - (y(Number(p.revenue)) - padT));
          return (
            <g key={i} onMouseEnter={() => setHover(i)}>
              <rect x={x(i)} y={y(Number(p.revenue))} width={bw} height={h} rx={3}
                    className="chart__bar" opacity={hover === null || hover === i ? 1 : 0.45} />
              {/* широкая прозрачная зона для наведения */}
              <rect x={padL + gap * i} y={padT} width={gap} height={ih} fill="transparent" />
              {i % everyX === 0 && (
                <text x={cx(i)} y={H - 8} className="chart__xtick" textAnchor="middle">{p.label}</text>
              )}
            </g>
          );
        })}
        {/* линия маржи */}
        <polyline points={line} className="chart__line chart__line--margin" fill="none" />
        {hover !== null && (
          <line x1={cx(hover)} y1={padT} x2={cx(hover)} y2={padT + ih} className="chart__crosshair" />
        )}
      </svg>
      <div className="chart__legend">
        <span><i className="dot dot--rev" /> Выручка</span>
        <span><i className="dot dot--mar" /> Маржа</span>
      </div>
      {hover !== null && (
        <div className="chart__tip">
          <b>{points[hover].label}</b>
          <div>Выручка: <b>{fmt(Number(points[hover].revenue))}</b></div>
          <div>Маржа: <b>{fmt(Number(points[hover].margin))}</b></div>
          <div>Чеков: <b>{points[hover].receipts}</b></div>
        </div>
      )}
    </div>
  );
}

// Горизонтальные столбики-рейтинг: товары, категории, кассиры.
export function RankBars({
  items, unitHint,
}: {
  items: { label: string; value: number; sub?: string }[];
  unitHint?: string;
}) {
  if (items.length === 0) return <Empty />;
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div className="rankbars">
      {items.map((it, i) => (
        <div key={i} className="rankbar">
          <div className="rankbar__top">
            <span className="rankbar__label">{it.label}</span>
            <b className="rankbar__val">{fmt(it.value)}{unitHint ? ` ${unitHint}` : ''}</b>
          </div>
          <div className="rankbar__track">
            <div className="rankbar__fill" style={{ width: `${(it.value / max) * 100}%` }} />
          </div>
          {it.sub && <div className="rankbar__sub">{it.sub}</div>}
        </div>
      ))}
    </div>
  );
}

// Универсальное кольцо с легендой и прямыми подписями (вторичное кодирование).
// data — произвольные доли одного целого: {label, value, color}.
export function Donut({
  data, centerLabel = 'всего',
}: {
  data: { label: string; value: number; color: string }[];
  centerLabel?: string;
}) {
  const total = data.reduce((s, d) => s + Number(d.value), 0);
  if (total === 0) return <Empty />;
  const R = 60, r = 38, C = 80;
  let acc = 0;
  const segs = data
    .map((d) => {
      const val = Number(d.value);
      const frac = val / total;
      const seg = { ...d, val, frac, start: acc };
      acc += frac;
      return seg;
    })
    .filter((s) => s.val > 0);

  const arc = (start: number, frac: number) => {
    // Полный круг одним сегментом рисуем как почти-полный, иначе дуга схлопнется.
    const f = Math.min(frac, 0.9999);
    const a0 = start * 2 * Math.PI - Math.PI / 2;
    const a1 = (start + f) * 2 * Math.PI - Math.PI / 2;
    const large = f > 0.5 ? 1 : 0;
    const p = (ang: number, rad: number) => `${C + rad * Math.cos(ang)},${C + rad * Math.sin(ang)}`;
    return `M ${p(a0, R)} A ${R} ${R} 0 ${large} 1 ${p(a1, R)} L ${p(a1, r)} A ${r} ${r} 0 ${large} 0 ${p(a0, r)} Z`;
  };

  return (
    <div className="donut">
      <svg viewBox="0 0 160 160" className="donut__svg">
        {segs.map((s, i) => (
          <path key={i} d={arc(s.start, s.frac)} fill={s.color} className="donut__seg" />
        ))}
        <text x={C} y={C - 2} className="donut__center" textAnchor="middle">{fmt(total)}</text>
        <text x={C} y={C + 16} className="donut__centerlabel" textAnchor="middle">{centerLabel}</text>
      </svg>
      <div className="donut__legend">
        {segs.map((s, i) => (
          <div key={i} className="donut__row">
            <i className="dot" style={{ background: s.color }} />
            <span>{s.label}</span>
            <b>{fmt(s.val)}</b>
            <span className="muted">{Math.round(s.frac * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Empty() {
  return <p className="hint" style={{ padding: '12px 0' }}>Нет данных за период.</p>;
}
