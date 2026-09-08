import { useEffect, useState } from 'react';

// Подтверждение необратимого действия: очистка чека, блокировка сотрудника,
// массовая смена цен. Раньше всё срабатывало сразу, с одного промаха.
export default function Confirm({
  title,
  text,
  confirmLabel = 'Да',
  danger,
  onConfirm,
  onCancel,
}: {
  title: string;
  text?: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter') onConfirm();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onConfirm, onCancel]);

  return (
    // Клик по фону здесь безопасен: он равен «Отмена», ничего не теряется.
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal modal--confirm" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {text && <p className="muted">{text}</p>}
        <div className="row">
          <button className="btn" onClick={onCancel} autoFocus>
            Отмена
          </button>
          <button className={`btn ${danger ? 'btn--danger' : 'btn--primary'}`} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// Хук для экранов с введёнными данными: закрытие по фону спрашивает,
// если пользователь уже что-то ввёл (п.18 аудита — час пересчёта товара
// не должен теряться от промаха мимо окна).
export function useGuardedClose(hasData: boolean, close: () => void) {
  const [asking, setAsking] = useState(false);

  const requestClose = () => {
    if (hasData) setAsking(true);
    else close();
  };

  const guard = asking ? (
    <Confirm
      title="Закрыть и потерять введённое?"
      text="Введённые данные не сохранятся."
      confirmLabel="Закрыть"
      danger
      onConfirm={() => {
        setAsking(false);
        close();
      }}
      onCancel={() => setAsking(false)}
    />
  ) : null;

  return { requestClose, guard };
}
