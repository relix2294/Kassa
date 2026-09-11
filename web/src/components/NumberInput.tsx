import React from 'react';

// Числовое поле, которое физически не даёт ввести буквы, минус и лишние точки.
// inputMode="decimal" — это лишь подсказка мобильной клавиатуре; на ноутбуке
// без фильтрации в поле цены можно набрать буквы, и товар потом не сохранить.
//
// mode:
//   'int'      — только целые цифры (штрихкод, целое количество штук);
//   'decimal'  — неотрицательное число с одной точкой (цены, вес).

type Mode = 'int' | 'decimal';

function sanitize(raw: string, mode: Mode, allowNegative: boolean): string {
  // Запятую с цифровой клавиатуры принимаем как точку.
  let v = raw.replace(/,/g, '.');
  // Минус разрешён только там, где он осмыслен (напр. −5% в смене цен),
  // и только в начале строки.
  let sign = '';
  if (allowNegative && v.trim().startsWith('-')) sign = '-';
  if (mode === 'int') return sign + v.replace(/[^\d]/g, '');
  v = v.replace(/[^\d.]/g, '');
  const i = v.indexOf('.');
  if (i !== -1) v = v.slice(0, i + 1) + v.slice(i + 1).replace(/\./g, '');
  return sign + v;
}

interface Props extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'type'> {
  value: string;
  onValue: (v: string) => void;
  mode?: Mode;
  allowNegative?: boolean;
}

const NumberInput = React.forwardRef<HTMLInputElement, Props>(function NumberInput(
  { value, onValue, mode = 'decimal', allowNegative = false, ...rest },
  ref,
) {
  return (
    <input
      {...rest}
      ref={ref}
      type="text"
      inputMode={mode === 'int' ? 'numeric' : 'decimal'}
      value={value}
      onChange={(e) => onValue(sanitize(e.target.value, mode, allowNegative))}
      onKeyDown={(e) => {
        // e/E/+ никогда не нужны; минус блокируем, если он не разрешён.
        const forbidden = ['e', 'E', '+'];
        if (!allowNegative) forbidden.push('-');
        if (forbidden.includes(e.key)) e.preventDefault();
        rest.onKeyDown?.(e);
      }}
    />
  );
});

export default NumberInput;
