import { useEffect, useMemo, useState } from 'react';
import Keypad from './Keypad';

// Форма оплаты. Используется двумя способами:
//  - на телефоне — внутри модалки;
//  - на десктопе кассы — постоянной панелью справа.
//
// Главное здесь — момент расчёта с покупателем: кассир должен за секунду
// увидеть, сколько сдачи, и не набирать сумму по цифрам.

// Купюры, которыми реально платят. Показываем только те, что больше суммы.
const NOTES = [1, 3, 5, 10, 20, 50, 100, 200, 500];

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

  const hasInput = received !== '';
  const receivedNum = Number(received) || 0;
  const change = receivedNum - total;

  // Подсказки: «без сдачи» и ближайшие купюры выше суммы.
  const quick = useMemo(() => {
    const bigger = NOTES.filter((n) => n > total).slice(0, 4);
    return bigger;
  }, [total]);

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
          {/* Сдача — самое важное число в этот момент, поэтому крупно и сверху. */}
          <div
            className={`change-box ${
              !hasInput ? 'change-box--idle' : change < 0 ? 'change-box--short' : 'change-box--ok'
            }`}
          >
            {!hasInput ? (
              <>
                <div className="change-box__label">Сколько дал покупатель?</div>
                <div className="change-box__hint">Нажмите купюру или наберите сумму</div>
              </>
            ) : change < 0 ? (
              <>
                <div className="change-box__label">Не хватает</div>
                <div className="change-box__sum">{Math.abs(change).toFixed(2)}</div>
              </>
            ) : (
              <>
                <div className="change-box__label">Сдача</div>
                <div className="change-box__sum">{change.toFixed(2)}</div>
              </>
            )}
          </div>

          {/* Быстрые суммы: без сдачи и ближайшие купюры. */}
          <div className="quick-sums">
            <button className="quick-sum quick-sum--exact" onClick={() => setReceived(String(total))}>
              Без сдачи
            </button>
            {quick.map((n) => (
              <button key={n} className="quick-sum" onClick={() => setReceived(String(n))}>
                {n}
              </button>
            ))}
          </div>

          <div className="field">
            <span>Получено наличными</span>
            <div className="keypad-value">{received || '0'}</div>
          </div>

          <Keypad value={received} onChange={setReceived} allowDecimal />

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
              disabled={!hasInput || change < 0}
              onClick={() => onPay('cash', receivedNum)}
            >
              Провести
            </button>
          </div>
        </>
      )}
    </div>
  );
}
