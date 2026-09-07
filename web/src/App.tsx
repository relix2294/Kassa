import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { onOnlineChange, isOnline } from './sync';
import ReceivingPage from './pages/ReceivingPage';
import ProductsPage from './pages/ProductsPage';

function OnlineBadge() {
  const [online, setOnline] = useState(isOnline);
  useEffect(() => onOnlineChange(() => setOnline(isOnline)), []);
  return (
    <span className={`badge ${online ? 'badge--ok' : 'badge--off'}`}>
      {online ? 'онлайн' : 'нет сети'}
    </span>
  );
}

export default function App() {
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Kassa</div>
        <OnlineBadge />
      </header>

      <main className="content">
        <Routes>
          <Route path="/" element={<Navigate to="/receiving" replace />} />
          <Route path="/receiving" element={<ReceivingPage />} />
          <Route path="/products" element={<ProductsPage />} />
          <Route path="*" element={<Navigate to="/receiving" replace />} />
        </Routes>
      </main>

      <nav className="tabbar">
        <NavLink to="/receiving" className="tab">
          <span className="tab__icon">📦</span>
          <span>Приём</span>
        </NavLink>
        <NavLink to="/products" className="tab">
          <span className="tab__icon">🏷️</span>
          <span>Товары</span>
        </NavLink>
      </nav>
    </div>
  );
}
