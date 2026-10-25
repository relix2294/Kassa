import { NavLink, Navigate, Route, Routes, useNavigate, useLocation } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { onOnlineChange, isOnline, pullProducts, reconnectRealtime } from './sync';
import { api } from './api';
import { refreshShift } from './shift';
import { useAuth, logout } from './auth';
import { useThemeMode } from './theme';
import LoginPage from './pages/LoginPage';
import SalePage from './pages/SalePage';
import ReceivingPage from './pages/ReceivingPage';
import ProductsPage from './pages/ProductsPage';
import StaffPage from './pages/StaffPage';
import ShiftPage from './pages/ShiftPage';
import DashboardPage from './pages/DashboardPage';
import AnalyticsPage from './pages/AnalyticsPage';
import HistoryPage from './pages/HistoryPage';
import ReportsPage from './pages/ReportsPage';
import SuppliersPage from './pages/SuppliersPage';
import ExpensesPage from './pages/ExpensesPage';
import PriceTags from './pages/PriceTags';
import QueuePage, { QueueBadge } from './pages/QueuePage';
import BulkEntryPage from './pages/BulkEntryPage';
import CustomerDisplay from './pages/CustomerDisplay';
import Icon from './components/Icon';

function OnlineBadge() {
  const [online, setOnline] = useState(isOnline);
  useEffect(() => onOnlineChange(() => setOnline(isOnline)), []);
  return (
    <span className={`badge ${online ? 'badge--ok' : 'badge--off'}`}>{online ? 'онлайн' : 'нет сети'}</span>
  );
}

function ThemeButton() {
  const { mode, label, cycle } = useThemeMode();
  return (
    <button className="theme-btn" onClick={cycle} title={`Тема: ${label} (нажмите, чтобы сменить)`}>
      <Icon name={mode === 'auto' ? 'auto' : mode === 'light' ? 'sun' : 'moon'} />
    </button>
  );
}

