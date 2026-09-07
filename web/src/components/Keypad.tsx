// Цифровая клавиатура для ввода количества и сдачи (п.5 ТЗ).
export default function Keypad({
  value,
  onChange,
  allowDecimal = false,
}: {
  value: string;
  onChange: (v: string) => void;
  allowDecimal?: boolean;
}) {
  function press(key: string) {
    if (key === '⌫') {
      onChange(value.slice(0, -1));
      return;
    }
    if (key === '.') {
      if (!allowDecimal || value.includes('.')) return;
      onChange((value || '0') + '.');
      return;
    }
    // не даём ведущих нулей вида 00
    const next = value === '0' ? key : value + key;
    onChange(next);
  }

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', allowDecimal ? '.' : '', '0', '⌫'];

  return (
    <div className="keypad">
      {keys.map((k, i) =>
        k === '' ? (
          <div key={i} />
        ) : (
          <button key={i} type="button" className="keypad__key" onClick={() => press(k)}>
            {k}
          </button>
        ),
      )}
    </div>
  );
}
