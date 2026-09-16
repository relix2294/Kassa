import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type CartLine } from '../db';
import { cartTotal, lineTotal, lineHasDiscount, formatQty } from '../cart';
import { onCustomer } from '../customer';

// Экран покупателя — второй монитор POS-терминала.
// Только показывает: что пробивают, итог и сдачу. Никакого управления.
export default function CustomerDisplay() {
  const lines = useLiveQuery(() => db.cart.toArray(), [], [] as CartLine[]);
  const total = cartTotal(lines);
  const [paid, setPaid] = useState<{ change: number } | null>(null);
  const paidTimer = useRef<number | null>(null);

  useEffect(() => {
    return onCustomer((msg) => {
      if (msg.type === 'paid') {
        setPaid({ change: msg.change });
        if (paidTimer.current) clearTimeout(paidTimer.current);
        // Держим «спасибо» на экране, пока кассир отсчитывает сдачу.
        paidTimer.current = window.setTimeout(() => setPaid(null), 6000);
      }
    });
  }, []);

  // Новый чек начался — убираем экран «спасибо».
  useEffect(() => {
    if (lines.length > 0 && paid) setPaid(null);
  }, [lines.length]);

  // Экран «Спасибо» со сдачей после оплаты.
  if (paid) {
    return (
      <div className="cust cust--thanks">
        <div className="cust__thanks-title">Спасибо за покупку!</div>
        {paid.change > 0 && (
          <div className="cust__change">
            <span>Ваша сдача</span>
            <b>{paid.change.toFixed(2)}</b>
          </div>
        )}
      </div>
    );
  }

  // Ничего не пробито — приветствие.
  if (lines.length === 0) {
    return (
      <div className="cust cust--idle">
        <div className="cust__logo">Kassa</div>
        <div className="cust__welcome">Добро пожаловать!</div>
      </div>
    );
  }

  // Идёт продажа — показываем чек и итог.
  return (
    <div className="cust">
      <div className="cust__head">Ваша покупка</div>
      <div className="cust__list">
        {lines.map((l) => (
          <div key={l.key} className="cust__line">
            <div className="cust__line-name">
              {l.name}
              {lineHasDiscount(l) && <span className="cust__sale">скидка</span>}
            </div>
            <div className="cust__line-qty">
              {lineHasDiscount(l) ? l.discount_price : l.unit_price}
              {l.unit === 'kg' ? '/кг' : ''} × {formatQty(l)}
            </div>
            <div className="cust__line-sum">{lineTotal(l).toFixed(2)}</div>
          </div>
        ))}
      </div>
      <div className="cust__total">
        <span>Итого</span>
        <b>{total.toFixed(2)}</b>
      </div>
    </div>
  );
}
