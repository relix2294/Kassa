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

// Принудительная раскладка через адрес: ?layout=desktop | ?layout=mobile.
// Нужно, чтобы посмотреть экран кассы с телефона (и наоборот) — например,
// когда владелец хочет проверить рабочее место продавца, не будучи в магазине.
function forcedLayout(): 'desktop' | 'mobile' | null {
  const v = new URLSearchParams(location.search).get('layout');
  return v === 'desktop' || v === 'mobile' ? v : null;
}

// Хватает ли ширины для двухколоночной кассы.
export function useIsDesktop(): boolean {
  const byWidth = useMediaQuery(WIDE_QUERY);
  const forced = forcedLayout();
  return forced ? forced === 'desktop' : byWidth;
}

// Тот же признак для CSS: вешаем класс на <html>, чтобы медиазапросы
// можно было перебить при принудительном режиме.
export function applyForcedLayoutClass() {
  const forced = forcedLayout();
  if (!forced) return;
  document.documentElement.classList.add(`force-${forced}`);

  // На телефоне десктопная раскладка не помещается в 375px и обрезается.
  // Просим браузер рендерить страницу как широкую и уменьшить её — так
  // владелец видит рабочее место кассира целиком, с возможностью приблизить.
  if (forced === 'desktop') {
    const meta = document.querySelector('meta[name="viewport"]');
    if (meta) meta.setAttribute('content', 'width=1280, initial-scale=0.3, user-scalable=yes');
  }
}
