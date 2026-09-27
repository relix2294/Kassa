import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { onRealtimeEvent } from '../sync';
import { refreshShift } from '../shift';

// Панель для владельца: запросы кассиров на открытие/закрытие кассы с
// расхождением. Владелец видит, сколько не хватает, и даёт «добро» или
// отклоняет — прямо из кабинета, даже если он не в магазине.
export default function ShiftRequests() {
  const [rows, setRows] = useState<any[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    api.shiftRequests().then(setRows).catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);
  // Живо: новый запрос от кассира — подтягиваем сразу.
  useEffect(() => onRealtimeEvent((type) => { if (type === 'shift_request') load(); }), [load]);
  // Подстраховка: опрос раз в 6 сек, если событие не дошло.
  useEffect(() => {
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
  }, [load]);

  if (rows.length === 0) return null;

  async function approve(id: string) {
    setBusyId(id); setErr(null);
    try {
      await api.approveShiftRequest(id);
      await refreshShift();
      load();
    } catch (e: any) {
      setErr(e?.body?.message || e?.message || 'Не удалось подтвердить');
      load();
    } finally { setBusyId(null); }
  }

  async function reject(id: string) {
    setBusyId(id); setErr(null);
    try {
      await api.rejectShiftRequest(id);
      load();
    } catch (e: any) {
      setErr(e?.body?.message || e?.message || 'Не удалось отклонить');
      load();
    } finally { setBusyId(null); }
  }

  return (
    <div className="card card--alert" style={{ marginBottom: 16 }}>
      <h2>🔔 Запросы на кассу — нужно ваше решение</h2>
      <p className="hint">
        Кассир не может сам открыть/закрыть кассу с расхождением. Проверьте суммы и дайте добро или отклоните.
      </p>
      {err && <div className="change change--neg">{err}</div>}
      <div className="list">
        {rows.map((r) => {
          const cd = Number(r.cash_diff);
          const wd = Number(r.wallet_diff);
          const isOpen = r.kind === 'open';
          return (
            <div key={r.id} className="list-item list-item--static list-item--alert" style={{ flexWrap: 'wrap' }}>
              <div className="list-item__main">
                <div className="list-item__name">
                  {r.full_name || r.username} — {isOpen ? 'открытие кассы' : 'закрытие смены'}
                </div>
                <div className="muted">
                  Наличные: ожидалось {Number(r.expected_cash)}, {isOpen ? 'ввели' : 'посчитали'} {Number(r.counted_cash)}
                  {cd !== 0 ? ` (${cd > 0 ? '+' : ''}${cd}${cd < 0 ? ', недостача' : ', излишек'})` : ' ✓'}
                </div>
                <div className="muted">
                  Безнал: ожидалось {Number(r.expected_wallet)}, {isOpen ? 'ввели' : 'посчитали'} {Number(r.counted_wallet)}
                  {wd !== 0 ? ` (${wd > 0 ? '+' : ''}${wd}${wd < 0 ? ', недостача' : ', излишек'})` : ' ✓'}
                </div>
                <div className="muted">{new Date(r.created_at).toLocaleString('ru-RU')}</div>
              </div>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn" disabled={busyId === r.id} onClick={() => reject(r.id)}>Отклонить</button>
                <button className="btn btn--primary" disabled={busyId === r.id} onClick={() => approve(r.id)}>
                  Дать добро
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
