import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { holdAccountLinkToken, reopenOnNewLink, takeLinkToken } from './link-token.js';
import { SharePage } from './screens/SharePage.js';
import './styles.css';

const root = createRoot(document.getElementById('root') as HTMLElement);

// A link pasted into a tab already at its page changes only the fragment:
// the page starts again from it (5.17).
reopenOnNewLink();

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
  // An invitation's or a reset's link (5.17): its token, after the # or in
  // an old link's path, is read and taken out of the address before the
  // app, and its router, see it.
  holdAccountLinkToken();
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
