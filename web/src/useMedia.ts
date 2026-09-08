import { useEffect, useState } from 'react';

// Пороги раскладки. Два разных, потому что боковое меню помещается
// намного раньше, чем две колонки на экране продажи.
//  768px  — боковое меню вместо нижних вкладок (планшет, неразвёрнутое окно);
//  1000px — продажа в две колонки: чек + постоянная панель оплаты.
const WIDE_QUERY = '(min-width: 1000px)';

function useMediaQuery(q: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    setMatches(mq.matches); // на случай смены запроса
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [q]);
  return matches;
}

// Хватает ли ширины для двухколоночной кассы.
export function useIsDesktop(): boolean {
  return useMediaQuery(WIDE_QUERY);
}
