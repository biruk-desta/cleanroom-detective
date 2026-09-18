import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Home from '../app/page';
import { LargeWorkspace } from '../components/cleanroom/large-workspace';
declare const __CLEANROOM_SERVER__: boolean;
// Browser storage work is paused at the owner's request.
const App = __CLEANROOM_SERVER__ ? LargeWorkspace : Home;
import '../app/globals.css';
import './standalone.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
