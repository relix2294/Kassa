import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

// Экран ожидания для кассира: запрос на кассу с расхождением отправлен
// владельцу. Пока владелец не даст добро из своего кабинета — продолжить нельзя.
// Опрашиваем статус; как решится — сообщаем наверх.
export default function ShiftWaiting({
  request,
  message,
  onApproved,
  onRejected,
  onCancelled,
}: {
  request: any;
  message?: string | null;
  onApproved: () => void;
  onRejected: () => void;
  onCancelled: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const doneRef = useRef(false); // чтобы колбэк не сработал дважды

  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const { request: r } = await api.myShiftRequest();
        if (!alive || doneRef.current) return;
        // Наш запрос решён (или заменён более новым решённым) — реагируем.
        const st = r?.id === request.id ? r.status : r?.status;
        if (st === 'approved') { doneRef.current = true; onApproved(); }
        else if (st === 'rejected') { doneRef.current = true; onRejected(); }
        else if (st === 'cancelled') { doneRef.current = true; onCancelled(); }
      } catch {
        /* сеть — просто ждём дальше */
      }
    };
    const t = setInterval(check, 3000);
    check();
    return () => { alive = false; clearInterval(t); };
  }, [request.id, onApproved, onRejected, onCancelled]);

  const cd = Number(request.cash_diff);
  const wd = Number(request.wallet_diff);

  async function cancel() {
    setBusy(true);
    try {
      await api.cancelShiftRequest(request.id);
    } catch {
      /* ignore */
    } finally {
      doneRef.current = true;
      onCancelled();
    }
  }

  return (
    <div className="card card--alert">
      <h2>⏳ Ждём подтверждения владельца</h2>
      {message && <div className="warn" style={{ textAlign: 'left', whiteSpace: 'pre-line' }}>{message}</div>}
      <p className="hint" style={{ textAlign: 'left' }}>
        Позвоните владельцу и объясните ситуацию. Он подтвердит из своего кабинета —
        и касса {request.kind === 'open' ? 'откроется' : 'закроется'} автоматически.
      </p>
      <div className="mb">
        <div className="muted">Наличные: расхождение <b>{cd > 0 ? '+' : ''}{cd}</b></div>
        <div className="muted">Безнал: расхождение <b>{wd > 0 ? '+' : ''}{wd}</b></div>
      </div>
      <div className="spinner-dots" aria-hidden>● ● ●</div>
      <button className="btn" disabled={busy} onClick={cancel}>Отменить запрос</button>
    </div>
  );
}
