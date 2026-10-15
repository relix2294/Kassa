import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type Ledger, type LedgerRow, type LedgerTotals } from '../api';
import { money } from './RangeControl';

const dt = (s: string) =>
  new Date(s).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const tm = (s: string) => new Date(s).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const day = (s: string) =>
  new Date(s).toLocaleDateString('ru-RU', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${money(Math.abs(n))}`;

// Откуда деньги — человеческими словами.
function sourceLabel(r: LedgerRow): string {
  switch (r.type) {
    case 'withdrawal': return r.source === 'wallet' ? 'из кассы · безнал → на руки' : 'из кассы · наличные → на руки';
    case 'expense': return r.source === 'hand' ? 'из подотчёта (с рук)' : 'из кассы';
    case 'supplier':
      if (r.source === 'hand') return 'из подотчёта (с рук)';
      if (r.source === 'cash') return 'из кассы · наличные';
      if (r.source === 'wallet') return 'из кассы · безнал';
      return 'со стороны (личные деньги)';
    default: return 'сверка с фактом';
  }
}

const PAGE = 40;

// Подотчёт в окне «Подробнее» баланса: откуда сложилось «на руках» и лента
// всех движений (изъятия, расходы, оплаты поставщикам, сверки) с остатком
// после каждого. refreshKey — данные баланса: меняются (живьём, по событиям
// кассы) → лента перечитывается вместе с ними. children — строки сотрудников
// с «Поправить остаток», встают между итогом и лентой.
export default function HandsLedger({ refreshKey, children }: { refreshKey: unknown; children?: ReactNode }) {
  const [l, setL] = useState<Ledger | null>(null);
  const [mode, setMode] = useState<'since' | 'all'>('since');
  const [limit, setLimit] = useState(PAGE);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.ledger().then((x) => { setL(x); setErr(null); }).catch((e) => setErr(e?.message || 'Не удалось загрузить'));
  }, [refreshKey]);

  // Строки периода — новые сверху.
  const rows = useMemo(() => {
    if (!l) return [];
    const src = mode === 'since' && l.last_adjustment ? l.rows.slice(l.rows.length - l.since.rows) : l.rows;
    return [...src].reverse();
  }, [l, mode]);

  if (err) return <p className="hint">Подотчёт: {err}</p>;
  if (!l) return <p className="hint">Загружаю подотчёт…</p>;
  if (l.rows.length === 0) return <>{children}</>;

  const sinceMode = mode === 'since' && !!l.last_adjustment;
  const t: LedgerTotals = sinceMode ? l.since.totals : l.totals_all;
  const start = sinceMode ? l.since.start_balance : 0;
  const shown = rows.slice(0, limit);

  // Группировка по дням (с итогом движения «на руках» за день).
  const groups: { key: string; label: string; net: number; items: LedgerRow[] }[] = [];
  for (const r of shown) {
    const key = new Date(r.at).toDateString();
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) { g = { key, label: day(r.at), net: 0, items: [] }; groups.push(g); }
    g.items.push(r);
    g.net += r.hand_effect;
  }
  const notHand = t.supplier_cash + t.supplier_wallet + t.supplier_external + t.expenses_register;

  return (
    <>
      <div className="ledger__head">
        <h3 className="sect">Подотчёт: откуда «на руках»</h3>
        {l.last_adjustment && (
          <div className="seg">
            <button className={`seg__btn ${mode === 'since' ? 'seg__btn--on' : ''}`} onClick={() => { setMode('since'); setLimit(PAGE); }}>
              С последней сверки
            </button>
            <button className={`seg__btn ${mode === 'all' ? 'seg__btn--on' : ''}`} onClick={() => { setMode('all'); setLimit(PAGE); }}>
              За всё время
            </button>
          </div>
        )}
      </div>

      <div className="balance-list">
        {sinceMode
          ? <Line label={`Было на руках после сверки ${dt(l.last_adjustment!.at)}`} value={money(start)} />
          : <Line label="Начали с" value={money(0)} />}
        <Line
          label="+ Изъято из кассы на руки"
          sub={`наличные ${money(t.withdrawn_cash)} · безнал ${money(t.withdrawn_wallet)}`}
          value={signed(t.withdrawn)}
        />
        <Line label="− Расходы из подотчёта" value={signed(-t.expenses_hand)} />
        <Line label="− Оплаты поставщикам из подотчёта" value={signed(-t.supplier_hand)} />
        {!sinceMode && t.adjustments !== 0 && <Line label="± Сверки с фактом" value={signed(t.adjustments)} />}
        <Line label="= Сейчас должно быть на руках" value={money(start + t.hand_change)} strong />
      </div>

      {notHand > 0 && (
        <div className="balance-note">
          Не влияет на «на руках» (деньги ушли не с рук):
          {t.supplier_cash + t.supplier_wallet > 0 && <> поставщикам из кассы <b>{money(t.supplier_cash + t.supplier_wallet)}</b>;</>}
          {t.expenses_register > 0 && <> расходы из кассы <b>{money(t.expenses_register)}</b>;</>}
          {t.supplier_external > 0 && <> поставщикам «со стороны» <b>{money(t.supplier_external)}</b>.</>}
          {t.supplier_external > 0 && (
            <div className="muted ledger__warn">
              «Со стороны» = личные деньги, не из магазина. Если платили деньгами, взятыми из кассы, а отметили «со стороны» —
              «на руках» будет завышено ровно на эту сумму.
            </div>
          )}
        </div>
      )}
      {t.unassigned > 0 && (
        <div className="balance-note">
          Записи без сотрудника на <b>{money(t.unassigned)}</b> — в «на руках» не входят (не к кому отнести).
        </div>
      )}

      {children}

      <h3 className="sect">Все движения <span className="muted">({rows.length})</span></h3>
      <div className="ledger__list">
        {groups.map((g) => (
          <div key={g.key} className="balance-list">
            <div className="ledger__dayhead">
              <span>{g.label}</span>
              <span className={g.net < 0 ? 'diff-neg' : ''}>на руках за день: {signed(Number(g.net.toFixed(2)))}</span>
            </div>
            {g.items.map((r) => (
              <div key={r.id} className={`balance-row ledger__row ${r.hand_effect === 0 ? 'ledger__row--side' : ''}`}>
                <div className="balance-row__main">
                  <span>{r.title}{r.note ? <span className="muted"> · {r.note}</span> : null}</span>
                  <span className="muted">
                    {tm(r.at)} · {sourceLabel(r)} · {r.who}
                    {!r.assigned && ' · не входит в подотчёт'}
                  </span>
                </div>
                <div className="ledger__amt">
                  {r.hand_effect !== 0
                    ? <span className={`balance-row__val ${r.hand_effect < 0 ? 'diff-neg' : 'ledger__plus'}`}>{signed(r.hand_effect)}</span>
                    : <span className="balance-row__val muted">{money(r.amount)}</span>}
                  <span className="muted ledger__bal">на руках {money(r.balance)}</span>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
      {rows.length > limit && (
        <button className="btn btn--ghost" onClick={() => setLimit(limit + PAGE)}>
          Показать ещё ({rows.length - limit})
        </button>
      )}
    </>
  );
}

function Line({ label, value, sub, strong }: { label: string; value: string; sub?: string; strong?: boolean }) {
  return (
    <div className={`balance-row ${strong ? 'balance-row--strong' : ''}`}>
      <div className="balance-row__main">
        <span>{label}</span>
        {sub && <span className="muted">{sub}</span>}
      </div>
      <span className="balance-row__val">{value}</span>
    </div>
  );
}
