import { useEffect, useState } from 'react';
import NumberInput from '../components/NumberInput';
import { api } from '../api';
import { useShift, openShift, closeShift, refreshShift } from '../shift';
import { useCurrentUser } from '../session';
import ShiftWaiting from '../components/ShiftWaiting';
import ShiftRequests from '../components/ShiftRequests';
import ReturnRequests from '../components/ReturnRequests';
import ExpenseRequests from '../components/ExpenseRequests';
import ExpenseModal from '../components/ExpenseModal';

type Stats = { expectedCash: number; expectedWallet: number; stats: any } | null;

export default function ShiftPage() {
  const user = useCurrentUser();
  const { shift } = useShift();
  const [stats, setStats] = useState<Stats>(null);
  const [mode, setMode] = useState<'view' | 'open' | 'close'>('view');
  const [cashIn, setCashIn] = useState('');
  const [walletIn, setWalletIn] = useState('');
  const [closed, setClosed] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [expenseOpen, setExpenseOpen] = useState(false);
  // Ожидание подтверждения владельца при расхождении (кассир сам не проходит).
  const [pending, setPending] = useState<{ action: 'open' | 'close'; request: any; message?: string | null } | null>(null);

  async function loadStats() {
    try {
      const r = await api.currentShift();
      if (r.shift) setStats({ expectedCash: r.expected_cash ?? 0, expectedWallet: r.expected_wallet ?? 0, stats: r.stats });
      else setStats(null);
    } catch {
      /* ignore */
    }
  }
  useEffect(() => { refreshShift(); }, []);
  useEffect(() => { if (shift) loadStats(); }, [shift]);
  // При открытии подставляем остаток от прошлой смены (обе кассы).
  useEffect(() => {
    if (mode === 'open') {
      api.expectedOpening().then((r) => {
        setCashIn(r.cash > 0 ? String(r.cash) : '');
        setWalletIn(r.wallet > 0 ? String(r.wallet) : '');
      }).catch(() => {});
    }
  }, [mode]);

  async function doOpen() {
    setBusy(true); setErr(null);
    try {
      const res = await openShift(Number(cashIn) || 0, Number(walletIn) || 0);
      if (res.pending) { setPending({ action: 'open', request: res.request, message: res.message }); }
      else { setMode('view'); setCashIn(''); setWalletIn(''); }
    } catch (e: any) {
      setErr(e?.body?.message || e?.message || 'Не удалось открыть смену');
    } finally { setBusy(false); }
  }

  async function doClose() {
    setBusy(true); setErr(null);
    try {
      const res = await closeShift(Number(cashIn) || 0, Number(walletIn) || 0);
      if (res.pending) { setPending({ action: 'close', request: res.request, message: res.message }); }
      else { setClosed(res.shift); setMode('view'); setCashIn(''); setWalletIn(''); }
    } catch (e: any) {
      setErr(e?.body?.message || e?.message || 'Не удалось закрыть смену');
    } finally { setBusy(false); }
  }

  // Ждём подтверждения владельца — остальное не показываем.
  if (pending) {
    return (
      <div className="page">
        <h1>Смена</h1>
        <ShiftWaiting
          request={pending.request}
          message={pending.message}
          onApproved={async () => {
            setPending(null); setCashIn(''); setWalletIn('');
            await refreshShift();
            if (pending.action === 'close') { await loadStats(); setMode('view'); }
            else setMode('view');
          }}
          onRejected={() => { setPending(null); setErr('Владелец отклонил запрос. Пересчитайте и попробуйте снова.'); }}
          onCancelled={() => setPending(null)}
        />
      </div>
    );
  }

  return (
    <div className="page">
      <h1>Смена</h1>

      {err && <div className="change change--neg">{err}</div>}

      {/* Владельцу: запросы кассиров на кассу с расхождением, возврат и расход */}
      {user?.role === 'owner' && <ShiftRequests />}
      {user?.role === 'owner' && <ReturnRequests />}
      {user?.role === 'owner' && <ExpenseRequests />}

      {/* Итог только что закрытой смены */}
      {closed && (
        <div className="card">
          <div className="product-name">Смена закрыта</div>
          <DiffBlock label="Наличные" expected={closed.expected_cash} counted={closed.counted_cash} diff={closed.difference} />
          <DiffBlock label="Безнал (кошельки)" expected={closed.expected_wallet} counted={closed.counted_wallet} diff={closed.wallet_difference} />
          {(Number(closed.difference) !== 0 || Number(closed.wallet_difference) !== 0) && (
            <p className="hint">Расхождение записано в журнал — владелец увидит его в кабинете и в списке смен.</p>
          )}
          <button className="btn" onClick={() => setClosed(null)}>ОК</button>
        </div>
      )}

      {/* Нет открытой смены */}
      {!shift && mode === 'view' && !closed && (
        <div className="card">
          <p className="hint">Смена закрыта. Примите кассу, чтобы начать продавать.</p>
          <button className="btn btn--primary btn--big" onClick={() => setMode('open')}>Принять кассу</button>
        </div>
      )}

      {/* Приём кассы */}
      {mode === 'open' && (
        <div className="card">
          <p className="hint">Пересчитайте деньги — наличные и на кошельках. Должно совпасть с остатком прошлой смены.</p>
          <label className="field"><span>Наличные в кассе</span><NumberInput value={cashIn} onValue={setCashIn} autoFocus /></label>
          <label className="field"><span>Безнал — на кошельках</span><NumberInput value={walletIn} onValue={setWalletIn} /></label>
          <div className="row">
            <button className="btn" onClick={() => { setMode('view'); setCashIn(''); setWalletIn(''); }} disabled={busy}>Отмена</button>
            <button className="btn btn--primary" onClick={() => doOpen()} disabled={busy}>Принять</button>
          </div>
        </div>
      )}

      {/* Открытая смена */}
      {shift && mode === 'view' && (
        <div className="card">
          <div className="product-name">Смена открыта</div>
          <div className="muted">с {new Date(shift.opened_at).toLocaleString('ru-RU')}</div>
          <Row label="Размен наличными" value={shift.opening_cash} />
          <Row label="Размен безнал" value={shift.opening_wallet} />
          {stats && (
            <>
              <Row label="Продажи наличными" value={stats.stats.cash_sales} />
              <Row label="Продажи безналом" value={stats.stats.card_sales} />
              <Row label="Возвраты" value={stats.stats.refunds} />
              {Number(stats.stats.withdrawn) > 0 && <Row label="Изъято наличных" value={stats.stats.withdrawn} />}
              {Number(stats.stats.wallet_withdrawn) > 0 && <Row label="Изъято безнал" value={stats.stats.wallet_withdrawn} />}
              {Number(stats.stats.spent_cash) > 0 && <Row label="Расходы наличными" value={stats.stats.spent_cash} />}
              {Number(stats.stats.spent_wallet) > 0 && <Row label="Расходы безнал" value={stats.stats.spent_wallet} />}
              {Number(stats.stats.supplier_cash) > 0 && <Row label="Поставщикам наличными" value={stats.stats.supplier_cash} />}
              {Number(stats.stats.supplier_wallet) > 0 && <Row label="Поставщикам безнал" value={stats.stats.supplier_wallet} />}
              <div className="shift-expected">Ожидается наличными: <b>{stats.expectedCash}</b></div>
              <div className="shift-expected">Ожидается на кошельках: <b>{stats.expectedWallet}</b></div>
            </>
          )}
          <button className="btn btn--ghost" onClick={() => setExpenseOpen(true)}>➖ Записать расход</button>
          {user?.role === 'owner' && (
            <button className="btn btn--ghost" onClick={() => setWithdrawOpen(true)}>Изъять из кассы</button>
          )}
          <button className="btn btn--primary btn--big" onClick={() => setMode('close')}>Закрыть смену</button>
        </div>
      )}

      {expenseOpen && (
        <ExpenseModal onClose={() => setExpenseOpen(false)} onDone={() => { setExpenseOpen(false); loadStats(); }} />
      )}

      {withdrawOpen && stats && (
        <WithdrawModal
          maxCash={stats.expectedCash}
          maxWallet={stats.expectedWallet}
          onClose={() => setWithdrawOpen(false)}
          onDone={() => { setWithdrawOpen(false); loadStats(); }}
        />
      )}

      {/* Сдача кассы */}
      {mode === 'close' && (
        <div className="card">
          <p className="hint">Пересчитайте и введите, сколько сейчас фактически: наличными и на кошельках.</p>
          <label className="field"><span>Наличные в кассе</span><NumberInput value={cashIn} onValue={setCashIn} autoFocus /></label>
          <label className="field"><span>Безнал — на кошельках</span><NumberInput value={walletIn} onValue={setWalletIn} /></label>
          <div className="row">
            <button className="btn" onClick={() => { setMode('view'); setCashIn(''); setWalletIn(''); }} disabled={busy}>Отмена</button>
            <button className="btn btn--primary" onClick={() => doClose()} disabled={busy}>Закрыть смену</button>
          </div>
        </div>
      )}

      {/* Владелец: чужие незакрытые смены и история */}
      {user?.role === 'owner' && <OpenShifts meId={user.id} onDone={() => setErr(null)} />}
      {user?.role === 'owner' && <OwnerShifts />}
    </div>
  );
}

