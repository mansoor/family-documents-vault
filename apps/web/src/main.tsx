import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { SharePage, takeLinkToken } from './screens/SharePage.js';
import './styles.css';

const root = createRoot(document.getElementById('root') as HTMLElement);

if (/^\/s\/?$/.test(window.location.pathname)) {
  // The page a share link opens (5.16), on its own: none of the family's
  // app around it — no sign-in, no session, no capability document, which
  // the public-only site does not even serve. Its token is read, and taken
  // out of the address, before anything is drawn.
  const token = takeLinkToken();
  root.render(
    <StrictMode>
      <SharePage token={token} />
    </StrictMode>,
  );
} else {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
