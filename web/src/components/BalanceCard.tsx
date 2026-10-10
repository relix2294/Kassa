import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { onRealtimeEvent } from '../sync';
import { money } from './RangeControl';

type Balance = Awaited<ReturnType<typeof api.balance>>;

const dt = (s: string) =>
  new Date(s).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

// Живой баланс точки для владельца: «сколько денег у нас прямо сейчас».
// Карточка вверху Кабинета; по клику — подробная детализация (подотчёт по
// людям, движение за сегодня, ленты изъятий и расходов по датам).
export default function BalanceCard() {
  const [b, setB] = useState<Balance | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(() => { api.balance().then(setB).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(
    () => onRealtimeEvent((t) => {
      if (t === 'sale' || t === 'return' || t === 'shift' || t === 'data_updated' || t === 'log') load();
    }),
    [load],
  );

  if (!b) return null;

  return (
    <>
      <button className="balance-card" onClick={() => setOpen(true)} title="Подробнее">
        <div className="balance-card__head">
          <span className="balance-card__label">Сейчас у нас денег</span>
          <span className="balance-card__more">Подробнее ›</span>
        </div>
        <div className="balance-card__total">{money(b.total_cash)}</div>
        <div className="balance-card__rows">
          <span className="balance-chip">💵 Касса: <b>{money(b.till.total)}</b></span>
          {b.hands_total !== 0 && <span className="balance-chip">✋ На руках: <b>{money(b.hands_total)}</b></span>}
          {b.supplier_debt > 0 && <span className="balance-chip balance-chip--debt">💰 Долг: <b>{money(b.supplier_debt)}</b></span>}
        </div>
        {!b.till.has_open_shift && <div className="balance-card__hint">Смена закрыта — касса по последней сверке</div>}
      </button>

      {open && <BalanceDetail b={b} onClose={() => setOpen(false)} />}
    </>
  );
}

function Row({ label, value, neg, sub, strong }: { label: string; value: string; neg?: boolean; sub?: string; strong?: boolean }) {
  return (
    <div className={`balance-row ${strong ? 'balance-row--strong' : ''}`}>
      <div className="balance-row__main">
        <span>{label}</span>
        {sub && <span className="muted">{sub}</span>}
      </div>
      <span className={`balance-row__val ${neg ? 'diff-neg' : ''}`}>{value}</span>
    </div>
  );
}

function BalanceDetail({ b, onClose }: { b: Balance; onClose: () => void }) {
  const t = b.today;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}>
        <h2>Баланс магазина</h2>

        <div className="balance-total-big">
          <span className="muted">Всего наших денег сейчас</span>
          <b>{money(b.total_cash)}</b>
        </div>

        <h3 className="sect">Где деньги</h3>
        <div className="balance-list">
          <Row label="В кассе — наличные" value={money(b.till.cash)} />
          <Row label="В кассе — безнал (кошельки)" value={money(b.till.wallet)} />
          {b.hands.map((h) => (
            <Row
              key={h.user_id}
              label={`На руках — ${h.name}`}
              value={money(h.on_hand)}
              sub={`изъял ${money(h.withdrawn)} − расходы ${money(h.spent_expenses + h.spent_suppliers)}`}
            />
          ))}
          <Row label="Итого наших денег" value={money(b.total_cash)} strong />
        </div>

        {b.supplier_debt > 0 && (
          <div className="balance-note">
            💰 Долг поставщикам: <b className="diff-neg">{money(b.supplier_debt)}</b>
            <span className="muted"> — это не наши деньги, мы их должны</span>
          </div>
        )}

        <h3 className="sect">Движение за сегодня</h3>
        <div className="balance-list">
          <Row label="Продажи наличными" value={`+${money(t.sales_cash)}`} />
          <Row label="Продажи безналом" value={`+${money(t.sales_card)}`} />
          <Row label="Пришло всего" value={`+${money(t.in_total)}`} strong />
          {t.refunds > 0 && <Row label="Возвраты покупателям" value={`−${money(t.refunds)}`} neg />}
          {t.expenses_register > 0 && <Row label="Расходы из кассы" value={`−${money(t.expenses_register)}`} neg />}
          {t.expenses_hand > 0 && <Row label="Расходы из подотчёта" value={`−${money(t.expenses_hand)}`} neg />}
          {t.supplier_till > 0 && <Row label="Оплата поставщикам из кассы" value={`−${money(t.supplier_till)}`} neg />}
          {t.supplier_hand > 0 && <Row label="Оплата поставщикам из подотчёта" value={`−${money(t.supplier_hand)}`} neg />}
          <Row label="Ушло всего" value={`−${money(t.out_total)}`} neg strong />
          {t.withdrawn > 0 && (
            <Row label="Изъято из кассы на руки" value={money(t.withdrawn)} sub="не расход — деньги перешли в подотчёт" />
          )}
        </div>

        {b.hands.length > 0 && (
          <>
            <h3 className="sect">Подотчёт по сотрудникам</h3>
            <div className="balance-list">
              {b.hands.map((h) => (
                <Row
                  key={h.user_id}
                  label={h.name}
                  value={money(h.on_hand)}
                  strong
                  sub={`изъял ${money(h.withdrawn)} · расходы ${money(h.spent_expenses)} · поставщикам ${money(h.spent_suppliers)}`}
                />
              ))}
            </div>
          </>
        )}

        <h3 className="sect">Изъятия из кассы</h3>
        {b.withdrawals.length === 0 && <p className="hint">Изъятий пока не было.</p>}
        <div className="list">
          {b.withdrawals.map((w) => (
            <div key={w.id} className="list-item list-item--static">
              <div className="list-item__main">
                <div className="list-item__name">
                  {money(w.amount)} {w.kind === 'wallet' ? '· безнал' : '· наличные'}
                </div>
                <div className="muted">
                  {dt(w.created_at)} · {w.full_name || w.username || '—'}{w.note ? ` · ${w.note}` : ''}
                </div>
              </div>
            </div>
          ))}
        </div>

        <h3 className="sect">Расходы</h3>
        {b.expenses.length === 0 && <p className="hint">Расходов пока не было.</p>}
        <div className="list">
          {b.expenses.map((e) => (
            <div key={e.id} className="list-item list-item--static">
              <div className="list-item__main">
                <div className="list-item__name">
                  {e.category} <span className="muted">· {e.paid_from === 'hand' ? 'из подотчёта' : 'из кассы'}</span>
                </div>
                <div className="muted">
                  {dt(e.created_at)} · {e.full_name || e.username || '—'}{e.note ? ` · ${e.note}` : ''}
                </div>
              </div>
              <div className="stock stock--low">−{money(e.amount)}</div>
            </div>
          ))}
        </div>

        <div className="row">
          <button className="btn btn--primary" onClick={onClose}>Закрыть</button>
        </div>
      </div>
    </div>
  );
}