function DiffBlock({ label, expected, counted, diff }: { label: string; expected: number; counted: number; diff: number }) {
  const d = Number(diff);
  return (
    <div className="mb">
      <Row label={`${label}: ожидалось`} value={expected} />
      <Row label={`${label}: посчитано`} value={counted} />
      <div className={`shift-diff ${d < 0 ? 'shift-diff--neg' : d > 0 ? 'shift-diff--pos' : ''}`}>
        Расхождение: <b>{d > 0 ? '+' : ''}{d}</b>
        {d < 0 && ' (недостача)'}{d > 0 && ' (излишек)'}{d === 0 && ' ✓'}
      </div>
    </div>
  );
}

function WithdrawModal({ maxCash, maxWallet, onClose, onDone }: {
  maxCash: number; maxWallet: number; onClose: () => void; onDone: () => void;
}) {
  const [kind, setKind] = useState<'cash' | 'wallet'>('cash');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const max = kind === 'wallet' ? maxWallet : maxCash;

  async function save() {
    const a = Number(amount) || 0;
    if (!(a > 0)) { setErr('Укажите сумму'); return; }
    if (a > max) { setErr(`Доступно только ${max.toFixed(2)}`); return; }
    setBusy(true); setErr(null);
    try {
      await api.withdrawCash(a, kind, note.trim() || undefined);
      onDone();
    } catch (e: any) {
      setErr(e?.body?.message || e?.message || 'Не удалось изъять');
    } finally { setBusy(false); }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Изъятие из кассы</h2>
        <div className="seg">
          <button className={`seg__btn ${kind === 'cash' ? 'seg__btn--on' : ''}`} onClick={() => setKind('cash')}>Наличные</button>
          <button className={`seg__btn ${kind === 'wallet' ? 'seg__btn--on' : ''}`} onClick={() => setKind('wallet')}>Безнал</button>
        </div>
        <p className="muted">Доступно {kind === 'wallet' ? 'на кошельках' : 'наличными'}: <b>{max.toFixed(2)}</b>.</p>
        <label className="field"><span>Сколько изъять</span><NumberInput value={amount} onValue={setAmount} autoFocus /></label>
        <label className="field"><span>Причина</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="напр. инкассация" />
        </label>
        {err && <div className="change change--neg">{err}</div>}
        <div className="row">
          <button className="btn" onClick={onClose} disabled={busy}>Отмена</button>
          <button className="btn btn--primary" onClick={save} disabled={busy}>Изъять</button>
        </div>
      </div>
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

// Владелец закрывает смену за ушедшего кассира (п.26 аудита).
function OpenShifts({ meId, onDone }: { meId: string; onDone: () => void }) {
  const [rows, setRows] = useState<any[]>([]);
  const [closing, setClosing] = useState<any | null>(null);
  const [cash, setCash] = useState('');
  const [wallet, setWallet] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
            <button className="btn btn--ghost" onClick={() => { setClosing(s); setCash(''); setWallet(''); setErr(null); }}>
              Закрыть
            </button>
          </div>
        ))}
      </div>

      {closing && (
        <div className="modal-backdrop" onClick={() => setClosing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Закрыть смену: {closing.full_name || closing.username}</h2>
            <label className="field"><span>Наличные в кассе</span><NumberInput value={cash} onValue={setCash} autoFocus /></label>
            <label className="field"><span>Безнал — на кошельках</span><NumberInput value={wallet} onValue={setWallet} /></label>
            {err && <div className="change change--neg">{err}</div>}
            <div className="row">
              <button className="btn" onClick={() => setClosing(null)} disabled={busy}>Отмена</button>
              <button
                className="btn btn--primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true); setErr(null);
                  try {
                    await closeShift(Number(cash) || 0, Number(wallet) || 0, closing.user_id);
                    setClosing(null); load(); onDone();
                  } catch (e: any) {
                    setErr(e?.body?.message || e?.message || 'Не удалось закрыть смену');
                  } finally { setBusy(false); }
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
        {closed.map((s) => {
          const wd = Number(s.wallet_difference ?? 0);
          const cd = Number(s.difference ?? 0);
          return (
            <div key={s.id} className="list-item list-item--static">
              <div className="list-item__main">
                <div className="list-item__name">{s.full_name || s.username}</div>
                <div className="muted">
                  {new Date(s.opened_at).toLocaleDateString('ru-RU')} · нал {s.counted_cash}/{s.expected_cash} · безнал {s.counted_wallet ?? 0}/{s.expected_wallet ?? 0}
                </div>
              </div>
              <div className={`stock ${cd < 0 || wd < 0 ? 'stock--low' : ''}`}>
                {cd !== 0 ? `нал ${cd > 0 ? '+' : ''}${cd}` : ''}{cd !== 0 && wd !== 0 ? ' · ' : ''}{wd !== 0 ? `безнал ${wd > 0 ? '+' : ''}${wd}` : ''}
                {cd === 0 && wd === 0 ? '✓' : ''}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
