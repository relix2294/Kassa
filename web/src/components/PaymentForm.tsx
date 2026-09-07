import { useEffect, useState } from 'react';
import Keypad from './Keypad';

// Форма оплаты. Используется двумя способами:
//  - на телефоне — внутри модалки;
//  - на десктопе кассы — постоянной панелью справа.
export default function PaymentForm({
  total,
  disabled,
  onPay,
  onCancel,
}: {
  total: number;
  disabled?: boolean;
  onPay: (method: 'cash' | 'card', received?: number) => void;
  onCancel?: () => void;
}) {
  const [method, setMethod] = useState<'cash' | 'card' | null>(null);
  const [received, setReceived] = useState('');
  const change = Number(received) - total;

  // Чек очистился (после оплаты) — сбрасываем форму.
  useEffect(() => {
    if (total === 0) {
      setMethod(null);
      setReceived('');
    }
  }, [total]);

  return (
    <div className="payform">
      <div className="payform__total">
        <div className="payform__label">К оплате</div>
        <div className="payform__sum">{total.toFixed(2)}</div>
      </div>

      {method === null && (
        <div className="pay-methods">
          <button className="btn btn--primary btn--big" disabled={disabled} onClick={() => setMethod('cash')}>
            💵 Наличные
          </button>
          <button className="btn btn--primary btn--big" disabled={disabled} onClick={() => onPay('card')}>
            💳 Карта
          </button>
          {onCancel && (
            <button className="btn" onClick={onCancel}>
              Отмена
            </button>
          )}
        </div>
      )}

      {method === 'cash' && (
        <>
          <div className="field">
            <span>Получено наличными</span>
            <div className="keypad-value">{received || '0'}</div>
          </div>
          <Keypad value={received} onChange={setReceived} allowDecimal />
          <div className={`change ${change < 0 ? 'change--neg' : ''}`}>
            Сдача: <b>{received === '' ? '—' : change.toFixed(2)}</b>
          </div>
          <div className="row">
            <button
              className="btn"
              onClick={() => {
                setMethod(null);
                setReceived('');
              }}
            >
              Назад
            </button>
            <button
              className="btn btn--primary"
              disabled={received === '' || change < 0}
              onClick={() => onPay('cash', Number(received))}
            >
              Провести
            </button>
          </div>
        </>
      )}
    </div>
  );
}