export default function App() {
  const user = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Роль сервера: 'mirror' — это VPS-витрина (только просмотр аналитики,
  // данные приходят из магазина снимками). На кассе магазина роль 'store'.
  const [mirror, setMirror] = useState(false);
  useEffect(() => {
    api.health().then((h) => setMirror(h.role === 'mirror')).catch(() => {});
  }, []);

  // Вкладка «Смена» у кассира скрыта по умолчанию. Показать/скрыть её — 6 тапов
  // в правый нижний угол (секретная зона). Состояние живёт в памяти: при
  // перезагрузке и новом входе вкладка снова скрыта. У владельца всегда видна.
  const [shiftRevealed, setShiftRevealed] = useState(false);
  const [revealHint, setRevealHint] = useState<string | null>(null);
  const tapCount = useRef(0);
  const lastTap = useRef(0);
  function secretCornerTap() {
    const now = Date.now();
    // Сбрасываем счётчик, если тапы редкие (случайные нажатия не копятся).
    tapCount.current = now - lastTap.current > 1500 ? 1 : tapCount.current + 1;
    lastTap.current = now;
    if (tapCount.current >= 6) {
      tapCount.current = 0;
      setShiftRevealed((v) => {
        const nv = !v;
        setRevealHint(nv ? 'Вкладка «Смена» показана' : 'Вкладка «Смена» скрыта');
        window.setTimeout(() => setRevealHint(null), 2000);
        return nv;
      });
    }
  }

  // После входа подтягиваем каталог, смену и переподключаем realtime
  // под новой ролью (сервер шлёт кассиру не то же, что владельцу).
  useEffect(() => {
    if (user) {
      pullProducts();
      refreshShift();
      reconnectRealtime();
      setShiftRevealed(false); // новый вход — вкладка «Смена» снова скрыта
    }
  }, [user?.id]);

  // Вход всегда открывает экран продажи — и владельцу, и кассиру.
  // Отслеживаем именно переход «не был залогинен → вошёл», иначе перезагрузка
  // страницы сбрасывала бы пользователя с того экрана, где он был.
  const prevUserId = useRef<string | null>(user?.id ?? null);
  useEffect(() => {
    const wasLoggedIn = prevUserId.current;
    prevUserId.current = user?.id ?? null;
    if (user && !wasLoggedIn) navigate(mirror ? '/dashboard' : '/sale', { replace: true });
  }, [user?.id]);

  // Экран покупателя — отдельное окно на втором мониторе. Без шапки, меню и
  // без входа. Все хуки выше уже вызваны (правила хуков), поэтому ранний
  // возврат — только здесь, после них.
  if (location.pathname === '/customer') return <CustomerDisplay />;

  if (!user) return <LoginPage />;

  const owner = user.role === 'owner';

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Kassa{mirror ? ' · витрина' : ''}</div>
        <div className="topbar__right">
          {!mirror && <QueueBadge onOpen={() => navigate('/queue')} />}
          <OnlineBadge />
          <ThemeButton />
          <button className="user-chip" onClick={logout} title="Выйти">
            {user.full_name || user.username} <Icon name="power" />
          </button>
        </div>
      </header>

      <main className="content">
        {mirror && (
          <div className="mirror-banner">
            <Icon name="eye" /> Витрина руководителя — только просмотр. Данные приходят из магазина, обновляются каждые ~10 минут.
          </div>
        )}
        {mirror ? (
          // Зеркало: доступны только Кабинет и Аналитика, всё остальное сюда.
          <Routes>
            <Route path="/dashboard" element={owner ? <DashboardPage /> : <Navigate to="/dashboard" replace />} />
            <Route path="/analytics" element={owner ? <AnalyticsPage /> : <Navigate to="/dashboard" replace />} />
            <Route path="/history" element={owner ? <HistoryPage /> : <Navigate to="/dashboard" replace />} />
            <Route path="/reports" element={owner ? <ReportsPage /> : <Navigate to="/dashboard" replace />} />
            <Route path="/debts" element={owner ? <SuppliersPage /> : <Navigate to="/dashboard" replace />} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        ) : (
          <Routes>
            <Route path="/" element={<Navigate to="/sale" replace />} />
            <Route path="/dashboard" element={owner ? <DashboardPage /> : <Navigate to="/sale" replace />} />
            <Route path="/sale" element={<SalePage />} />
            <Route path="/shift" element={<ShiftPage />} />
            <Route path="/queue" element={<QueuePage />} />
            <Route path="/receiving" element={<ReceivingPage />} />
            <Route path="/products" element={owner ? <ProductsPage /> : <Navigate to="/sale" replace />} />
            <Route path="/bulk" element={owner ? <BulkEntryPage /> : <Navigate to="/sale" replace />} />
            <Route path="/analytics" element={owner ? <AnalyticsPage /> : <Navigate to="/sale" replace />} />
            <Route path="/history" element={owner ? <HistoryPage /> : <Navigate to="/sale" replace />} />
            <Route path="/reports" element={owner ? <ReportsPage /> : <Navigate to="/sale" replace />} />
            <Route path="/debts" element={owner ? <SuppliersPage /> : <Navigate to="/sale" replace />} />
            <Route path="/expenses" element={owner ? <ExpensesPage /> : <Navigate to="/sale" replace />} />
            <Route path="/tags" element={owner ? <PriceTags /> : <Navigate to="/sale" replace />} />
            <Route path="/staff" element={owner ? <StaffPage /> : <Navigate to="/sale" replace />} />
            <Route path="*" element={<Navigate to="/sale" replace />} />
          </Routes>
        )}
      </main>

      <nav className="tabbar">
        {owner && (
          <NavLink to="/dashboard" className="tab">
            <span className="tab__icon"><Icon name="dashboard" /></span>
            <span>Кабинет</span>
          </NavLink>
        )}
        {!mirror && (
          <NavLink to="/sale" className="tab">
            <span className="tab__icon"><Icon name="sale" /></span>
            <span>Продажа</span>
          </NavLink>
        )}
        {!mirror && (owner || shiftRevealed) && (
          <NavLink to="/shift" className="tab">
            <span className="tab__icon"><Icon name="shift" /></span>
            <span>Смена</span>
          </NavLink>
        )}
        {!mirror && (
          <NavLink to="/receiving" className="tab">
            <span className="tab__icon"><Icon name="receiving" /></span>
            <span>Приём</span>
          </NavLink>
        )}
        {owner && !mirror && (
          <NavLink to="/products" className="tab">
            <span className="tab__icon"><Icon name="products" /></span>
            <span>Товары</span>
          </NavLink>
        )}
        {owner && !mirror && (
          <NavLink to="/bulk" className="tab">
            <span className="tab__icon"><Icon name="bulk" /></span>
            <span>Завод</span>
          </NavLink>
        )}
        {owner && (
          <NavLink to="/analytics" className="tab">
            <span className="tab__icon"><Icon name="analytics" /></span>
            <span>Аналитика</span>
          </NavLink>
        )}
        {owner && (
          <NavLink to="/history" className="tab">
            <span className="tab__icon"><Icon name="history" /></span>
            <span>Чеки</span>
          </NavLink>
        )}
        {owner && (
          <NavLink to="/reports" className="tab">
            <span className="tab__icon"><Icon name="report" /></span>
            <span>Отчёты</span>
          </NavLink>
        )}
        {owner && (
          <NavLink to="/debts" className="tab">
            <span className="tab__icon"><Icon name="debts" /></span>
            <span>Долги</span>
          </NavLink>
        )}
        {owner && (
          <NavLink to="/expenses" className="tab">
            <span className="tab__icon"><Icon name="expenses" /></span>
            <span>Расходы</span>
          </NavLink>
        )}
        {owner && !mirror && (
          <NavLink to="/staff" className="tab">
            <span className="tab__icon"><Icon name="staff" /></span>
            <span>Сотрудники</span>
          </NavLink>
        )}
      </nav>

      {/* Секретная зона для кассира: 6 тапов в правый нижний угол показывают/
          прячут вкладку «Смена». Невидима, у владельца и на витрине не нужна. */}
      {!owner && !mirror && (
        <button aria-hidden className="corner-tap" tabIndex={-1} onClick={secretCornerTap} />
      )}
      {revealHint && <div className="toast">{revealHint}</div>}
    </div>
  );
}
