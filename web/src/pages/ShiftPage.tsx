import { useEffect, useState } from 'react';
import { api } from '../api';
import { useShift, openShift, closeShift, refreshShift } from '../shift';
import { useCurrentUser } from '../session';
import Keypad from '../components/Keypad';

export default function ShiftPage() {
  const user = useCurrentUser();
  const { shift } = useShift();
  const [stats, setStats] = useState<{ expected: number; stats: any } | null>(null);
  const [mode, setMode] = useState<'view' | 'open' | 'close'>('view');
  const [amount, setAmount] = useState('');
  const [closed, setClosed] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Промежуточный расчёт по открытой смене.
  async function loadStats() {
    try {
      const r = await api.currentShift();
      if (r.shift) setStats({ expected: r.expected!, stats: r.stats });
      else setStats(null);
    } catch {
      /* ignore */
    }
  }
  useEffect(() => {
    refreshShift();
  }, []);
  useEffect(() => {
    if (shift) loadStats();
  }, [shift]);

  async function doOpen() {
    setBusy(true);
    setErr(null);
    try {
      await openShift(Number(amount) || 0);
      setMode('view');
      setAmount('');
    } catch (e: any) {
      // Раньше ошибка гасилась молча: кассир жал кнопку, и ничего не происходило.
      setErr(e?.message || 'Не удалось открыть смену');
    } finally {
      setBusy(false);
    }
  }

  async function doClose() {
    setBusy(true);
    setErr(null);
    try {
      const c = await closeShift(Number(amount) || 0);
      setClosed(c);
      setMode('view');
      setAmount('');
    } catch (e: any) {
      setErr(e?.message || 'Не удалось закрыть смену');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <h1>Смена</h1>

      {err && <div className="change change--neg">{err}</div>}

      {/* Итог только что закрытой смены */}
      {closed && (
        <div className="card">
          <div className="product-name">Смена закрыта</div>
          <Row label="Ожидалось в кассе" value={closed.expected_cash} />
          <Row label="Посчитано" value={closed.counted_cash} />
          <div className={`shift-diff ${closed.difference < 0 ? 'shift-diff--neg' : closed.difference > 0 ? 'shift-diff--pos' : ''}`}>
            Расхождение: <b>{closed.difference > 0 ? '+' : ''}{closed.difference}</b>
            {closed.difference < 0 && ' (недостача)'}
            {closed.difference > 0 && ' (излишек)'}
            {closed.difference === 0 && ' — сходится ✓'}
          </div>
          {closed.difference !== 0 && (
            <p className="hint">
              Расхождение записано в журнал — владелец увидит его в кабинете и в списке смен.
            </p>
          )}
          <button className="btn" onClick={() => setClosed(null)}>ОК</button>
        </div>
      )}

      {/* Нет открытой смены */}
      {!shift && mode === 'view' && !closed && (
        <div className="card">
          <p className="hint">Смена закрыта. Откройте смену, чтобы начать продавать.</p>
          <button className="btn btn--primary btn--big" onClick={() => setMode('open')}>
            Открыть смену
          </button>
        </div>
      )}

      {/* Открытие смены */}
      {mode === 'open' && (
        <div className="card">
          <label className="field">
            <span>Размен в кассе на старте</span>
            <div className="keypad-value">{amount || '0'}</div>
          </label>
          <Keypad value={amount} onChange={setAmount} allowDecimal />
          <div className="row">
            <button className="btn" onClick={() => { setMode('view'); setAmount(''); }} disabled={busy}>Отмена</button>
            <button className="btn btn--primary" onClick={doOpen} disabled={busy}>Открыть</button>
          </div>
        </div>
      )}

      {/* Открытая смена */}
      {shift && mode === 'view' && (
        <div className="card">
          <div className="product-name">Смена открыта</div>
          <div className="muted">с {new Date(shift.opened_at).toLocaleString('ru-RU')}</div>
          <Row label="Размен" value={shift.opening_cash} />
          {stats && (
            <>
              <Row label="Продажи наличными" value={stats.stats.cash_sales} />
              <Row label="Продажи картой" value={stats.stats.card_sales} />
              <Row label="Возвраты" value={stats.stats.refunds} />
              <div className="shift-expected">
                Ожидается в кассе: <b>{stats.expected}</b>
              </div>
            </>
          )}
          <button className="btn btn--primary btn--big" onClick={() => setMode('close')}>
            Закрыть смену
          </button>
        </div>
      )}

      {/* Закрытие смены */}
      {mode === 'close' && (
        <div className="card">
          <label className="field">
            <span>Сколько денег в кассе фактически</span>
            <div className="keypad-value">{amount || '0'}</div>
          </label>
          <Keypad value={amount} onChange={setAmount} allowDecimal />
          <div className="row">
            <button className="btn" onClick={() => { setMode('view'); setAmount(''); }} disabled={busy}>Отмена</button>
            <button className="btn btn--primary" onClick={doClose} disabled={busy}>Закрыть смену</button>
          </div>
        </div>
      )}

      {/* Владелец: чужие незакрытые смены и история */}
      {user?.role === 'owner' && <OpenShifts meId={user.id} onDone={() => setErr(null)} />}
      {user?.role === 'owner' && <OwnerShifts />}
    </div>
  );
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="shift-row">
      <span className="muted">{label}</span>
      <b>{value}</b>
    </div>
  );
}

