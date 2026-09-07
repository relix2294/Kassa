import { useEffect, useState } from 'react';
import { api } from '../api';
import Keypad from '../components/Keypad';
import type { User } from '../types';

type Staff = User & { has_pin: boolean; created_at: string };

export default function StaffPage() {
  const [users, setUsers] = useState<Staff[]>([]);
  const [adding, setAdding] = useState(false);
  const [pinFor, setPinFor] = useState<Staff | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  async function reload() {
    try {
      setUsers(await api.listUsers());
    } catch {
      /* ignore */
    }
  }
  useEffect(() => {
    reload();
  }, []);

  function flash(m: string) {
    setToast(m);
    setTimeout(() => setToast(null), 2500);
  }

  async function toggleBlock(u: Staff) {
    await api.updateUser(u.id, { is_blocked: !u.is_blocked });
    flash(u.is_blocked ? 'Разблокирован' : 'Заблокирован');
    reload();
  }

  return (
    <div className="page">
      <div className="sale-head">
        <h1>Сотрудники</h1>
        <button className="btn btn--ghost" onClick={() => setAdding(true)}>
          + Кассир
        </button>
      </div>

      <div className="list">
        {users.map((u) => (
          <div key={u.id} className="list-item list-item--static">
            <div className="list-item__main">
              <div className="list-item__name">
                {u.full_name || u.username} {u.role === 'owner' && <span className="badge badge--new">владелец</span>}
                {u.is_blocked && <span className="badge badge--off">заблокирован</span>}
              </div>
              <div className="muted">@{u.username}</div>
            </div>
            <div className="staff-actions">
              <button className="btn btn--ghost" onClick={() => setPinFor(u)}>
                PIN
              </button>
              {u.role !== 'owner' && (
                <button className="btn btn--ghost" onClick={() => toggleBlock(u)}>
                  {u.is_blocked ? 'Разблок.' : 'Блок'}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {adding && (
        <AddCashier
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            reload();
            flash('Кассир добавлен');
          }}
        />
      )}

      {pinFor && (
        <ResetPin
          user={pinFor}
          onClose={() => setPinFor(null)}
          onDone={() => {
            setPinFor(null);
            flash('PIN изменён');
          }}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

// Точек ровно столько, сколько введено цифр — длина PIN не фиксирована.
function PinDots({ pin }: { pin: string }) {
  return (
    <div className="pin-dots">
      {pin.length === 0 ? (
        <span className="pin-empty">введите PIN</span>
      ) : (
        Array.from({ length: pin.length }, (_, i) => <span key={i} className="pin-dot pin-dot--on" />)
      )}
    </div>
  );
}

function AddCashier({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [username, setUsername] = useState('');
  const [fullName, setFullName] = useState('');
  const [pin, setPin] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!username.trim() || pin.length < 4) {
      setErr('Логин и PIN (мин. 4 цифры) обязательны');
      return;
    }
    setBusy(true);
    try {
      await api.createUser({ username: username.trim(), full_name: fullName.trim(), pin, role: 'cashier' });
      onDone();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Новый кассир</h2>
        <label className="field">
          <span>Имя</span>
          <input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Азиз" />
        </label>
        <label className="field">
          <span>Логин</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="aziz" autoCapitalize="none" />
        </label>
        <div className="field">
          <span>PIN (минимум 4 цифры)</span>
          <PinDots pin={pin} />
        </div>
        <Keypad value={pin} onChange={setPin} />
        {err && <div className="change change--neg">{err}</div>}
        <div className="row">
          <button className="btn" onClick={onClose} disabled={busy}>
            Отмена
          </button>
          <button className="btn btn--primary" onClick={save} disabled={busy}>
            Создать
          </button>
        </div>
      </div>
    </div>
  );
}

function ResetPin({ user, onClose, onDone }: { user: Staff; onClose: () => void; onDone: () => void }) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    if (pin.length < 4) return;
    setBusy(true);
    try {
      await api.updateUser(user.id, { pin });
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>PIN для {user.full_name || user.username}</h2>
        <p className="muted">Минимум 4 цифры.</p>
        <PinDots pin={pin} />
        <Keypad value={pin} onChange={setPin} />
        <div className="row">
          <button className="btn" onClick={onClose} disabled={busy}>
            Отмена
          </button>
          <button className="btn btn--primary" onClick={save} disabled={busy || pin.length < 4}>
            Сохранить PIN
          </button>
        </div>
      </div>
    </div>
  );
}
