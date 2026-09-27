import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

// Экран ожидания для кассира: действие с расхождением/возврат отправлено
// владельцу. Пока владелец не даст добро из своего кабинета — продолжить нельзя.
// Опрашиваем статус; как решится — сообщаем наверх.
//
// По умолчанию работает со сменами; для возвратов передаём poll/cancel/whatHappens.
export default function ShiftWaiting({
  request,
  message,
  onApproved,
  onRejected,
  onCancelled,
  poll,
  cancel: cancelApi,
  whatHappens,
}: {
  request: any;
  message?: string | null;
  onApproved: () => void;
  onRejected: () => void;
  onCancelled: () => void;
  poll?: () => Promise<{ request: any | null }>;
  cancel?: (id: string) => Promise<any>;
  whatHappens?: string;
}) {
  const [busy, setBusy] = useState(false);
  const doneRef = useRef(false); // чтобы колбэк не сработал дважды

  const pollFn = poll ?? api.myShiftRequest;
  const cancelFn = cancelApi ?? api.cancelShiftRequest;

  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const { request: r } = await pollFn();
        if (!alive || doneRef.current) return;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.id]);

  const what = whatHappens ?? (request.kind === 'open' ? 'касса откроется' : 'касса закроется');

  async function cancel() {
    setBusy(true);
    try {
      await cancelFn(request.id);
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
        Позвоните владельцу и объясните ситуацию. Он подтвердит из своего кабинета — и {what} автоматически.
      </p>
      <div className="spinner-dots" aria-hidden>● ● ●</div>
      <button className="btn" disabled={busy} onClick={cancel}>Отменить запрос</button>
    </div>
  );
}
