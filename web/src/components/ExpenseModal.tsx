import { useState } from 'react';
import NumberInput from './NumberInput';
import ShiftWaiting from './ShiftWaiting';
import { api } from '../api';
import { useCurrentUser } from '../session';
import { money } from './RangeControl';
import { SourcePicker, useMoneyPlaces, tillSub } from './MoneySource';

export const EXPENSE_CATEGORIES = ['Аренда', 'Электричество', 'Вода', 'Зарплата', 'Хозтовары', 'Прочее'];

// Записать расход точки. Кассир → запрос владельцу (ждёт подтверждения),
// владелец → сразу. Используется и на экране «Смена», и в разделе «Расходы».
export default function ExpenseModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const user = useCurrentUser();
  const isOwner = user?.role === 'owner';
  const [amount, setAmount] = useState('');
  const [kind, setKind] = useState<'cash' | 'wallet'>('cash');
  // Откуда платим: из кассы (ящик) или с рук (подотчёт — изъятые на руки).
  // Подотчёт — только у владельца/директора (изъятия — его право). Заранее
  // ничего не выбрано: владелец нажимает сам, чтобы не списать «по привычке».
  const [paidFrom, setPaidFrom] = useState<'register' | 'hand' | null>(null);
  const places = useMoneyPlaces(isOwner);
  const [category, setCategory] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState<{ request: any; message?: string | null } | null>(null);

  async function save() {
    const a = Number(amount) || 0;
    if (!(a > 0)) { setErr('Укажите сумму'); return; }
    if (!category.trim()) { setErr('Выберите категорию'); return; }
    if (isOwner && !paidFrom) { setErr('Выберите, откуда деньги: из кассы или с рук'); return; }
    setBusy(true); setErr(null);
    try {
      const res = await api.createExpense({
        amount: a, kind, category: category.trim(), note: note.trim() || undefined,
        paid_from: isOwner ? (paidFrom ?? undefined) : undefined,
      });
      if (res.pending) setPending({ request: res.request, message: res.message });
      else onDone();
    } catch (e: any) {
      setErr(e?.body?.error || e?.message || 'Не удалось записать расход');
    } finally { setBusy(false); }
  }

  if (pending) {
    return (
      <div className="modal-backdrop" onClick={(e) => e.stopPropagation()}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <ShiftWaiting
            request={pending.request}
            message={pending.message}
            poll={api.myExpenseRequest}
            cancel={api.cancelExpenseRequest}
            whatHappens="расход проведётся"
            onApproved={onDone}
            onRejected={() => { setPending(null); setErr('Владелец отклонил расход.'); }}
            onCancelled={onClose}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--scroll" onClick={(e) => e.stopPropagation()}>
        <h2>Расход</h2>
        {!isOwner && (
          <p className="muted">Запрос уйдёт владельцу. Деньги спишутся из кассы только после его подтверждения.</p>
        )}
        {isOwner && (
          <>
            <SourcePicker
              value={paidFrom}
              onChange={setPaidFrom}
              options={[
                {
                  value: 'register', title: 'Из кассы', sub: tillSub(places),
                  disabled: !!places && places.tillCash <= 0 && places.tillWallet <= 0,
                },
                {
                  value: 'hand', title: 'С рук (подотчёт)',
                  sub: places ? `у вас на руках ${money(places.onHand)}` : undefined,
                  disabled: !!places && places.onHand <= 0,
                },
              ]}
            />
            {paidFrom && (
              <p className="muted">
                {paidFrom === 'hand'
                  ? 'Платим из денег, ранее изъятых из кассы на руки. Кассу не трогает, уменьшает «на руках».'
                  : 'Деньги берём из кассового ящика — касса уменьшится.'}
              </p>
            )}
          </>
        )}
        {(!isOwner || paidFrom === 'register') && (
          <div className="seg">
            <button className={`seg__btn ${kind === 'cash' ? 'seg__btn--on' : ''}`} onClick={() => setKind('cash')}>Наличные</button>
            <button className={`seg__btn ${kind === 'wallet' ? 'seg__btn--on' : ''}`} onClick={() => setKind('wallet')}>Безнал</button>
          </div>
        )}
        <label className="field"><span>Сумма</span><NumberInput value={amount} onValue={setAmount} autoFocus /></label>
        <div className="field">
          <span>Категория</span>
          <div className="reasons">
            {EXPENSE_CATEGORIES.map((c) => (
              <button key={c} type="button" className={`chip ${category === c ? 'chip--on' : ''}`} onClick={() => setCategory(c)}>{c}</button>
            ))}
          </div>
          <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="или впишите свою" />
        </div>
        <label className="field"><span>Комментарий</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="напр. за октябрь" />
        </label>
        {err && <div className="change change--neg">{err}</div>}
        <div className="row">
          <button className="btn" onClick={onClose} disabled={busy}>Отмена</button>
          <button className="btn btn--primary" onClick={save} disabled={busy || (isOwner && !paidFrom)}>
            {user?.role === 'owner' ? 'Записать' : 'Отправить владельцу'}
          </button>
        </div>
      </div>
    </div>
  );
}
