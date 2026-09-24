import { NavLink, Navigate, Route, Routes, useNavigate, useLocation } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { pullProducts, reconnectRealtime } from './sync';
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
import QueuePage, { QueueBadge } from './pages/QueuePage';
import BulkEntryPage from './pages/BulkEntryPage';
import CustomerDisplay from './pages/CustomerDisplay';
import OfflineBanner, { useOnline } from './components/OfflineBanner';

function OnlineBadge() {
  const online = useOnline();
  return (
    <span className={`badge ${online ? 'badge--ok' : 'badge--off'}`}>{online ? 'онлайн' : 'нет сети'}</span>
  );
}

function ThemeButton() {
  const { icon, label, cycle } = useThemeMode();
  return (
    <button className="theme-btn" onClick={cycle} title={`Тема: ${label} (нажмите, чтобы сменить)`}>
      {icon}
    </button>
  );
}

export default function App() {
  const user = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Экран покупателя — отдельное окно на втором мониторе. Без шапки, меню и
  // без входа: он только читает локальный чек и показывает его клиенту.
  if (location.pathname === '/customer') return <CustomerDisplay />;

  // После входа подтягиваем каталог, смену и переподключаем realtime
  // под новой ролью (сервер шлёт кассиру не то же, что владельцу).
  useEffect(() => {
    if (user) {
      pullProducts();
      refreshShift();
      reconnectRealtime();
    }
  }, [user?.id]);

  // Вход всегда открывает экран продажи — и владельцу, и кассиру.
  // Отслеживаем именно переход «не был залогинен → вошёл», иначе перезагрузка
  // страницы сбрасывала бы пользователя с того экрана, где он был.
  const prevUserId = useRef<string | null>(user?.id ?? null);
  useEffect(() => {
    const wasLoggedIn = prevUserId.current;
    prevUserId.current = user?.id ?? null;
    if (user && !wasLoggedIn) navigate('/sale', { replace: true });
  }, [user?.id]);

  if (!user) return <LoginPage />;

  const owner = user.role === 'owner';

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Kassa</div>
        <div className="topbar__right">
          <QueueBadge onOpen={() => navigate('/queue')} />
          <OnlineBadge />
          <ThemeButton />
          <button className="user-chip" onClick={logout} title="Выйти">
            {user.full_name || user.username} ⏻
          </button>
        </div>
        <OfflineBanner />
      </header>

      <main className="content">
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
          <Route path="/staff" element={owner ? <StaffPage /> : <Navigate to="/sale" replace />} />
          <Route path="*" element={<Navigate to="/sale" replace />} />
        </Routes>
      </main>

      <nav className="tabbar">
        {owner && (
          <NavLink to="/dashboard" className="tab">
            <span className="tab__icon">📊</span>
            <span>Кабинет</span>
          </NavLink>
        )}
        <NavLink to="/sale" className="tab">
          <span className="tab__icon">🧾</span>
          <span>Продажа</span>
        </NavLink>
        <NavLink to="/shift" className="tab">
          <span className="tab__icon">🕐</span>
          <span>Смена</span>
        </NavLink>
        <NavLink to="/receiving" className="tab">
          <span className="tab__icon">📦</span>
          <span>Приём</span>
        </NavLink>
        {owner && (
          <NavLink to="/products" className="tab">
            <span className="tab__icon">🏷️</span>
            <span>Товары</span>
          </NavLink>
        )}
        {owner && (
          <NavLink to="/bulk" className="tab">
            <span className="tab__icon">⚡</span>
            <span>Завод</span>
          </NavLink>
        )}
        {owner && (
          <NavLink to="/analytics" className="tab">
            <span className="tab__icon">📈</span>
            <span>Аналитика</span>
          </NavLink>
        )}
        {owner && (
          <NavLink to="/staff" className="tab">
            <span className="tab__icon">👥</span>
            <span>Сотрудники</span>
          </NavLink>
        )}
      </nav>
    </div>
  );
}
