import React, { useState } from 'react';
import CameraScanner, { cameraAvailable } from './CameraScanner';
import { normalizeScan } from '../scan';

// Поле для штрихкода. Не числовое: в Code128 бывают буквы, а сканер в русской
// раскладке печатает их кириллицей — переводим на лету обратно в латиницу.
// На телефоне рядом кнопка камеры; отсканированный ею код уходит в onCamera.

interface Props extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'type'> {
  value: string;
  onValue: (v: string) => void;
  onCamera?: (code: string) => void;
}

const ScanInput = React.forwardRef<HTMLInputElement, Props>(function ScanInput(
  { value, onValue, onCamera, className, ...rest },
  ref,
) {
  const [camera, setCamera] = useState(false);
  const input = (
    <input
      {...rest}
      ref={ref}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      className={className}
      value={value}
      onChange={(e) => onValue(normalizeScan(e.target.value))}
    />
  );
  if (!onCamera || !cameraAvailable()) return input;

  return (
    <div className="scan-input">
      {input}
      <button type="button" className="btn scan-input__cam" onClick={() => setCamera(true)} title="Скан камерой">
        📷
      </button>
      {camera && (
        <CameraScanner
          onClose={() => setCamera(false)}
          onDetect={(code) => {
            setCamera(false);
            onCamera(normalizeScan(code));
          }}
        />
      )}
    </div>
  );
});

export default ScanInput;