// Кассир мог уйти домой, не закрыв смену. Владелец закрывает за него,
// и в журнале видно, что закрыл именно владелец (п.26 аудита).
function OpenShifts({ meId, onDone }: { meId: string; onDone: () => void }) {
  const [rows, setRows] = useState<any[]>([]);
  const [closing, setClosing] = useState<any | null>(null);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => api.openShifts().then((r) => setRows(r.filter((s: any) => s.user_id !== meId))).catch(() => {});
  useEffect(() => { load(); }, []);

  if (rows.length === 0) return null;

  return (
    <div className="shift-history">
      <h2>Незакрытые смены сотрудников</h2>
      <div className="list">
        {rows.map((s) => (
          <div key={s.id} className="list-item list-item--static list-item--alert">
            <div className="list-item__main">
              <div className="list-item__name">{s.full_name || s.username}</div>
              <div className="muted">открыта {new Date(s.opened_at).toLocaleString('ru-RU')}</div>
            </div>
            <button className="btn btn--ghost" onClick={() => { setClosing(s); setAmount(''); }}>
              Закрыть
            </button>
          </div>
        ))}
      </div>

      {closing && (
        <div className="modal-backdrop" onClick={() => setClosing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Закрыть смену: {closing.full_name || closing.username}</h2>
            <label className="field">
              <span>Сколько денег в кассе фактически</span>
              <div className="keypad-value">{amount || '0'}</div>
            </label>
            <Keypad value={amount} onChange={setAmount} allowDecimal />
            <div className="row">
              <button className="btn" onClick={() => setClosing(null)} disabled={busy}>Отмена</button>
              <button
                className="btn btn--primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await closeShift(Number(amount) || 0, closing.user_id);
                    setClosing(null);
                    load();
                    onDone();
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Закрыть смену
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function OwnerShifts() {
  const [shifts, setShifts] = useState<any[]>([]);
  useEffect(() => {
    api.listShifts().then(setShifts).catch(() => {});
  }, []);
  const closed = shifts.filter((s) => s.status === 'closed');
  if (closed.length === 0) return null;
  return (
    <div className="shift-history">
      <h2>Закрытые смены</h2>
      <div className="list">
        {closed.map((s) => (
          <div key={s.id} className="list-item list-item--static">
            <div className="list-item__main">
              <div className="list-item__name">{s.full_name || s.username}</div>
              <div className="muted">{new Date(s.opened_at).toLocaleDateString('ru-RU')} · ожид. {s.expected_cash} / посч. {s.counted_cash}</div>
            </div>
            <div className={`stock ${s.difference < 0 ? 'stock--low' : ''}`}>
              {s.difference > 0 ? '+' : ''}{s.difference}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
