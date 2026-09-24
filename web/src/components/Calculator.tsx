import { useState } from 'react';

// Простой калькулятор — доп-опция для кассира, чтобы не держать отдельный.
// Обычные действия: + − × ÷ %, очистка, забой, точка, равно.
type Op = '+' | '-' | '×' | '÷';

export default function Calculator({ onClose }: { onClose: () => void }) {
  const [display, setDisplay] = useState('0');
  const [prev, setPrev] = useState<number | null>(null);
  const [op, setOp] = useState<Op | null>(null);
  const [fresh, setFresh] = useState(true); // следующая цифра начинает новое число

  function calc(a: number, b: number, o: Op): number {
    if (o === '+') return a + b;
    if (o === '-') return a - b;
    if (o === '×') return a * b;
    return b === 0 ? NaN : a / b;
  }

  // Красиво показываем результат: без «висячих» нулей, с ошибкой при делении на 0.
  function show(n: number): string {
    if (!Number.isFinite(n)) return 'Ошибка';
    return String(Number(n.toFixed(6)));
  }

  function inputDigit(d: string) {
    setDisplay((cur) => (fresh || cur === '0' ? d : cur + d));
    setFresh(false);
  }

  function inputDot() {
    if (fresh) {
      setDisplay('0.');
      setFresh(false);
      return;
    }
    setDisplay((cur) => (cur.includes('.') ? cur : cur + '.'));
  }

  function chooseOp(next: Op) {
    const cur = Number(display);
    if (prev !== null && op && !fresh) {
      const r = calc(prev, cur, op);
      setDisplay(show(r));
      setPrev(Number.isFinite(r) ? r : null);
    } else {
      setPrev(cur);
    }
    setOp(next);
    setFresh(true);
  }

  function equals() {
    if (prev === null || !op) return;
    const r = calc(prev, Number(display), op);
    setDisplay(show(r));
    setPrev(null);
    setOp(null);
    setFresh(true);
  }

  function clearAll() {
    setDisplay('0');
    setPrev(null);
    setOp(null);
    setFresh(true);
  }

  function backspace() {
    setDisplay((cur) => (cur.length <= 1 || (cur.length === 2 && cur.startsWith('-')) ? '0' : cur.slice(0, -1)));
  }

  function percent() {
    setDisplay((cur) => show(Number(cur) / 100));
    setFresh(true);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal calc" onClick={(e) => e.stopPropagation()}>
        <div className="calc__head">
          <h2>Калькулятор</h2>
          <button className="btn btn--link" onClick={onClose}>Закрыть</button>
        </div>

        <div className="calc__display">
          {op && prev !== null && <span className="calc__op">{show(prev)} {op}</span>}
          <div className="calc__value">{display}</div>
        </div>

        <div className="calc__grid">
          <button className="calc__btn calc__btn--fn" onClick={clearAll}>C</button>
          <button className="calc__btn calc__btn--fn" onClick={backspace}>⌫</button>
          <button className="calc__btn calc__btn--fn" onClick={percent}>%</button>
          <button className="calc__btn calc__btn--op" onClick={() => chooseOp('÷')}>÷</button>

          <button className="calc__btn" onClick={() => inputDigit('7')}>7</button>
          <button className="calc__btn" onClick={() => inputDigit('8')}>8</button>
          <button className="calc__btn" onClick={() => inputDigit('9')}>9</button>
          <button className="calc__btn calc__btn--op" onClick={() => chooseOp('×')}>×</button>

          <button className="calc__btn" onClick={() => inputDigit('4')}>4</button>
          <button className="calc__btn" onClick={() => inputDigit('5')}>5</button>
          <button className="calc__btn" onClick={() => inputDigit('6')}>6</button>
          <button className="calc__btn calc__btn--op" onClick={() => chooseOp('-')}>−</button>

          <button className="calc__btn" onClick={() => inputDigit('1')}>1</button>
          <button className="calc__btn" onClick={() => inputDigit('2')}>2</button>
          <button className="calc__btn" onClick={() => inputDigit('3')}>3</button>
          <button className="calc__btn calc__btn--op" onClick={() => chooseOp('+')}>+</button>

          <button className="calc__btn calc__btn--wide" onClick={() => inputDigit('0')}>0</button>
          <button className="calc__btn" onClick={inputDot}>.</button>
          <button className="calc__btn calc__btn--eq" onClick={equals}>=</button>
        </div>
      </div>
    </div>
  );
}
