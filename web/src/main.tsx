import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { initSync } from './sync';
import { applyForcedLayoutClass } from './useMedia';
import { initTheme } from './theme';
import './styles.css';

initTheme();
applyForcedLayoutClass();
initSync();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
