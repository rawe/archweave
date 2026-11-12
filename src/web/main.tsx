import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/ibm-plex-sans';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@xyflow/react/dist/base.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/chrome.css';
import './styles/canvas.css';
import './styles/inspector.css';
import './styles/data.css';
import './styles/flows.css';
import './styles/code.css';
import { App } from './App.tsx';
import { bootstrap } from './state/bootstrap.ts';
import './lib/theme.ts';

bootstrap();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
