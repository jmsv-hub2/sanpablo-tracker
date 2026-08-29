import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import ReadinessTab from './ReadinessTab.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <ReadinessTab />
    </div>
  </StrictMode>
);
