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

type Method = 'cash' | 'card' | 'mixed';

export default function PaymentForm({
  total,
  disabled,
  onPay,
  onCancel,
}: {
  total: number;
  disabled?: boolean;
  onPay: (method: Method, received?: number, cardAmount?: number) => void;
  onCancel?: () => void;
}) {
  const [method, setMethod] = useState<Method | null>(null);
  const [received, setReceived] = useState('');
  // Смешанная оплата: сначала вводим сумму по карте, потом наличные.
  const [cardStr, setCardStr] = useState('');
  const [mixedStep, setMixedStep] = useState<'card' | 'cash'>('card');

  const hasInput = received !== '';
  const receivedNum = Number(received) || 0;

  // Сколько нужно наличными: для чистой наличной — вся сумма, для смешанной —
  // остаток после карты.
  const cardNum = Math.min(Math.max(Number(cardStr) || 0, 0), total);
  const cashDue = method === 'mixed' ? Number((total - cardNum).toFixed(2)) : total;
  const change = receivedNum - cashDue;

  const quick = useMemo(() => NOTES.filter((n) => n > cashDue).slice(0, 4), [cashDue]);

  function reset() {
    setMethod(null);
    setReceived('');
    setCardStr('');
    setMixedStep('card');
  }

  // Чек очистился (после оплаты) — сбрасываем форму.
  useEffect(() => {
    if (total === 0) reset();
  }, [total]);

  // Экран ввода наличных (общий для «Наличные» и второго шага смешанной).
  function CashStep({ onBack }: { onBack: () => void }) {
    return (
      <>
        {method === 'mixed' && (
          <div className="mixed-recap">
            Картой <b>{cardNum.toFixed(2)}</b> · наличными нужно <b>{cashDue.toFixed(2)}</b>
          </div>
        )}

        <div
          className={`change-box ${
            !hasInput ? 'change-box--idle' : change < 0 ? 'change-box--short' : 'change-box--ok'
          }`}
        >
          {!hasInput ? (
            <>
              <div className="change-box__label">Сколько дал наличными?</div>
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

        <div className="quick-sums">
          <button className="quick-sum quick-sum--exact" onClick={() => setReceived(String(cashDue))}>
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
          <button className="btn" onClick={onBack}>
            Назад
          </button>
          <button
            className="btn btn--primary"
            disabled={!hasInput || change < 0}
            onClick={() =>
              method === 'mixed' ? onPay('mixed', receivedNum, cardNum) : onPay('cash', receivedNum)
            }
          >
            Провести
          </button>
        </div>
      </>
    );
  }

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
          <button className="btn btn--big" disabled={disabled} onClick={() => setMethod('mixed')}>
            💵➕💳 Смешанная
          </button>
          {onCancel && (
            <button className="btn" onClick={onCancel}>
              Отмена
            </button>
          )}
        </div>
      )}

      {method === 'cash' && <CashStep onBack={reset} />}

      {/* Смешанная, шаг 1: сколько по карте. Остальное добьётся наличными. */}
      {method === 'mixed' && mixedStep === 'card' && (
        <>
          <div className="field">
            <span>Сколько по карте</span>
            <div className="keypad-value">{cardStr || '0'}</div>
          </div>
          <div className="mixed-recap">
            Наличными останется <b>{cashDue.toFixed(2)}</b>
          </div>
          <Keypad value={cardStr} onChange={setCardStr} allowDecimal />
          <div className="row">
            <button className="btn" onClick={reset}>
              Назад
            </button>
            <button
              className="btn btn--primary"
              disabled={!(cardNum > 0) || cardNum >= total}
              onClick={() => setMixedStep('cash')}
            >
              Дальше
            </button>
          </div>
          {cardNum >= total && total > 0 && (
            <p className="hint">Вся сумма по карте — выберите «Карта» на прошлом шаге.</p>
          )}
        </>
      )}

      {method === 'mixed' && mixedStep === 'cash' && <CashStep onBack={() => setMixedStep('card')} />}
    </div>
  );
}
