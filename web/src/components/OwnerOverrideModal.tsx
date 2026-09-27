import { useState } from 'react';

// Разрешение владельца при расхождении кассы. Владелец подходит к кассиру,
// вводит свой логин и PIN прямо на этом экране и даёт «добро». Смена при этом
// остаётся за кассиром — фиксируется лишь, кто санкционировал.
export function OwnerOverrideModal({
  title,
  message,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  message?: string | null;
  busy?: boolean;
  onConfirm: (creds: { username: string; pin: string }) => void;
  onCancel: () => void;
}) {
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const ready = username.trim().length > 0 && pin.length > 0;

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>🔒 Нужно разрешение владельца</h2>
        <p className="warn" style={{ textAlign: 'left' }}>{title}</p>
        {message && (
          <div className="change change--neg" style={{ textAlign: 'left', whiteSpace: 'pre-line' }}>
            {message}
          </div>
        )}
        <p className="hint" style={{ textAlign: 'left' }}>
          Кассир сам продолжить не может. Позовите администратора — пусть введёт свой логин и PIN,
          чтобы дать добро. Смена останется за кассиром.
        </p>
        <label className="field">
          <span>Логин владельца</span>
          <input
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="off"
          />
        </label>
        <label className="field">
          <span>PIN владельца</span>
          <input
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            autoComplete="off"
          />
        </label>
        <div className="row">
          <button className="btn" onClick={onCancel} disabled={busy}>
            Отмена
          </button>
          <button
            className="btn btn--primary"
            disabled={!ready || busy}
            onClick={() => onConfirm({ username: username.trim(), pin })}
          >
            Дать добро
          </button>
        </div>
      </div>
    </div>
  );
}
