import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import type { Product } from '../types';
import NumberInput from '../components/NumberInput';
import { api, type Range } from '../api';
import { onRealtimeEvent } from '../sync';
import RangeControl, { money } from '../components/RangeControl';
import { SourcePicker, useMoneyPlaces, tillSub, type MoneyPlaces, type SourceOption } from '../components/MoneySource';

const SOURCE_LABEL: Record<string, string> = {
  cash: 'из кассы (нал)', wallet: 'из кассы (безнал)', hand: 'с рук (подотчёт)', external: 'со стороны',
};

// Поставщики и долги (постоплата): кому и сколько должны, что оплатили за период,
// журнал платежей и возвратов — всё на одном экране, без лишних нажатий.
export default function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [totalDebt, setTotalDebt] = useState(0);
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [range, setRange] = useState<Range>({ period: 'today' });
  const [stats, setStats] = useState<Awaited<ReturnType<typeof api.supplierStats>> | null>(null);

  const load = useCallback(() => {
    api.listSuppliers().then((r) => { setSuppliers(r.suppliers); setTotalDebt(r.total_debt); }).catch(() => {});
  }, []);
  const loadStats = useCallback(() => {
    api.supplierStats(range).then(setStats).catch(() => {});
  }, [range]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => onRealtimeEvent((t) => {
    if (t === 'shift' || t === 'data_updated') { load(); loadStats(); }
  }), [load, loadStats]);

  function flash(m: string) { setToast(m); setTimeout(() => setToast(null), 2500); }

  const paidFromTill = stats ? stats.paid_cash + stats.paid_wallet : 0;
  // Сколько оплачено каждому за выбранный период — рядом с его долгом.
  const paidBy = useMemo(() => new Map((stats?.by_supplier ?? []).map((r) => [r.id, r])), [stats]);

  // Журнал: платежи и возвраты товара одной лентой, свежее сверху. Деньги,
  // вернувшиеся по возврату, уже учтены в самой строке возврата.
  const journal = useMemo(() => {
    if (!stats) return [];
    type Row =
      | { kind: 'pay'; at: string; p: (typeof stats.payments_list)[number] }
      | { kind: 'ret'; at: string; r: (typeof stats.returns_list)[number] };
    const rows: Row[] = [
      ...stats.payments_list.filter((p) => !p.return_id).map((p) => ({ kind: 'pay' as const, at: p.created_at, p })),
      ...stats.returns_list.map((r) => ({ kind: 'ret' as const, at: r.created_at, r })),
    ];
    return rows.sort((x, y) => +new Date(y.at) - +new Date(x.at));
  }, [stats]);

  const dayLabel = (iso: string) => {
    const d = new Date(iso);
    const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
    const now = new Date();
    const yest = new Date(now.getTime() - 86400000);
    if (same(d, now)) return 'Сегодня';
    if (same(d, yest)) return 'Вчера';
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  };
  const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="page page--wide">
      <div className="sale-head">
        <h1>Долги</h1>
        <button className="btn btn--ghost" onClick={() => setAdding(true)}>+ Поставщик</button>
      </div>

      <RangeControl range={range} onChange={setRange} />
      <div className="kpi-grid">
        <Kpi label="Должны поставщикам" value={money(totalDebt)} danger={totalDebt > 0} hint="сейчас, всего" />
        <Kpi
          label="Оплачено за период"
          value={money(stats?.paid ?? 0)}
          big
          hint={stats && stats.paid !== 0
            ? [
                stats.refunded > 0 ? 'за вычетом возвратов денег' : '',
                paidFromTill ? `касса ${money(paidFromTill)}` : '',
                stats.paid_hand ? `с рук ${money(stats.paid_hand)}` : '',
                stats.paid_external ? `со стороны ${money(stats.paid_external)}` : '',
              ].filter(Boolean).join(' · ')
            : undefined}
        />
        <Kpi
          label="Возвраты поставщикам"
          value={money(stats?.returned ?? 0)}
          hint={stats && stats.returns > 0 ? `возвратов: ${stats.returns}${stats.refunded ? ` · деньгами вернули ${money(stats.refunded)}` : ''}` : undefined}
        />
        <Kpi label="Закуплено (накладные)" value={money(stats?.purchased ?? 0)} hint={stats ? `накладных: ${stats.invoices}` : undefined} />
      </div>

      <div className="debts-grid">
        {/* Слева: кто сколько должен и сколько мы ему заплатили за период. */}
        <section>
          <h2 className="sect">Поставщики</h2>
          {suppliers.length === 0 && <p className="hint">Пока нет поставщиков. Заведите первого кнопкой «+ Поставщик».</p>}
          <div className="list">
            {suppliers.map((s) => {
              const row = paidBy.get(s.id);
              return (
                <button key={s.id} className="list-item" onClick={() => setOpenId(s.id)}>
                  <div className="list-item__main">
                    <div className="list-item__name">{s.name}</div>
                    <div className="muted">{s.phone || 'без телефона'} · накладных: {s.invoices}</div>
                  </div>
                  <div className="list-item__side">
                    <div className={`stock ${Number(s.debt) > 0 ? 'stock--low' : ''}`}>
                      {Number(s.debt) > 0 ? `долг ${Number(s.debt).toFixed(2)}` : 'нет долга'}
                    </div>
                    <div className="muted">{row && row.paid !== 0 ? `оплачено ${money(row.paid)}` : 'за период не платили'}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        {/* Справа: что именно платили и возвращали, по порядку. */}
        <section>
          <h2 className="sect">Журнал платежей и возвратов{stats ? ` · ${journal.length}` : ''}</h2>
          {stats && journal.length === 0 && <p className="hint">За этот период платежей и возвратов не было.</p>}
          <div className="list">
            {journal.map((row, i) => {
              const showDay = i === 0 || dayLabel(row.at) !== dayLabel(journal[i - 1].at);
              return (
                <div key={`${row.kind}-${row.kind === 'pay' ? row.p.id : row.r.id}`} className="journal-item-wrap">
                  {showDay && <div className="journal-day">{dayLabel(row.at)}</div>}
                  {row.kind === 'pay' ? (
                    <button className="list-item" onClick={() => setOpenId(row.p.supplier_id)}>
                      <div className="list-item__main">
                        <div className="list-item__name">{row.p.supplier_name}</div>
                        <div className="muted">
                          {timeOf(row.at)} · {SOURCE_LABEL[row.p.source] ?? row.p.source}
                          {row.p.by_user ? ` · внёс ${row.p.by_user}` : ''}
                        </div>
                        <div className="muted">
                          накладная от {new Date(row.p.invoice_at).toLocaleDateString('ru-RU')} на {money(row.p.invoice_total)}
                          {row.p.note ? ` · ${row.p.note}` : ''}
                        </div>
                      </div>
                      <div className="stock">−{money(row.p.amount)}</div>
                    </button>
                  ) : (
                    <button className="list-item journal-ret" onClick={() => setOpenId(row.r.supplier_id)}>
                      <div className="list-item__main">
                        <div className="list-item__name">{row.r.supplier_name} · возврат товара</div>
                        <div className="muted">
                          {timeOf(row.at)}{row.r.by_user ? ` · оформил ${row.r.by_user}` : ''}
                        </div>
                        <div className="muted">
                          {row.r.items.map((it) => `${it.name} × ${it.qty}`).join(', ') || 'без товара (корректировка суммы)'}
                          {row.r.refund_amount > 0
                            ? ` · деньгами вернули ${money(row.r.refund_amount)} (${REFUND_LABEL[row.r.refund_source ?? ''] ?? row.r.refund_source})`
                            : ' · долг уменьшен'}
                          {row.r.note ? ` · ${row.r.note}` : ''}
                        </div>
                      </div>
                      <div className="stock journal-ret__sum">+{money(row.r.amount)}</div>
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </div>

      {adding && (
        <AddSupplier
          onClose={() => setAdding(false)}
          onDone={() => { setAdding(false); load(); flash('Поставщик добавлен'); }}
        />
      )}

      {openId && (
        <SupplierDetail
          id={openId}
          onClose={() => { setOpenId(null); load(); loadStats(); }}
          onChange={() => { load(); loadStats(); }}
          onFlash={flash}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

const REFUND_LABEL: Record<string, string> = {
  cash: 'в кассу, нал', wallet: 'в кассу, безнал', hand: 'на руки', external: 'мимо кассы',
};

function Kpi({ label, value, big, hint, danger }: { label: string; value: string; big?: boolean; hint?: string; danger?: boolean }) {
  return (
    <div className={`kpi ${big ? 'kpi--big' : ''} ${danger ? 'kpi--danger' : ''}`}>
      <div className="kpi__label">{label}</div>
      <div className="kpi__value">{value}</div>
      {hint && <div className="kpi__hint">{hint}</div>}
    </div>
  );
}

function AddSupplier({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!name.trim()) { setErr('Укажите имя'); return; }
    setBusy(true); setErr(null);
    try {
      await api.createSupplier({ name: name.trim(), phone: phone.trim() || undefined });
      onDone();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Новый поставщик</h2>
        <label className="field"><span>Название / имя</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="напр. Оптбаза Сомони" autoFocus />
        </label>
        <label className="field"><span>Телефон</span>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="необязательно" />
        </label>
        {err && <div className="change change--neg">{err}</div>}
        <div className="row">
          <button className="btn" onClick={onClose} disabled={busy}>Отмена</button>
          <button className="btn btn--primary" onClick={save} disabled={busy}>Добавить</button>
        </div>
      </div>
    </div>
  );
}

function SupplierDetail({ id, onClose, onChange, onFlash }: {
  id: string; onClose: () => void; onChange: () => void; onFlash: (m: string) => void;
}) {
  const [data, setData] = useState<any | null>(null);
  const [addInv, setAddInv] = useState(false);
  const [payFor, setPayFor] = useState<any | null>(null);
  const [returnFor, setReturnFor] = useState<any | null>(null);
  const [editSup, setEditSup] = useState(false);

  const reload = useCallback(() => {
    api.getSupplier(id).then(setData).catch(() => {});
  }, [id]);
  useEffect(() => { reload(); }, [reload]);

  if (!data) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="sale-head">
          <h2>{data.supplier.name}</h2>
          <button className="btn btn--ghost" onClick={() => setEditSup(true)}>Изменить</button>
        </div>
        <div className="muted mb">
          {data.supplier.phone || 'без телефона'} · долг:{' '}
          <b className={data.debt > 0 ? 'diff-neg' : ''}>{Number(data.debt).toFixed(2)}</b>
        </div>

        <button className="btn btn--primary btn--pick" onClick={() => setAddInv(true)}>+ Накладная</button>

        {data.invoices.length === 0 && <p className="hint">Накладных пока нет.</p>}

        <div className="list">
          {data.invoices.map((i: any) => (
            <div key={i.id} className="list-item list-item--static" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div className="list-item__main">
                  <div className="list-item__name">
                    {new Date(i.created_at).toLocaleDateString('ru-RU')} · накладная {Number(i.total).toFixed(2)}
                  </div>
                  <div className="muted">
                    оплачено {Number(i.paid).toFixed(2)}
                    {Number(i.returned) > 0 ? ` · возвращено ${Number(i.returned).toFixed(2)}` : ''}
                    {i.note ? ` · ${i.note}` : ''}
                  </div>
                </div>
                <div className="list-item__side">
                  <div className={`stock ${Number(i.remaining) > 0 ? 'stock--low' : ''}`}>
                    {Number(i.remaining) > 0 ? `−${Number(i.remaining).toFixed(2)}` : 'закрыта'}
                  </div>
                  <div className="inv-actions">
                    {Number(i.remaining) > 0 && (
                      <button className="btn btn--link" onClick={() => setPayFor(i)}>Оплатить</button>
                    )}
                    {Number(i.total) - Number(i.returned) > 0 && (
                      <button className="btn btn--link" onClick={() => setReturnFor(i)}>Вернуть товар</button>
                    )}
                  </div>
                </div>
              </div>
              {/* История платежей по накладной — видна сразу. */}
              {i.payments.length > 0 && (
                <div className="inv-history">
                  {i.payments.map((p: any) => (
                    <div key={p.id} className="inv-history__row">
                      <span>
                        {new Date(p.created_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                        {' · '}{Number(p.amount) < 0 ? 'вернули деньги' : 'оплата'} · {SOURCE_LABEL[p.source] ?? p.source}
                      </span>
                      <b>{Number(p.amount) < 0 ? '+' : '−'}{Math.abs(Number(p.amount)).toFixed(2)}</b>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        {data.returns.length > 0 && (
          <>
            <h3 className="sect">Возвраты товара</h3>
            <div className="list">
              {data.returns.map((r: any) => (
                <div key={r.id} className="list-item list-item--static journal-ret">
                  <div className="list-item__main">
                    <div className="list-item__name">{new Date(r.created_at).toLocaleDateString('ru-RU')} · на {Number(r.amount).toFixed(2)}</div>
                    <div className="muted">
                      {r.items.map((it: any) => `${it.name} × ${Number(it.qty)}`).join(', ') || 'без товара'}
                      {Number(r.refund_amount) > 0
                        ? ` · деньгами вернули ${Number(r.refund_amount).toFixed(2)} (${REFUND_LABEL[r.refund_source ?? ''] ?? r.refund_source})`
                        : ' · долг уменьшен'}
                      {r.note ? ` · ${r.note}` : ''}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="row">
          <button className="btn" onClick={onClose}>Закрыть</button>
        </div>
      </div>

      {addInv && (
        <AddInvoice
          supplierId={id}
          onClose={() => setAddInv(false)}
          onDone={() => { setAddInv(false); reload(); onChange(); onFlash('Накладная добавлена'); }}
        />
      )}
      {returnFor && (
        <ReturnInvoice
          invoice={returnFor}
          onClose={() => setReturnFor(null)}
          onDone={() => { setReturnFor(null); reload(); onChange(); onFlash('Возврат поставщику оформлен'); }}
        />
      )}
      {payFor && (
        <PayInvoice
          invoice={payFor}
          onClose={() => setPayFor(null)}
          onDone={() => { setPayFor(null); reload(); onChange(); onFlash('Платёж внесён'); }}
        />
      )}
      {editSup && (
        <EditSupplier
          supplier={data.supplier}
          onClose={() => setEditSup(false)}
          onDone={() => { setEditSup(false); reload(); onChange(); onFlash('Поставщик изменён'); }}
        />
      )}
    </div>
  );
}

// Правка справочных данных поставщика: имя и телефон. Долги/платежи не трогаем.
function EditSupplier({ supplier, onClose, onDone }: {
  supplier: { id: string; name: string; phone: string | null }; onClose: () => void; onDone: () => void;
}) {
  const [name, setName] = useState(supplier.name);
  const [phone, setPhone] = useState(supplier.phone ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!name.trim()) { setErr('Укажите имя'); return; }
    setBusy(true); setErr(null);
    try {
      await api.updateSupplier(supplier.id, { name: name.trim(), phone: phone.trim() });
      onDone();
    } catch (e: any) { setErr(e?.body?.error || e.message); } finally { setBusy(false); }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Изменить поставщика</h2>
        <label className="field"><span>Название / имя</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <label className="field"><span>Телефон</span>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="необязательно" />
        </label>
        {err && <div className="change change--neg">{err}</div>}
        <div className="row">
          <button className="btn" onClick={onClose} disabled={busy}>Отмена</button>
          <button className="btn btn--primary" onClick={save} disabled={busy}>Сохранить</button>
        </div>
      </div>
    </div>
  );
}

type PaySource = 'cash' | 'wallet' | 'hand' | 'external';

// Варианты «откуда деньги» для оплаты поставщику — с суммами, что там есть.
function payOptions(m: MoneyPlaces | null): SourceOption<PaySource>[] {
  return [
    { value: 'cash', title: 'Из кассы · нал', sub: tillSub(m, 'cash'), disabled: !!m && m.tillCash <= 0 },
    { value: 'wallet', title: 'Из кассы · безнал', sub: tillSub(m, 'wallet'), disabled: !!m && m.tillWallet <= 0 },
    { value: 'hand', title: 'С рук (подотчёт)', sub: m ? `у вас на руках ${money(m.onHand)}` : undefined, disabled: !!m && m.onHand <= 0 },
    { value: 'external', title: 'Со стороны', sub: 'личные деньги, банк — не из магазина' },
  ];
}

function payHint(source: PaySource | null): string | null {
  if (source === 'external') return 'Деньги не из магазина (банк/личные). Ни кассу, ни «на руках» не трогает — только гасит долг.';
  if (source === 'hand') return 'Платим из денег, ранее изъятых из кассы на руки. Кассу не трогает, уменьшает «на руках».';
  if (source === 'cash' || source === 'wallet') return 'Деньги уходят из кассового ящика — касса уменьшится. В прибыль как расход не идёт (товар уже в себестоимости).';
  return null;
}

function AddInvoice({ supplierId, onClose, onDone }: { supplierId: string; onClose: () => void; onDone: () => void }) {
  const [total, setTotal] = useState('');
  const [paid, setPaid] = useState('');
  const [note, setNote] = useState('');
  const [source, setSource] = useState<PaySource | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const places = useMoneyPlaces(true);

  const debt = (Number(total) || 0) - (Number(paid) || 0);
  const paidNow = (Number(paid) || 0) > 0;

  async function save() {
    const t = Number(total) || 0;
    const p = Number(paid) || 0;
    if (!(t > 0)) { setErr('Укажите сумму накладной'); return; }
    if (p > t) { setErr('Оплачено больше суммы накладной'); return; }
    if (p > 0 && !source) { setErr('Выберите, откуда деньги на оплату'); return; }
    setBusy(true); setErr(null);
    try {
      await api.addInvoice(supplierId, { total: t, paid: p, note: note.trim() || undefined, source: p > 0 ? source! : undefined });
      onDone();
    } catch (e: any) { setErr(e?.body?.error || e?.body?.message || e.message); } finally { setBusy(false); }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--scroll" onClick={(e) => e.stopPropagation()}>
        <h2>Новая накладная</h2>
        <div className="row">
          <label className="field"><span>Сумма накладной</span><NumberInput value={total} onValue={setTotal} autoFocus /></label>
          <label className="field"><span>Оплатили сейчас</span><NumberInput value={paid} onValue={setPaid} placeholder="0" /></label>
        </div>
        {paidNow && (
          <>
            <SourcePicker label="Откуда деньги на оплату" value={source} onChange={setSource} options={payOptions(places)} />
            {payHint(source) && <p className="hint">{payHint(source)}</p>}
          </>
        )}
        <label className="field"><span>Заметка</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="напр. Кола, вода — партия" />
        </label>
        {Number(total) > 0 && (
          <div className={`shift-diff ${debt > 0 ? 'shift-diff--neg' : ''}`}>
            Долг по накладной: <b>{debt.toFixed(2)}</b>
          </div>
        )}
        {err && <div className="change change--neg">{err}</div>}
        <div className="row">
          <button className="btn" onClick={onClose} disabled={busy}>Отмена</button>
          <button className="btn btn--primary" onClick={save} disabled={busy || (paidNow && !source)}>Сохранить</button>
        </div>
      </div>
    </div>
  );
}

function PayInvoice({ invoice, onClose, onDone }: { invoice: any; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  // Заранее ничего не выбрано — откуда деньги, нажимают сами.
  const [source, setSource] = useState<PaySource | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const places = useMoneyPlaces(true);
  const remaining = Number(invoice.remaining);

  async function save() {
    const a = Number(amount) || 0;
    if (!(a > 0)) { setErr('Укажите сумму'); return; }
    if (a > remaining) { setErr(`Осталось всего ${remaining.toFixed(2)}`); return; }
    if (!source) { setErr('Выберите, откуда деньги'); return; }
    setBusy(true); setErr(null);
    try {
      await api.payInvoice(invoice.id, { amount: a, note: note.trim() || undefined, source });
      onDone();
    } catch (e: any) { setErr(e?.body?.error || e?.body?.message || e.message); } finally { setBusy(false); }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--scroll" onClick={(e) => e.stopPropagation()}>
        <h2>Оплата поставщику</h2>
        <p className="muted">По накладной осталось: <b>{remaining.toFixed(2)}</b></p>

        <SourcePicker value={source} onChange={setSource} options={payOptions(places)} />
        {payHint(source) && <p className="hint">{payHint(source)}</p>}

        <div className="row">
          <button className="btn btn--ghost" onClick={() => setAmount(String(remaining))}>Погасить всё</button>
        </div>
        <label className="field"><span>Сколько платим</span><NumberInput value={amount} onValue={setAmount} autoFocus /></label>
        <label className="field"><span>Заметка</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="необязательно" />
        </label>
        {err && <div className="change change--neg">{err}</div>}
        <div className="row">
          <button className="btn" onClick={onClose} disabled={busy}>Отмена</button>
          <button className="btn btn--primary" onClick={save} disabled={busy || !source}>Внести платёж</button>
        </div>
      </div>
    </div>
  );
}

// Куда пришли деньги, когда поставщик возвращает уже оплаченное.
const REFUND_OPTIONS: SourceOption<PaySource>[] = [
  { value: 'cash', title: 'В кассу · нал', sub: 'наличные положили в ящик' },
  { value: 'wallet', title: 'В кассу · безнал', sub: 'пришло на кошелёк кассы' },
  { value: 'hand', title: 'Мне на руки', sub: 'деньги у вас, в подотчёт' },
  { value: 'external', title: 'Мимо кассы', sub: 'на карту/в банк, магазин не трогает' },
];

// Возврат товара поставщику: что вернули, на какую сумму он нам это засчитал,
// и — если часть уже оплачена — куда он вернул деньги. Накладная не правится:
// возврат записывается отдельно (долг = сумма − оплачено − возвращено).
function ReturnInvoice({ invoice, onClose, onDone }: { invoice: any; onClose: () => void; onDone: () => void }) {
  const products = useLiveQuery(() => db.products.orderBy('name').toArray(), [], [] as Product[]);
  const [q, setQ] = useState('');
  const [lines, setLines] = useState<{ product: Product; qty: string }[]>([]);
  const [amount, setAmount] = useState('');
  const [amountTouched, setAmountTouched] = useState(false);
  const [note, setNote] = useState('');
  const [source, setSource] = useState<PaySource | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const total = Number(invoice.total);
  const paid = Number(invoice.paid);
  const returned = Number(invoice.returned);
  const debt = Number(invoice.remaining);
  const maxReturn = total - returned;

  // Пока сумму не правили руками — предлагаем по нашей себестоимости.
  const suggested = Number(lines.reduce((s, l) => s + (Number(l.qty) || 0) * Number(l.product.cost_price), 0).toFixed(2));
  useEffect(() => { if (!amountTouched) setAmount(suggested > 0 ? String(suggested) : ''); }, [suggested, amountTouched]);

  const amt = Number(amount) || 0;
  const refund = Math.max(0, amt - debt);       // сколько денег вернёт поставщик
  const debtAfter = Math.max(0, debt - amt);

  const found = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return [];
    const used = new Set(lines.map((l) => l.product.id));
    return products.filter((p) => !used.has(p.id) && p.name.toLowerCase().includes(t)).slice(0, 6);
  }, [q, products, lines]);

  function setQty(id: string, qty: string) {
    setLines((ls) => ls.map((l) => (l.product.id === id ? { ...l, qty } : l)));
  }

  async function save() {
    if (!(amt > 0)) { setErr('Укажите, на какую сумму поставщик засчитывает возврат'); return; }
    if (amt > maxReturn + 1e-9) { setErr(`По накладной можно вернуть не больше ${maxReturn.toFixed(2)}`); return; }
    for (const l of lines) {
      const n = Number(l.qty) || 0;
      if (!(n > 0)) { setErr(`«${l.product.name}»: укажите количество`); return; }
      if (n > Number(l.product.stock)) { setErr(`«${l.product.name}»: на складе только ${Number(l.product.stock)}`); return; }
    }
    if (refund > 0 && !source) { setErr('Выберите, куда поставщик вернул деньги'); return; }
    setBusy(true); setErr(null);
    try {
      await api.returnToSupplier(invoice.id, {
        items: lines.map((l) => ({ product_id: l.product.id, qty: Number(l.qty) })),
        amount: amt,
        note: note.trim() || undefined,
        refund_source: refund > 0 ? source! : undefined,
      });
      onDone();
    } catch (e: any) { setErr(e?.body?.error || e?.body?.message || e.message); } finally { setBusy(false); }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--scroll" onClick={(e) => e.stopPropagation()}>
        <h2>Возврат товара поставщику</h2>
        <p className="muted">
          Накладная {total.toFixed(2)} · оплачено {paid.toFixed(2)}
          {returned > 0 ? ` · уже возвращено ${returned.toFixed(2)}` : ''} · долг сейчас <b>{debt.toFixed(2)}</b>
        </p>

        <label className="field"><span>Что возвращаем (поиск по названию)</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="начните вводить название…" autoFocus />
        </label>
        {found.length > 0 && (
          <div className="list">
            {found.map((p) => (
              <button key={p.id} className="list-item" onClick={() => {
                setLines((ls) => [...ls, { product: p, qty: String(Math.min(1, Number(p.stock)) || 1) }]);
                setQ('');
              }}>
                <div className="list-item__main"><div className="list-item__name">{p.name}</div></div>
                <div className="muted">на складе {Number(p.stock)}</div>
              </button>
            ))}
          </div>
        )}

        {lines.map((l) => (
          <div key={l.product.id} className="ret-line">
            <div className="ret-line__name">
              {l.product.name}
              <span className="muted"> · на складе {Number(l.product.stock)} · себест. {Number(l.product.cost_price)}</span>
            </div>
            <NumberInput value={l.qty} onValue={(v) => setQty(l.product.id, v)} />
            <button className="cart-line__del" onClick={() => setLines((ls) => ls.filter((x) => x.product.id !== l.product.id))} title="Убрать">×</button>
          </div>
        ))}
        {lines.length === 0 && (
          <p className="hint">Выберите товар, который отдаём назад. Он уйдёт со склада — не как потеря, а как возврат поставщику.</p>
        )}

        <label className="field">
          <span>На какую сумму поставщик засчитывает возврат</span>
          <NumberInput value={amount} onValue={(v) => { setAmountTouched(true); setAmount(v); }} />
        </label>
        {suggested > 0 && amountTouched && (
          <button className="btn btn--link" onClick={() => { setAmountTouched(false); }}>
            Подставить по себестоимости: {suggested.toFixed(2)}
          </button>
        )}

        {amt > 0 && (
          <div className="shift-diff">
            Долг: <b>{debt.toFixed(2)}</b> → <b>{debtAfter.toFixed(2)}</b>
            {refund > 0 && <> · поставщик вернёт вам деньги: <b>{refund.toFixed(2)}</b></>}
          </div>
        )}
        {refund > 0 && (
          <>
            <p className="hint">Эта часть накладной уже оплачена, поэтому поставщик возвращает деньги. Куда они пришли?</p>
            <SourcePicker label="Куда вернулись деньги" value={source} onChange={setSource} options={REFUND_OPTIONS} />
          </>
        )}

        <label className="field"><span>Заметка</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="напр. не продаётся, вернули через неделю" />
        </label>
        {err && <div className="change change--neg">{err}</div>}
        <div className="row">
          <button className="btn" onClick={onClose} disabled={busy}>Отмена</button>
          <button className="btn btn--primary" onClick={save} disabled={busy || !(amt > 0) || (refund > 0 && !source)}>Оформить возврат</button>
        </div>
      </div>
    </div>
  );
}
