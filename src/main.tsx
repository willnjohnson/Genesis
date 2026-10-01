import { Component, type ErrorInfo, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { FlagsProvider } from './components/FlagsProvider'
import { WorkspaceProvider } from './components/WorkspaceProvider'
import { WorkspaceGate } from './components/workspace/WorkspaceGate'
// image save handler for desktop builds
import { setupImageSaveHandler } from './lib/image-save';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { QuickAdd } from './components/QuickAdd'
import { TooltipLayer } from './components/TooltipLayer'
import { installExitListener } from './lib/exit-guard'

class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean, error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ color: 'white', padding: '20px' }}>
          <h1>Something went wrong.</h1>
          <pre>{this.state.error?.toString()}</pre>
          <pre>{this.state.error?.stack}</pre>
        </div>
      );
    }

    return this.props.children;
  }
}

// The tray icon's small quick-save popup is a second window on this same web app (see src-tauri/src/tray.rs); it
// shows the quick-save view instead of the app.
const isQuickAddWindow = (() => {
  try { return getCurrentWindow().label === 'quickadd'; } catch { return false; }
})();

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <TooltipLayer />
    {isQuickAddWindow ? (
      <QuickAdd />
    ) : (
      <FlagsProvider>
        <WorkspaceProvider>
          <WorkspaceGate>
            <App />
          </WorkspaceGate>
        </WorkspaceProvider>
      </FlagsProvider>
    )}
  </ErrorBoundary>
);

// Closing the app (the window, or the tray's Quit) asks the main window first, for an unsaved edit (lib/exit-guard.ts).
if (!isQuickAddWindow) {
  try { installExitListener(); } catch (e) { console.warn('exit listener init failed', e); }
}

// Register the image-save handler in the browser environment.
// This will be a no-op on web builds but active inside the Tauri desktop app.
if (typeof window !== 'undefined') {
  try { setupImageSaveHandler(); } catch (e) { console.warn('image save handler init failed', e); }
}


// The webview's own find-in-page (Ctrl+F, and F3 / Ctrl+G to step through it) would search the whole app,
// its menus and settings included. It's blocked everywhere: the only find is the Sidebar's, which searches
// nothing but the transcript or AI summary (see Sidebar.tsx). This only stops the browser's default; the
// Sidebar still sees the keypress.
window.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();
  if (((e.ctrlKey || e.metaKey) && !e.altKey && (key === 'f' || key === 'g')) || key === 'f3') e.preventDefault();
}, true);

// The webview's own right-click menu (Back, Refresh, Save as, Print, Inspect...) never shows, anywhere, text boxes
// included. Only stops the browser's default: the app's own menus (onContextMenu handlers) still open as before.
window.addEventListener('contextmenu', (e) => e.preventDefault());
