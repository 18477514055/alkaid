import React from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import { AuthBoundary } from './LocalAuth.tsx';
import './styles.css';

const container = document.getElementById('root');
if (container === null) throw new Error('找不到 #root');
createRoot(container).render(
  <React.StrictMode>
    <AuthBoundary><App /></AuthBoundary>
  </React.StrictMode>,
);
