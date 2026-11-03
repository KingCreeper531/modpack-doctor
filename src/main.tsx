import '@fontsource/ibm-plex-sans-condensed/400.css';
import '@fontsource/ibm-plex-sans-condensed/500.css';
import '@fontsource/ibm-plex-sans-condensed/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './styles/tailwind.css';

import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './ui/app/App';

// `/design` exists only in dev builds; the import is tree-shaken from production.
const DesignSheet = import.meta.env.DEV ? lazy(() => import('./ui/design/DesignSheet')) : null;

const root = document.getElementById('root');
if (root) {
  const showDesign = DesignSheet !== null && window.location.pathname === '/design';
  createRoot(root).render(
    <StrictMode>
      {showDesign && DesignSheet ? (
        <Suspense fallback={null}>
          <DesignSheet />
        </Suspense>
      ) : (
        <App />
      )}
    </StrictMode>,
  );
}
