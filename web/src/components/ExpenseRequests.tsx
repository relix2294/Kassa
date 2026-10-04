import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { onRealtimeEvent } from '../sync';

// Панель для владельца: запросы кассиров на расход. Деньги уходят из кассы,
// поэтому кассир сам не проводит — владелец видит сумму/категорию и решает.
export default function ExpenseRequests() {
  const [rows, setRows] = useState<any[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => { api.expenseRequests().then(setRows).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => onRealtimeEvent((t) => { if (t === 'expense_request') load(); }), [load]);
  useEffect(() => { const t = setInterval(load, 6000); return () => clearInterval(t); }, [load]);

  if (rows.length === 0) return null;

  async function act(id: string, how: 'approve' | 'reject') {
    setBusyId(id); setErr(null);
    try {
      if (how === 'approve') await api.approveExpenseRequest(id);
      else await api.rejectExpenseRequest(id);
      load();
    } catch (e: any) {
      setErr(e?.body?.error || e?.message || 'Не удалось');
      load();
    } finally { setBusyId(null); }
  }

  return (
    <div className="card card--alert" style={{ marginBottom: 16 }}>
      <h2>💸 Запросы на расход — нужно ваше решение</h2>
      <p className="hint">Кассир не может сам взять деньги из кассы на расход. Проверьте и дайте добро или отклоните.</p>
      {err && <div className="change change--neg">{err}</div>}
      <div className="list">
        {rows.map((r) => (
          <div key={r.id} className="list-item list-item--static list-item--alert" style={{ flexWrap: 'wrap' }}>
            <div className="list-item__main">
              <div className="list-item__name">
                {r.category} — {Number(r.amount)} {r.kind === 'wallet' ? '(безнал)' : '(наличные)'}
              </div>
              <div className="muted">
                {r.full_name || r.username}{r.note ? ` · ${r.note}` : ''}
              </div>
              <div className="muted">{new Date(r.created_at).toLocaleString('ru-RU')}</div>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn" disabled={busyId === r.id} onClick={() => act(r.id, 'reject')}>Отклонить</button>
              <button className="btn btn--primary" disabled={busyId === r.id} onClick={() => act(r.id, 'approve')}>Дать добро</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
