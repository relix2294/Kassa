import { useState } from 'react';
import { api } from '../api';
import { setAuth } from '../auth';
import Keypad from '../components/Keypad';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!username.trim() || !pin) {
      setErr('Введите логин и PIN');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const { token, user } = await api.login(username.trim(), pin);
      setAuth(token, user);
    } catch (e: any) {
      setErr(e.message || 'Ошибка входа');
      setPin('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="login__brand">Kassa</div>
      <div className="card login__card">
        <label className="field">
          <span>Логин</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="owner"
            autoCapitalize="none"
            autoCorrect="off"
          />
        </label>

        <div className="field">
          <span>PIN</span>
          <div className="pin-dots">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <span key={i} className={`pin-dot ${i < pin.length ? 'pin-dot--on' : ''}`} />
            ))}
          </div>
        </div>

        <Keypad value={pin} onChange={setPin} />

        {err && <div className="change change--neg">{err}</div>}

        <button className="btn btn--primary btn--big" disabled={busy} onClick={submit}>
          Войти
        </button>
      </div>
    </div>
  );
}
