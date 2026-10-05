import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { AppProvider, useApp } from './app-context.js';
import { AddScreen, ConfirmScreen } from './screens/AddConfirm.js';
import { DocumentScreen } from './screens/Document.js';
import { ReaderScreen } from './screens/Reader.js';
import { SignInScreen, WelcomeScreen } from './screens/Entry.js';
import { ActivityScreen } from './screens/Activity.js';
import { AskForDocumentsScreen } from './screens/AskForDocuments.js';
import { AfterRestoreScreen } from './screens/AfterRestore.js';
import { FamilyScreen } from './screens/Family.js';
import { GuestsScreen } from './guests.js';
import { TrashScreen } from './screens/Trash.js';
import { HomeScreen } from './screens/Home.js';
import { IncomingFileScreen, IncomingScreen } from './screens/Incoming.js';
import { JoinScreen } from './screens/Join.js';
import { KindScreen, KindsScreen } from './screens/KindsOfDocument.js';
import { CollectionScreen, CollectionsScreen } from './screens/Collections.js';
import { ForgotPasswordScreen, ResetPasswordScreen } from './screens/Password.js';
import { SharedScreen } from './screens/Shared.js';
import { SharingScreen } from './screens/Sharing.js';
import { NotificationsScreen } from './screens/Notifications.js';
import { PersonDocumentsScreen, ProfileScreen } from './screens/Person.js';
import { PeopleScreen, RemindersScreen, SearchScreen } from './screens/SearchPeople.js';
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
              outside both gates. Its token is not in the address: it was
              after the # (or, in a link made before 0.5.17, in the path),
              and was taken out before the router saw it (link-token.ts). */}
          <Route path="/join" element={<JoinScreen />} />
          {/* Both outside the gates: somebody who cannot sign in is
              exactly who these are for. */}
          <Route
            path="/forgot-password"
            element={
              <Gate need="signed-out">
                <ForgotPasswordScreen />
              </Gate>
            }
          />
          {/* The same for a reset link: /reset#<token>, or /reset/<token>
              before 0.5.17, is /reset by now. */}
          <Route path="/reset" element={<ResetPasswordScreen />} />
          {/* Outside the gates entirely: whoever opens this has no
              account and is not going to make one. */}
          <Route path="/shared/:token" element={<SharedScreen />} />
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
            path="/documents/:id/read"
            element={
              <Gate need="signed-in">
                <ReaderScreen />
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
          {/* A person's profile, from People (and old bookmarks); their
              documents, from Home (A64). */}
          <Route
            path="/people/:id"
            element={
              <Gate need="signed-in">
                <ProfileScreen />
              </Gate>
            }
          />
          <Route
            path="/people/:id/documents"
            element={
              <Gate need="signed-in">
                <PersonDocumentsScreen />
              </Gate>
            }
          />
          <Route
            path="/collections"
            element={
              <Gate need="signed-in">
                <CollectionsScreen />
              </Gate>
            }
          />
          <Route
            path="/collections/:id"
            element={
              <Gate need="signed-in">
                <CollectionScreen />
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
            path="/settings/activity"
            element={
              <Gate need="signed-in">
                <ActivityScreen />
              </Gate>
            }
          />
          <Route
            path="/settings/trash"
            element={
              <Gate need="signed-in">
                <TrashScreen />
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
          <Route
            path="/settings/family"
            element={
              <Gate need="signed-in">
                <FamilyScreen />
              </Gate>
            }
          />
          <Route
            path="/settings/guests"
            element={
              <Gate need="signed-in">
                <GuestsScreen />
              </Gate>
            }
          />
          <Route
            path="/settings/after-restore"
            element={
              <Gate need="signed-in">
                <AfterRestoreScreen />
              </Gate>
            }
          />
          <Route
            path="/settings/sharing"
            element={
              <Gate need="signed-in">
                <SharingScreen />
              </Gate>
            }
          />
          {/* Ask for documents (5.22): from Sharing, and from a person's
              page (?person=<their id>, a hint for whoever reviews). */}
          <Route
            path="/settings/sharing/ask"
            element={
              <Gate need="signed-in">
                <AskForDocumentsScreen />
              </Gate>
            }
          />
          <Route
            path="/settings/kinds"
            element={
              <Gate need="signed-in">
                <KindsScreen />
              </Gate>
            }
          />
          <Route
            path="/settings/kinds/new"
            element={
              <Gate need="signed-in">
                <KindScreen />
              </Gate>
            }
          />
          <Route
            path="/settings/kinds/:key"
            element={
              <Gate need="signed-in">
                <KindScreen />
              </Gate>
            }
          />
          {/* What was sent through a request, looked at before it is filed (5.23). */}
          <Route
            path="/incoming"
            element={
              <Gate need="signed-in">
                <IncomingScreen />
              </Gate>
            }
          />
          <Route
            path="/incoming/:id"
            element={
              <Gate need="signed-in">
                <IncomingFileScreen />
              </Gate>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AppProvider>
  );
}
