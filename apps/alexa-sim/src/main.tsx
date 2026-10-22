import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { parseAutoplay } from './lib/autoplay.js';
import { SimController } from './lib/controller.js';
import './styles.css';

// One controller per page load (outside React so StrictMode does not double-connect).
const ctl = new SimController(parseAutoplay(window.location.search));
window.addEventListener('pagehide', () => ctl.dispose());

const root = document.getElementById('root');
if (root === null) throw new Error('#root missing');
createRoot(root).render(
  <StrictMode>
    <App ctl={ctl} />
  </StrictMode>,
);
