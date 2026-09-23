import { useEffect, useRef, useState } from 'react';

// Скан камерой телефона — для владельца, у которого под рукой нет сканера.
//
// Где браузер умеет читать штрихкоды сам (Chrome на Android), берём встроенный
// BarcodeDetector. Иначе (iPhone, ноутбук) — распознаватель ZXing на WebAssembly.
// Его файл лежит в самой кассе, а не на чужом CDN: загружается только при
// первом открытии камеры и дальше работает из кэша.
//
// Камера в браузере работает только по HTTPS (или на localhost).

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code'];

interface Detector {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
}

async function createDetector(): Promise<Detector> {
  const Native = (window as any).BarcodeDetector;
  if (Native) {
    try {
      const supported: string[] = await Native.getSupportedFormats();
      const formats = FORMATS.filter((f) => supported.includes(f));
      if (formats.includes('ean_13')) return new Native({ formats });
    } catch {
      // встроенный есть, но не рабочий — берём ZXing
    }
  }
  const [{ BarcodeDetector, prepareZXingModule }, { default: wasmUrl }] = await Promise.all([
    import('barcode-detector/ponyfill'),
    import('zxing-wasm/reader/zxing_reader.wasm?url'),
  ]);
  prepareZXingModule({
    overrides: {
      locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path),
    },
  });
  return new BarcodeDetector({ formats: FORMATS as any });
}

// Показывать ли кнопку камеры: только на сенсорных устройствах с камерой.
// На кассовом ноутбуке кнопка лишняя — там USB-сканер.
export function cameraAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    window.matchMedia('(pointer: coarse)').matches
  );
}

export default function CameraScanner({ onDetect, onClose }: { onDetect: (code: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: number | undefined;
    let alive = true;

    (async () => {
      if (!window.isSecureContext) {
        setError('Камера работает только по защищённому адресу (https). Откройте кассу по https-ссылке.');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
      } catch {
        setError('Нет доступа к камере. Разрешите камеру для этого сайта в настройках браузера.');
        return;
      }
      if (!alive) return stream.getTracks().forEach((t) => t.stop());
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play().catch(() => {});

      let detector: Detector;
      try {
        detector = await createDetector();
      } catch {
        setError('Не удалось запустить распознавание. Проверьте сеть и попробуйте ещё раз.');
        return;
      }
      if (!alive) return;
      setReady(true);

      // Несколько кадров в секунду достаточно и не сажают батарею.
      const tick = async () => {
        if (!alive) return;
        try {
          if (video.readyState >= 2) {
            const found = await detector.detect(video);
            const code = found.find((b) => b.rawValue)?.rawValue;
            if (code && alive) {
              alive = false;
              onDetect(code);
              return;
            }
          }
        } catch {
          // кадр не распознался — пробуем следующий
        }
        timer = window.setTimeout(tick, 200);
      };
      tick();
    })();

    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
    // onDetect намеренно не в зависимостях: камеру не перезапускаем на каждый рендер.
  }, []);

  return (
    <div className="modal-backdrop modal-backdrop--top" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Скан камерой</h2>
        {error ? (
          <div className="change change--neg">{error}</div>
        ) : (
          <>
            <div className="camera-box">
              <video ref={videoRef} playsInline muted />
              <div className="camera-box__frame" />
            </div>
            <p className="hint">{ready ? 'Наведите камеру на штрихкод.' : 'Включаем камеру…'}</p>
          </>
        )}
        <button className="btn" onClick={onClose}>
          Закрыть
        </button>
      </div>
    </div>
  );
}
