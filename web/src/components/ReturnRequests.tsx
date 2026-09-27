import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { onRealtimeEvent } from '../sync';

// Панель для владельца: запросы кассиров на возврат. Возврат — выдача денег из
// кассы, поэтому кассир сам не может; владелец видит сумму/причину и решает.
export default function ReturnRequests() {
  const [rows, setRows] = useState<any[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    api.returnRequests().then(setRows).catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => onRealtimeEvent((type) => { if (type === 'return_request') load(); }), [load]);
  useEffect(() => {
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
  }, [load]);

  if (rows.length === 0) return null;

  async function approve(id: string) {
    setBusyId(id); setErr(null);
    try {
      await api.approveReturnRequest(id);
      load();
    } catch (e: any) {
      setErr(e?.body?.error || e?.message || 'Не удалось подтвердить');
      load();
    } finally { setBusyId(null); }
  }

  async function reject(id: string) {
    setBusyId(id); setErr(null);
    try {
      await api.rejectReturnRequest(id);
      load();
    } catch (e: any) {
      setErr(e?.body?.error || e?.message || 'Не удалось отклонить');
      load();
    } finally { setBusyId(null); }
  }

  return (
    <div className="card card--alert" style={{ marginBottom: 16 }}>
      <h2>↩️ Запросы на возврат — нужно ваше решение</h2>
      <p className="hint">Кассир не может сам вернуть деньги из кассы. Проверьте и дайте добро или отклоните.</p>
      {err && <div className="change change--neg">{err}</div>}
      <div className="list">
        {rows.map((r) => (
          <div key={r.id} className="list-item list-item--static list-item--alert" style={{ flexWrap: 'wrap' }}>
            <div className="list-item__main">
              <div className="list-item__name">
                {r.full_name || r.username} — возврат на {Number(r.total)} смн
              </div>
              <div className="muted">Позиций: {r.items_count} · причина: {r.reason || '—'}</div>
              <div className="muted">{new Date(r.created_at).toLocaleString('ru-RU')}</div>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn" disabled={busyId === r.id} onClick={() => reject(r.id)}>Отклонить</button>
              <button className="btn btn--primary" disabled={busyId === r.id} onClick={() => approve(r.id)}>
                Дать добро
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
