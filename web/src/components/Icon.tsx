// Линейные SVG-иконки (вместо эмодзи): наследуют цвет текста (currentColor),
// тонкая обводка. Размер по умолчанию 1em, можно задать size. Один стиль на всё
// приложение — так интерфейс выглядит собранным и серьёзным.
import type { CSSProperties } from 'react';

export type IconName =
  | 'dashboard' | 'sale' | 'shift' | 'receiving' | 'products' | 'bulk'
  | 'analytics' | 'history' | 'debts' | 'expenses' | 'staff'
  | 'power' | 'eye' | 'cart' | 'wallet' | 'search' | 'printer' | 'calculator'
  | 'cash' | 'card' | 'mixed' | 'minus' | 'download' | 'upload' | 'tag'
  | 'bell' | 'return' | 'wait' | 'edit' | 'hand' | 'check' | 'report'
  | 'sun' | 'moon' | 'auto';

// Содержимое каждой иконки — пути в системе координат 24×24.
const PATHS: Record<IconName, JSX.Element> = {
  dashboard: <><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></>,
  sale: <><path d="M6 3h12v18l-2.3-1.4L13.4 21 12 19.8 10.6 21l-2.3-1.4L6 21V3z" /><path d="M9.5 7.5h5M9.5 11h5M9.5 14.5h3" /></>,
  shift: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  receiving: <><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" /><path d="M4 7.5l8 4.5 8-4.5M12 12v9" /></>,
  products: <><path d="M4 13l7-7a2 2 0 0 1 1.4-.6H18a2 2 0 0 1 2 2v5.6a2 2 0 0 1-.6 1.4l-7 7a2 2 0 0 1-2.8 0l-5.6-5.6a2 2 0 0 1 0-2.8z" /><circle cx="15.5" cy="8.5" r="1.3" /></>,
  bulk: <><path d="M13 2L4.5 13H11l-1 9 8.5-11H12l1-9z" /></>,
  analytics: <><path d="M4 20V4M20 20H4" /><path d="M8 17v-5M12 17V8M16 17v-7" /></>,
  history: <><path d="M4 5.5h16M4 12h16M4 18.5h10" /></>,
  debts: <><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H18a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7.5z" /><path d="M16 12.5h2.5" /><circle cx="16.5" cy="12.5" r="0.4" /></>,
  expenses: <><rect x="3" y="6" width="18" height="12" rx="2" /><circle cx="12" cy="12" r="2.3" /><path d="M9 15.5H7.5M16.5 8.5H15" /></>,
  staff: <><circle cx="9" cy="8" r="3" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0" /><path d="M16 5.5a3 3 0 0 1 0 5.8M17.5 19a5.5 5.5 0 0 0-2.3-4.5" /></>,
  power: <><path d="M12 4v8" /><path d="M7.5 7a7 7 0 1 0 9 0" /></>,
  eye: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.8" /></>,
  cart: <><path d="M3 4h2l2.2 11.2a1.5 1.5 0 0 0 1.5 1.3h8a1.5 1.5 0 0 0 1.5-1.2L20.5 8H6.2" /><circle cx="9.5" cy="20" r="1.2" /><circle cx="17.5" cy="20" r="1.2" /></>,
  wallet: <><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H18a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7.5z" /><path d="M16 12.5h2.5" /><circle cx="16.5" cy="12.5" r="0.4" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.3-4.3" /></>,
  printer: <><path d="M7 8V3.5h10V8" /><path d="M7 17.5H5a2 2 0 0 1-2-2V11a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4.5a2 2 0 0 1-2 2h-2" /><rect x="7" y="14.5" width="10" height="6" rx="1" /></>,
  calculator: <><rect x="4.5" y="2.5" width="15" height="19" rx="2.5" /><path d="M8 6.5h8" /><path d="M8 11h.01M12 11h.01M16 11h.01M8 14.5h.01M12 14.5h.01M16 14.5h.01M8 18h.01M12 18h.01M16 18h.01" /></>,
  cash: <><rect x="3" y="6" width="18" height="12" rx="2" /><circle cx="12" cy="12" r="2.4" /><path d="M6 9.5v5M18 9.5v5" /></>,
  card: <><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M3 10h18" /><path d="M6.5 14.5h3" /></>,
  mixed: <><rect x="3" y="7" width="12" height="9" rx="1.8" /><circle cx="9" cy="11.5" r="1.6" /><path d="M17 9.5h3a1 1 0 0 1 1 1V17a1 1 0 0 1-1 1h-8" /></>,
  minus: <><circle cx="12" cy="12" r="8.5" /><path d="M8 12h8" /></>,
  download: <><path d="M12 4v10" /><path d="M8 10.5l4 4 4-4" /><path d="M5 19.5h14" /></>,
  upload: <><path d="M12 14V4" /><path d="M8 7.5l4-4 4 4" /><path d="M5 19.5h14" /></>,
  tag: <><path d="M4 13l7-7a2 2 0 0 1 1.4-.6H18a2 2 0 0 1 2 2v5.6a2 2 0 0 1-.6 1.4l-7 7a2 2 0 0 1-2.8 0l-5.6-5.6a2 2 0 0 1 0-2.8z" /><circle cx="15.5" cy="8.5" r="1.3" /></>,
  bell: <><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6z" /><path d="M10 20a2 2 0 0 0 4 0" /></>,
  return: <><path d="M9 7l-4 4 4 4" /><path d="M5 11h9a5 5 0 0 1 0 10h-3" /></>,
  wait: <><circle cx="12" cy="12" r="8.5" /><path d="M12 8v4.2l2.6 1.8" /></>,
  edit: <><path d="M14.5 5.5l4 4" /><path d="M4 20l1-4L16 5a2 2 0 0 1 3 3L8 19l-4 1z" /></>,
  hand: <><path d="M8 11V5.5a1.5 1.5 0 0 1 3 0V10M11 10V4.5a1.5 1.5 0 0 1 3 0V10M14 10V6.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-.5a6 6 0 0 1-5-2.7L5 14a1.6 1.6 0 0 1 2.6-1.8L8 13" /></>,
  check: <><path d="M5 12.5l4.5 4.5L19 7" /></>,
  report: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 16v-4M12 16v-7M15 16v-2.5" /></>,
  sun: <><circle cx="12" cy="12" r="4.2" /><path d="M12 2.5v2.5M12 19v2.5M4.5 4.5l1.8 1.8M17.7 17.7l1.8 1.8M2.5 12H5M19 12h2.5M4.5 19.5l1.8-1.8M17.7 6.3l1.8-1.8" /></>,
  moon: <><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5z" /></>,
  auto: <><circle cx="12" cy="12" r="8.5" /><path d="M12 3.5v17" /><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none" /></>,
};

export default function Icon({ name, size, className, style }: {
  name: IconName;
  size?: number | string;
  className?: string;
  style?: CSSProperties;
}) {
  const s = size != null ? { width: size, height: size } : undefined;
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={`ic ${className ?? ''}`} style={{ ...s, ...style }}>
      {PATHS[name]}
    </svg>
  );
}
