import { useCallback, useEffect, useState } from 'react';
import { api, type Range } from '../api';
import { onRealtimeEvent } from '../sync';
import RangeControl, { money } from '../components/RangeControl';
import { RankBars } from '../components/charts';
import ExpenseModal from '../components/ExpenseModal';
import ExpenseRequests from '../components/ExpenseRequests';

// Раздел «Расходы» для владельца: запись, одобрение, история и аналитика
// операционных затрат точки (аренда, коммуналка, хозтовары и т.п.).
export default function ExpensesPage() {
  const [range, setRange] = useState<Range>({ period: '30d' });
  const [rows, setRows] = useState<any[]>([]);
  const [byCat, setByCat] = useState<any[]>([]);
  const [modal, setModal] = useState(false);

  const load = useCallback(() => {
    api.expensesList(range).then(setRows).catch(() => {});
    api.expensesByCategory(range).then(setByCat).catch(() => {});
  }, [range]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => onRealtimeEvent((t) => {
    if (t === 'expense_request' || t === 'shift' || t === 'data_updated') load();
  }), [load]);

  const approved = rows.filter((r) => r.status === 'approved');
  const total = approved.reduce((s, r) => s + Number(r.amount), 0);
  const cash = approved.filter((r) => r.kind === 'cash').reduce((s, r) => s + Number(r.amount), 0);
  const wallet = approved.filter((r) => r.kind === 'wallet').reduce((s, r) => s + Number(r.amount), 0);

  // Свод по категориям (нал+безнал).
  const catAgg = Object.values(
    byCat.reduce((acc: Record<string, { category: string; total: number }>, e: any) => {
      acc[e.category] = acc[e.category] || { category: e.category, total: 0 };
      acc[e.category].total += Number(e.total);
      return acc;
    }, {}),
  ).sort((a, b) => b.total - a.total);

  return (
    <div className="page page--wide">
      <div className="sale-head">
        <h1>Расходы</h1>
        <button className="btn btn--primary" style={{ flex: '0 0 auto' }} onClick={() => setModal(true)}>➖ Записать расход</button>
      </div>

      <ExpenseRequests />

      <RangeControl range={range} onChange={setRange} />

      <div className="kpi-grid">
        <Kpi label="Всего расходов" value={money(total)} big danger={total > 0} />
        <Kpi label="Наличными" value={money(cash)} />
        <Kpi label="Безнал" value={money(wallet)} />
        <Kpi label="Записей" value={String(approved.length)} />
      </div>

      {catAgg.length > 0 && (
        <div className="dash-card">
          <div className="dash-card__head"><h2 className="dash-card__title">По категориям</h2></div>
          <RankBars items={catAgg.map((c) => ({ label: c.category, value: c.total }))} />
        </div>
      )}

      <h2 className="sect">История расходов</h2>
      {rows.length === 0 && <p className="hint">За выбранный период расходов нет.</p>}
      <div className="list">
        {rows.map((r) => (
          <div key={r.id} className={`list-item list-item--static ${r.status === 'rejected' ? 'expense--rejected' : ''}`}>
            <div className="list-item__main">
              <div className="list-item__name">
                {r.category} · {r.kind === 'wallet' ? 'безнал' : 'наличные'}
                {r.status === 'rejected' && <span className="muted"> · отклонён</span>}
              </div>
              <div className="muted">
                {new Date(r.created_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                {' · '}{r.by_name || r.by_username}
                {r.approver_name || r.approver_username ? ` · одобрил: ${r.approver_name || r.approver_username}` : ''}
                {r.note ? ` · ${r.note}` : ''}
              </div>
            </div>
            <div className={`stock ${r.status === 'rejected' ? '' : 'stock--low'}`}>−{money(r.amount)}</div>
          </div>
        ))}
      </div>

      {modal && <ExpenseModal onClose={() => setModal(false)} onDone={() => { setModal(false); load(); }} />}
    </div>
  );
}

function Kpi({ label, value, big, danger }: { label: string; value: string; big?: boolean; danger?: boolean }) {
  return (
    <div className={`kpi ${big ? 'kpi--big' : ''}`}>
      <div className="kpi__label">{label}</div>
      <div className={`kpi__value ${danger ? 'kpi__value--danger' : ''}`}>{value}</div>
    </div>
  );
}
