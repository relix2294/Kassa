import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type CartLine } from '../db';
import type { Product } from '../types';
import { addToCart, cartTotal, clearCart, removeLine, setQty, formatQty, lineTotal, lineHasDiscount } from '../cart';
import { completeSale } from '../sync';
import { useCurrentUser } from '../session';
import { useShift, refreshShift, openShift } from '../shift';
import { useIsDesktop } from '../useMedia';
import Keypad from '../components/Keypad';
import PaymentForm from '../components/PaymentForm';
import ReturnPanel from './ReturnPanel';
import ProductPicker from '../components/ProductPicker';
import Confirm from '../components/Confirm';
import { postCustomer } from '../customer';

export default function SalePage() {
  const user = useCurrentUser();
  const navigate = useNavigate();
  const isDesktop = useIsDesktop();
  const { shift, loaded } = useShift();
  const [barcode, setBarcode] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [payOpen, setPayOpen] = useState(false);
  const [qtyEdit, setQtyEdit] = useState<CartLine | null>(null);
  const [returnOpen, setReturnOpen] = useState(false);
  const [changeDue, setChangeDue] = useState<number | null>(null);
  const [askClear, setAskClear] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [weighing, setWeighing] = useState<Product | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);

  const lines = useLiveQuery(() => db.cart.toArray(), [], [] as CartLine[]);
  const products = useLiveQuery(() => db.products.orderBy('name').toArray(), [], [] as Product[]);
  const total = cartTotal(lines);

  // В верхней строке можно и сканировать, и искать по названию. Отличаем по
  // содержимому: буквы → это поиск (штрихкоды всегда цифровые). Так живые
  // подсказки не мигают, пока сканер быстро «печатает» цифры кода.
  const queryText = barcode.trim();
  const isSearch = /\D/.test(queryText);
  const suggests = isSearch
    ? products
        .filter(
          (p) =>
            p.name.toLowerCase().includes(queryText.toLowerCase()) ||
            (p.category ?? '').toLowerCase().includes(queryText.toLowerCase()),
        )
        .slice(0, 8)
    : [];

  // Сколько этого товара уже в чеке (для контроля остатка при добавлении).
  function inCart(p: Product): number {
    const key = p.barcode || p.id;
    return lines.find((l) => l.key === key)?.qty ?? 0;
  }

  // Не даём набрать в чек больше, чем есть на складе: иначе кассир соберёт
  // чек, а на оплате получит отказ. Предупреждаем сразу.
  function withinStock(p: Product, addQty: number): boolean {
    if (inCart(p) + addQty > Number(p.stock) + 1e-9) {
      const unit = p.unit === 'kg' ? ' кг' : ' шт';
      const have = inCart(p);
      flash(`«${p.name}»: на складе ${Number(p.stock)}${unit}${have ? `, в чеке уже ${have}` : ''}`);
      return false;
    }
    return true;
  }

  // Выбор товара из подсказки/поиска: весовой спрашивает вес, штучный — сразу в чек.
  async function pickProduct(p: Product) {
    setBarcode('');
    if (p.unit === 'kg') {
      setWeighing(p);
      return;
    }
    if (withinStock(p, 1)) await addToCart(p, 1);
    scanRef.current?.focus();
  }

  useEffect(() => {
    refreshShift();
  }, []);

  // Фокус всегда в поле скана — сканер печатает «вслепую».
  useEffect(() => {
    if (shift && !payOpen && !qtyEdit && !returnOpen && !pickerOpen && !weighing) scanRef.current?.focus();
  }, [payOpen, qtyEdit, returnOpen, pickerOpen, weighing, lines.length, shift]);

  // Горячие клавиши кассы (десктоп): F2 — оплата, Esc — закрыть/очистить.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'F2' && lines.length > 0 && !payOpen && !returnOpen && !qtyEdit) {
        e.preventDefault();
        setPayOpen(true);
      }
      if (e.key === 'Escape') {
        if (qtyEdit) setQtyEdit(null);
        else if (returnOpen) setReturnOpen(false);
        else if (payOpen) setPayOpen(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lines.length, payOpen, returnOpen, qtyEdit]);

  function flash(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }

  // Открыть экран покупателя во втором окне — кассир перетащит его на второй
  // монитор терминала и развернёт на весь экран.
  function openCustomer() {
    window.open('/customer', 'kassaCustomer', 'width=1200,height=800');
  }

  async function onScan(code: string) {
    const bc = code.trim();
    setBarcode('');
    if (!bc) return;
    const product = await db.products.where('barcode').equals(bc).first();
    if (!product) {
      flash('Товара нет в базе — сначала приём');
      return;
    }
    // Весовой товар со штрихкодом (редко, но бывает) — спросим вес.
    if (product.unit === 'kg') {
      setWeighing(product);
      return;
    }
    if (withinStock(product, 1)) await addToCart(product);
  }

  // Ввод в верхней строке: буквы → выбираем первую подсказку; цифры → скан.
  function onEnter() {
    if (isSearch) {
      if (suggests.length > 0) pickProduct(suggests[0]);
    } else {
      onScan(barcode);
    }
  }

  // Липкий фокус: если кассир кликнул по пустому месту, возвращаем курсор
  // в поле скана, чтобы следующий скан не «ушёл в никуда». Кнопки/поля не трогаем.
  function stickyRefocus() {
    setTimeout(() => {
      if (payOpen || qtyEdit || returnOpen || pickerOpen || weighing) return;
      if (document.activeElement === document.body) scanRef.current?.focus();
    }, 60);
  }

  async function pay(method: 'cash' | 'card' | 'mixed', received?: number, cardAmount?: number) {
    // Сдача считается от наличной части: для смешанной это total минус карта.
    const cashDue = method === 'mixed' ? total - (cardAmount ?? 0) : method === 'cash' ? total : 0;
    const due = received != null && cashDue > 0 ? Number((received - cashDue).toFixed(2)) : 0;
    try {
      const items = lines.map((l) => ({ product_id: l.product_id, qty: l.qty, expected_price: l.unit_price }));
      const r = await completeSale(items, method, received, shift?.id, cardAmount);
      await clearCart();
      setPayOpen(false);
      // Показываем покупателю на втором экране «спасибо» и сдачу.
      postCustomer({ type: 'paid', change: due > 0 ? due : 0 });
      // Сдачу показываем крупно и держим на экране, пока кассир её отсчитывает.
      if (due > 0) setChangeDue(due);
      else flash(r.queued ? 'Нет сети — чек в очереди' : 'Оплачено ✓');
    } catch (e: any) {
      flash(`Ошибка: ${e.message}`);
    }
  }

  // Без открытой смены продавать нельзя (п.4 ТЗ — иначе не с чем сверять кассу).
  // Но и гонять кассира на другой экран незачем: открываем смену прямо здесь.
  if (loaded && !shift) {
    return <StartShift onDone={flash} />;
  }

  const cart = (
    <div className="cart">
      {lines.length === 0 && <p className="hint">Отсканируйте товар, чтобы начать чек.</p>}
      {lines.map((l) => (
        <div key={l.key} className="cart-line">
          <div className="cart-line__main">
            <div className="cart-line__name">
              {l.name}
              {lineHasDiscount(l) && <span className="badge badge--sale">скидка</span>}
            </div>
            <div className="muted">
              {lineHasDiscount(l) ? (
                <>
                  <s>{l.unit_price}</s> {l.discount_price}
                  {l.unit === 'kg' ? ' /кг' : ''} × {formatQty(l)} = <b>{lineTotal(l)}</b>
                </>
              ) : (
                <>
                  {l.unit_price}
                  {l.unit === 'kg' ? ' /кг' : ''} × {formatQty(l)} = <b>{lineTotal(l)}</b>
                </>
              )}
            </div>
          </div>
          <div className="qty-ctrl">
            {/* Весовой товар меняем шагом 100 г, штучный — по одной штуке. */}
            <button className="qty-btn" onClick={() => setQty(l.key, l.qty - (l.unit === 'kg' ? 0.1 : 1))}>
              −
            </button>
            <button className="qty-num" onClick={() => setQtyEdit(l)}>
              {l.qty}
            </button>
            <button className="qty-btn" onClick={() => setQty(l.key, l.qty + (l.unit === 'kg' ? 0.1 : 1))}>
              +
            </button>
          </div>
          <button className="cart-line__del" onClick={() => removeLine(l.key)} title="Отменить позицию">
            ×
          </button>
        </div>
      ))}
    </div>
  );

  const scanForm = (
    <>
    <div className="scan-wrap">
      <form
        className="scan-row"
        onSubmit={(e) => {
          e.preventDefault();
          onEnter();
        }}
      >
        {/* Одно поле на скан и на поиск: цифры — штрихкод, буквы — поиск по
            названию. type=text, чтобы можно было ввести название. */}
        <input
          ref={scanRef}
          type="text"
          autoFocus
          autoComplete="off"
          placeholder="Скан штрихкода или название товара…"
          value={barcode}
          onChange={(e) => setBarcode(e.target.value)}
          onBlur={stickyRefocus}
        />
      </form>

      {/* Живые подсказки при вводе названия. */}
      {suggests.length > 0 && (
        <div className="scan-suggest">
          {suggests.map((p) => (
            <button key={p.id} className="scan-suggest__item" onClick={() => pickProduct(p)}>
              <span className="scan-suggest__name">
                {p.name}
                {!p.barcode && <span className="muted"> · без штрихкода</span>}
              </span>
              <span className="muted">
                {p.sale_price}{p.unit === 'kg' ? ' /кг' : ''} · ост. {Number(p.stock)}{p.unit === 'kg' ? ' кг' : ' шт'}
              </span>
            </button>
          ))}
        </div>
      )}
      {isSearch && suggests.length === 0 && <div className="scan-suggest scan-suggest--empty">Ничего не нашлось</div>}
    </div>

    {/* Большой поиск товара (весовой, выпечка, выбор из списка) — как было. */}
    <button className="btn btn--ghost btn--pick" onClick={() => setPickerOpen(true)}>
      🔎 Найти товар по названию
    </button>
    </>
  );

  return (
    <div className={`page ${isDesktop ? 'page--sale-desk' : 'page--sale'}`}>
      {isDesktop ? (
        // Десктоп кассы: слева чек, справа постоянная панель оплаты.
        <>
          <div className="sale-main">
            <div className="sale-head">
              <h1>Продажа</h1>
              <div className="head-actions">
                <button className="btn btn--ghost" onClick={openCustomer} title="Открыть экран для покупателя">
                  Экран клиента
                </button>
                <button className="btn btn--ghost" onClick={() => setReturnOpen(true)}>
                  Возврат
                </button>
              </div>
            </div>
            {scanForm}
            {cart}
            {lines.length > 0 && (
              <button className="btn btn--clear" onClick={() => setAskClear(true)}>
                Очистить чек
              </button>
            )}
          </div>

          <aside className="sale-side">
            <PaymentForm total={total} disabled={lines.length === 0} onPay={pay} />
            <div className="hotkeys">
              <span>
                <kbd>F2</kbd> оплата
              </span>
              <span>
                <kbd>Esc</kbd> закрыть
              </span>
            </div>
          </aside>
        </>
      ) : (
        // Телефон: чек на весь экран, оплата — модалкой.
        <>
          <div className="sale-head">
            <h1>Продажа</h1>
            <div className="head-actions">
              <button className="btn btn--ghost" onClick={openCustomer} title="Открыть экран для покупателя">
                Экран клиента
              </button>
              <button className="btn btn--ghost" onClick={() => setReturnOpen(true)}>
                Возврат
              </button>
            </div>
          </div>
          {scanForm}
          {cart}
          {lines.length > 0 && (
            <div className="sale-footer">
              <button className="btn" onClick={() => setAskClear(true)}>
                Очистить
              </button>
              <button className="btn btn--primary btn--pay" onClick={() => setPayOpen(true)}>
                Оплатить {total}
              </button>
            </div>
          )}
        </>
      )}

      {qtyEdit && (
        <QtyModal
          line={qtyEdit}
          onClose={() => setQtyEdit(null)}
          onSave={(q) => {
            setQty(qtyEdit.key, q);
            setQtyEdit(null);
          }}
        />
      )}

      {payOpen && !isDesktop && (
        <div className="modal-backdrop" onClick={() => setPayOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <PaymentForm total={total} onPay={pay} onCancel={() => setPayOpen(false)} />
          </div>
        </div>
      )}

      {pickerOpen && (
        <ProductPicker
          onClose={() => setPickerOpen(false)}
          onPick={async (product, qty) => {
            if (withinStock(product, qty)) await addToCart(product, qty);
            setPickerOpen(false);
          }}
        />
      )}

      {weighing && (
        <WeightModal
          product={weighing}
          onClose={() => setWeighing(null)}
          onAdd={async (kg) => {
            if (withinStock(weighing, kg)) await addToCart(weighing, kg);
            setWeighing(null);
            scanRef.current?.focus();
          }}
        />
      )}

      {returnOpen && <ReturnPanel onClose={() => setReturnOpen(false)} onDone={(m) => flash(m)} />}

      {/* Сдача во весь экран: кассир отсчитывает деньги, глядя на цифру. */}
      {changeDue !== null && (
        <div className="change-screen" onClick={() => setChangeDue(null)}>
          <div className="change-screen__label">Сдача покупателю</div>
          <div className="change-screen__sum">{changeDue.toFixed(2)}</div>
          <button className="btn btn--primary btn--big change-screen__btn">Отдал, дальше</button>
        </div>
      )}

      {askClear && (
        <Confirm
          title="Очистить чек?"
          text={`${lines.length} поз. на сумму ${total}. Действие попадёт в журнал.`}
          confirmLabel="Очистить"
          danger
          onConfirm={async () => {
            setAskClear(false);
            await clearCart(true); // с записью в журнал
          }}
          onCancel={() => setAskClear(false)}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

// Начало работы: размен вводится прямо на экране продажи, без перехода на «Смену».
// Размен нужен для сверки кассы в конце дня (п.4 ТЗ) — без него непонятно,
// сколько денег должно остаться.
function StartShift({ onDone }: { onDone: (msg: string) => void }) {
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function start(opening: number) {
    setBusy(true);
    setErr(null);
    try {
      await openShift(opening);
      onDone('Смена открыта — можно продавать');
    } catch (e: any) {
      setErr(e.message || 'Не удалось открыть смену');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <h1>Начало работы</h1>
      <div className="card start-shift">
        <p className="hint">
          Пересчитайте деньги в кассе и введите сумму. В конце дня система сверит,
          сколько должно остаться.
        </p>

        <label className="field">
          <span>Размен в кассе</span>
          <div className="keypad-value">{amount || '0'}</div>
        </label>

        <Keypad value={amount} onChange={setAmount} allowDecimal />

        {err && <div className="change change--neg">{err}</div>}

        <button className="btn btn--primary btn--big" disabled={busy} onClick={() => start(Number(amount) || 0)}>
          Начать работу
        </button>
        <button className="btn btn--link" disabled={busy} onClick={() => start(0)}>
          Размена нет, начать с нуля
        </button>
      </div>
    </div>
  );
}

// Ввод веса для весового товара, выбранного поиском/сканом.
function WeightModal({ product, onClose, onAdd }: { product: Product; onClose: () => void; onAdd: (kg: number) => void }) {
  const [val, setVal] = useState('');
  const kg = Number(val) || 0;
  const sum = Number((kg * Number(product.sale_price)).toFixed(2));
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{product.name}</h2>
        <div className="muted">{product.sale_price} за кг · на складе {Number(product.stock)} кг</div>
        <div className="field">
          <span>Вес, кг</span>
          <div className="keypad-value">{val || '0'}</div>
        </div>
        <Keypad value={val} onChange={setVal} allowDecimal />
        <div className="change-box change-box--ok">
          <div className="change-box__label">Сумма</div>
          <div className="change-box__sum">{sum.toFixed(2)}</div>
        </div>
        <div className="row">
          <button className="btn" onClick={onClose}>Отмена</button>
          <button className="btn btn--primary" disabled={!(kg > 0)} onClick={() => onAdd(kg)}>
            В чек
          </button>
        </div>
      </div>
    </div>
  );
}

function QtyModal({ line, onClose, onSave }: { line: CartLine; onClose: () => void; onSave: (q: number) => void }) {
  const [val, setVal] = useState(String(line.qty));
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{line.name}</h2>
        <div className="keypad-value">{val || '0'}</div>
        <Keypad value={val} onChange={setVal} allowDecimal />
        <div className="row">
          <button className="btn" onClick={onClose}>
            Отмена
          </button>
          <button className="btn btn--primary" onClick={() => onSave(Number(val) || 0)}>
            ОК
          </button>
        </div>
      </div>
    </div>
  );
}
