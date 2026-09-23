import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { AppProvider, useApp } from './app-context.js';
import { AddScreen, ConfirmScreen } from './screens/AddConfirm.js';
import { DocumentScreen } from './screens/Document.js';
import { SignInScreen, WelcomeScreen } from './screens/Entry.js';
import { HomeScreen } from './screens/Home.js';
import { JoinScreen } from './screens/Join.js';
import { NotificationsScreen } from './screens/Notifications.js';
import {
  PeopleScreen,
  PersonScreen,
  RemindersScreen,
  SearchScreen,
} from './screens/SearchPeople.js';
import { SettingsScreen, StorageScreen } from './screens/Settings.js';
import { SetupScreen } from './screens/Setup.js';
import { Logo } from './ui.js';

/**
 * Routing rules:
 *  - not connected            → the connection card
 *  - setup required           → /setup only
 *  - signed out               → /welcome, /sign-in
 *  - signed in                → everything else
 */
function Gate({ children, need }: { children: ReactNode; need: 'signed-in' | 'signed-out' }) {
  const { caps, session, connectionError } = useApp();
  // authVersion is read by useApp consumers; Gate re-renders through the provider.
  if (connectionError) {
    return (
      <main className="page">
        <Logo />
        <h1 style={{ fontSize: 32 }}>Family Document Vault</h1>
        <section className="card">
          <span className="status status-danger">Not connected</span>
          <p className="muted">{connectionError}</p>
        </section>
      </main>
    );
  }
  if (!caps) {
    return (
      <main className="page">
        <Logo />
        <span className="status status-warn">Connecting to the vault…</span>
      </main>
    );
  }
  if (caps.setup_required) return <Navigate to="/setup" replace />;
  if (need === 'signed-in' && !session.signedIn) return <Navigate to="/welcome" replace />;
  if (need === 'signed-out' && session.signedIn) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function SetupGate() {
  const { caps, session, connectionError } = useApp();
  if (connectionError || !caps) return <Gate need="signed-out">{null}</Gate>;
  if (!caps.setup_required && !session.signedIn) return <Navigate to="/welcome" replace />;
  return <SetupScreen />;
}

export function App() {
  return (
    <AppProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/setup" element={<SetupGate />} />
          <Route
            path="/welcome"
            element={
              <Gate need="signed-out">
                <WelcomeScreen />
              </Gate>
            }
          />
          {/* An invitation is followed while signed out, but signing in
              first should not throw the link away either, so this is
              outside both gates. */}
          <Route path="/join/:token" element={<JoinScreen />} />
          <Route
            path="/sign-in"
            element={
              <Gate need="signed-out">
                <SignInScreen />
              </Gate>
            }
          />
          <Route
            path="/"
            element={
              <Gate need="signed-in">
                <HomeScreen />
              </Gate>
            }
          />
          <Route
            path="/add"
            element={
              <Gate need="signed-in">
                <AddScreen />
              </Gate>
            }
          />
          <Route
            path="/documents/:id"
            element={
              <Gate need="signed-in">
                <DocumentScreen />
              </Gate>
            }
          />
          <Route
            path="/documents/:id/confirm"
            element={
              <Gate need="signed-in">
                <ConfirmScreen />
              </Gate>
            }
          />
          <Route
            path="/search"
            element={
              <Gate need="signed-in">
                <SearchScreen />
              </Gate>
            }
          />
          <Route
            path="/reminders"
            element={
              <Gate need="signed-in">
                <RemindersScreen />
              </Gate>
            }
          />
          <Route
            path="/people"
            element={
              <Gate need="signed-in">
                <PeopleScreen />
              </Gate>
            }
          />
          <Route
            path="/people/:id"
            element={
              <Gate need="signed-in">
                <PersonScreen />
              </Gate>
            }
          />
          <Route
            path="/settings"
            element={
              <Gate need="signed-in">
                <SettingsScreen />
              </Gate>
            }
          />
          <Route
            path="/settings/notifications"
            element={
              <Gate need="signed-in">
                <NotificationsScreen />
              </Gate>
            }
          />
          <Route
            path="/settings/storage"
            element={
              <Gate need="signed-in">
                <StorageScreen />
              </Gate>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AppProvider>
  );
}
