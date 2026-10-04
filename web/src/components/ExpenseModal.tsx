import { useState } from 'react';
import NumberInput from './NumberInput';
import ShiftWaiting from './ShiftWaiting';
import { api } from '../api';
import { useCurrentUser } from '../session';

export const EXPENSE_CATEGORIES = ['Аренда', 'Электричество', 'Вода', 'Зарплата', 'Хозтовары', 'Прочее'];

// Записать расход точки. Кассир → запрос владельцу (ждёт подтверждения),
// владелец → сразу. Используется и на экране «Смена», и в разделе «Расходы».
export default function ExpenseModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const user = useCurrentUser();
  const [amount, setAmount] = useState('');
  const [kind, setKind] = useState<'cash' | 'wallet'>('cash');
  const [category, setCategory] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState<{ request: any; message?: string | null } | null>(null);

  async function save() {
    const a = Number(amount) || 0;
    if (!(a > 0)) { setErr('Укажите сумму'); return; }
    if (!category.trim()) { setErr('Выберите категорию'); return; }
    setBusy(true); setErr(null);
    try {
      const res = await api.createExpense({ amount: a, kind, category: category.trim(), note: note.trim() || undefined });
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
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Расход</h2>
        <p className="muted">
          {user?.role === 'owner'
            ? 'Деньги уйдут из кассы и уменьшат ожидаемый остаток.'
            : 'Запрос уйдёт владельцу. Деньги спишутся из кассы только после его подтверждения.'}
        </p>
        <div className="seg">
          <button className={`seg__btn ${kind === 'cash' ? 'seg__btn--on' : ''}`} onClick={() => setKind('cash')}>Наличные</button>
          <button className={`seg__btn ${kind === 'wallet' ? 'seg__btn--on' : ''}`} onClick={() => setKind('wallet')}>Безнал</button>
        </div>
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
          <button className="btn btn--primary" onClick={save} disabled={busy}>
            {user?.role === 'owner' ? 'Записать' : 'Отправить владельцу'}
          </button>
        </div>
      </div>
    </div>
  );
}
