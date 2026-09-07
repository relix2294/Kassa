import { useEffect, useState } from 'react';

// Десктопная раскладка: касса на ноутбуке/ПК (п.3 ТЗ).
// Ниже порога — мобильная раскладка для телефона владельца.
const DESKTOP_QUERY = '(min-width: 900px)';

export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia(DESKTOP_QUERY).matches);

  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_QUERY);
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  return isDesktop;
}
