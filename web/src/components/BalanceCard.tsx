import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { onRealtimeEvent } from '../sync';
import { money } from './RangeControl';
import HandsLedger from './HandsLedger';

type Balance = Awaited<ReturnType<typeof api.balance>>;

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
        </div>
        {!b.till.has_open_shift && <div className="balance-card__hint">Смена закрыта — касса по последней сверке</div>}
      </button>

      {open && <BalanceDetail b={b} onClose={() => setOpen(false)} onReload={load} />}
    </>
  );
}

// Строка подотчёта сотрудника с кнопкой «Поправить» (сверка наличных на руках).
function HandRow({ h, onReload }: { h: Balance['hands'][number]; onReload: () => void }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    const n = Number(val.replace(',', '.'));
    if (!Number.isFinite(n) || n < 0) { setErr('Введите сумму (0 или больше)'); return; }
    setBusy(true); setErr(null);
    try {
      await api.adjustAccountable({ user_id: h.user_id, on_hand: n, note: 'сверка наличных на руках' });
      setEditing(false);
      onReload();
    } catch (e: any) {
      setErr(e?.body?.error || e?.message || 'Не удалось');
    } finally { setBusy(false); }
  }

  return (
    <div className="balance-row balance-row--strong">
      <div className="balance-row__main">
        <span>{h.name}</span>
        <span className="muted">
          изъял {money(h.withdrawn)} · расходы {money(h.spent_expenses)} · поставщикам {money(h.spent_suppliers)}
          {h.adjustments !== 0 ? ` · сверка ${h.adjustments > 0 ? '+' : ''}${money(h.adjustments)}` : ''}
        </span>
        {!editing && (
          <button className="btn btn--fix" onClick={() => { setVal(String(h.on_hand)); setEditing(true); }}>
            ✏️ Поправить остаток
          </button>
        )}
        {editing && (
          <div className="hand-edit">
            <input
              id={`hand-fact-${h.user_id}`}
              inputMode="decimal"
              value={val}
              onChange={(e) => setVal(e.target.value)}
              placeholder="сколько реально на руках"
              autoFocus
            />
            <button className="btn btn--primary" onClick={save} disabled={busy}>ОК</button>
            <button className="btn" onClick={() => { setEditing(false); setErr(null); }} disabled={busy}>Отмена</button>
          </div>
        )}
        {editing && <FactDiff val={val} expected={h.on_hand} />}
        {err && <span className="diff-neg">{err}</span>}
      </div>
      <span className="balance-row__val">{money(h.on_hand)}</span>
    </div>
  );
}

// Пока вводят фактический остаток — сразу видно, сходится ли с записями.
function FactDiff({ val, expected }: { val: string; expected: number }) {
  const n = Number(val.replace(',', '.'));
  if (val.trim() === '' || !Number.isFinite(n) || n < 0) return null;
  const diff = Number((n - expected).toFixed(2));
  if (diff === 0) return <span className="ledger__diff ledger__diff--ok">Сходится копейка в копейку ✓</span>;
  return diff < 0
    ? <span className="ledger__diff ledger__diff--short">Не хватает <b>{money(-diff)}</b> против записей — потрачено или отдано без записи.</span>
    : <span className="ledger__diff ledger__diff--over">На руках больше записей на <b>{money(diff)}</b>.</span>;
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

function BalanceDetail({ b, onClose, onReload }: { b: Balance; onClose: () => void; onReload: () => void }) {
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
              sub={`изъял ${money(h.withdrawn)} − расходы ${money(h.spent_expenses + h.spent_suppliers)}${h.adjustments ? ` ${h.adjustments >= 0 ? '+' : '−'} сверка ${money(Math.abs(h.adjustments))}` : ''}`}
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

        <HandsLedger refreshKey={b}>
          {b.hands.length > 0 && (
            <>
              <p className="hint">Пересчитайте деньги у сотрудника и сверьте: «Поправить остаток» сразу покажет разницу с записями.</p>
              <div className="balance-list">
                {b.hands.map((h) => (
                  <HandRow key={h.user_id} h={h} onReload={onReload} />
                ))}
              </div>
            </>
          )}
        </HandsLedger>

        <div className="row">
          <button className="btn btn--primary" onClick={onClose}>Закрыть</button>
        </div>
      </div>
    </div>
  );
}
