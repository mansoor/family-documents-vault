import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from 'react-router';
import { AppProvider, useApp } from './app-context.js';
import { BatchUploadProvider } from './batch-store.js';
import { AddScreen, ConfirmScreen } from './screens/AddConfirm.js';
import { AddManyScreen, BatchScreen, InboxScreen, SentScreen } from './screens/Batches.js';
import { BatchItemScreen } from './screens/BatchItem.js';
import { DocumentScreen } from './screens/Document.js';
import { DocumentsScreen } from './screens/Documents.js';
import { ReaderScreen } from './screens/Reader.js';
import { SignInScreen, WelcomeScreen } from './screens/Entry.js';
import { ActivityScreen } from './screens/Activity.js';
import { AskForDocumentsScreen } from './screens/AskForDocuments.js';
import { AfterRestoreScreen } from './screens/AfterRestore.js';
import { FamilyScreen } from './screens/Family.js';
import { GuestsScreen } from './guests.js';
import { TrashScreen } from './screens/Trash.js';
import { HomeScreen } from './screens/Home.js';
import { HouseholdQuestionsScreen } from './screens/HouseholdQuestions.js';
import { IncomingFileScreen } from './screens/Incoming.js';
import { JoinScreen } from './screens/Join.js';
import { KindScreen, KindsScreen } from './screens/KindsOfDocument.js';
import { CollectionScreen, CollectionsScreen } from './screens/Collections.js';
import { ForgotPasswordScreen, ResetPasswordScreen } from './screens/Password.js';
import { SharedScreen } from './screens/Shared.js';
import { SharingScreen } from './screens/Sharing.js';
import { HouseholdScreen } from './screens/Household.js';
import { EmailScreen, NotificationsScreen } from './screens/Notifications.js';
import { PersonDocumentsScreen, ProfileScreen } from './screens/Person.js';
import { PeopleScreen, RemindersScreen, SearchScreen } from './screens/SearchPeople.js';
import {
  AccountScreen,
  DataScreen,
  OwnersScreen,
  SettingsScreen,
  StorageScreen,
} from './screens/Settings.js';
import { SettingsLayout } from './settings-sections.js';
import { SetupScreen } from './screens/Setup.js';
import { FocusOnMove } from './focus-on-move.js';
import { Only, SCREEN_RULES } from './not-for.js';
import { PageTitle } from './page-title.js';
import { AppShell } from './shell.js';
import { Logo } from './ui.js';

/**
 * Routing rules:
 *  - not connected            → the connection card
 *  - setup required           → /setup only
 *  - signed out               → /welcome, /sign-in
 *  - signed in                → everything else, inside the shell
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

/**
 * Where a screen was before R1, and where it is now. Settings held these
 * until Settings became settings only; Files sent to you was /incoming,
 * which the vault's own emails and notifications still link to.
 */
const MOVED: ReadonlyArray<readonly [from: string, to: string]> = [
  ['/settings/activity', '/activity'],
  ['/settings/trash', '/trash'],
  ['/settings/sharing', '/sharing'],
  ['/settings/sharing/ask', '/sharing/ask'],
  ['/settings/guests', '/people/outside'],
  ['/settings/after-restore', '/after-restore'],
  ['/incoming', '/inbox/sent'],
  ['/incoming/:id', '/inbox/:id'],
];

/**
 * The same screen at its new address, the old one replaced in the history
 * (so Back does not bounce): what was asked (?person=…), where on the page
 * (#…) and what the last screen said there come with it.
 */
function Moved({ to }: { to: string }) {
  const location = useLocation();
  const state: unknown = location.state;
  const params = useParams();
  const pathname = to.replace(/:(\w+)/g, (_whole: string, name: string) =>
    encodeURIComponent(params[name] ?? ''),
  );
  return (
    <Navigate
      to={{ pathname, search: location.search, hash: location.hash }}
      state={state}
      replace
    />
  );
}

export function App() {
  return (
    <AppProvider>
      {/* Beside it, the upload of many documents (I1): it outlives the page that started it. */}
      <BatchUploadProvider>
        <BrowserRouter>
          {/* The window's title, on every page (R5). */}
          <PageTitle />
          {/* A move that left the focus nowhere: the new page's heading (R5). */}
          <FocusOnMove />
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
            {/* Every signed-in screen, inside the shell (Phase 6, R1). A screen a
                role cannot use, typed into the address bar, says so (`Only`). */}
            <Route
              element={
                <Gate need="signed-in">
                  <AppShell />
                </Gate>
              }
            >
              <Route path="/" element={<HomeScreen />} />
              <Route
                path="/add"
                element={
                  <Only rule={SCREEN_RULES.add}>
                    <AddScreen />
                  </Only>
                }
              />
              <Route
                path="/add/many"
                element={
                  <Only rule={SCREEN_RULES.addMany}>
                    <AddManyScreen />
                  </Only>
                }
              />
              {/* Documents (R2): the table from 768 px, today's rows on a phone. */}
              <Route path="/documents" element={<DocumentsScreen />} />
              <Route path="/documents/:id" element={<DocumentScreen />} />
              <Route path="/documents/:id/read" element={<ReaderScreen />} />
              <Route path="/documents/:id/confirm" element={<ConfirmScreen />} />
              <Route path="/search" element={<SearchScreen />} />
              {/* Open to a viewer too: the role rules let a viewer see reminders,
                  and Home's Needs attention links a viewer here. */}
              <Route path="/reminders" element={<RemindersScreen />} />
              {/* The household's questions on their own, from Reminders (5.35). */}
              <Route path="/household-questions" element={<HouseholdQuestionsScreen />} />
              <Route
                path="/people"
                element={
                  <Only rule={SCREEN_RULES.people}>
                    <PeopleScreen />
                  </Only>
                }
              />
              {/* Beside the family, for owners (5.34; under People since R1). */}
              <Route
                path="/people/outside"
                element={
                  <Only rule={SCREEN_RULES.outside}>
                    <GuestsScreen />
                  </Only>
                }
              />
              {/* A person's profile, from People (and old bookmarks); their
                documents, from Home (A64). */}
              <Route path="/people/:id" element={<ProfileScreen />} />
              <Route path="/people/:id/documents" element={<PersonDocumentsScreen />} />
              <Route path="/collections" element={<CollectionsScreen />} />
              <Route path="/collections/:id" element={<CollectionScreen />} />
              {/* What was sent through a request, looked at before it is filed
                (5.23): the Inbox since R1. */}
              <Route
                path="/inbox"
                element={
                  <Only rule={SCREEN_RULES.inbox}>
                    <InboxScreen />
                  </Only>
                }
              />
              {/* Phase 6, I1: the files sent to you beside your uploads, a
                batch, and one of its files' card. */}
              <Route
                path="/inbox/sent"
                element={
                  <Only rule={SCREEN_RULES.sent}>
                    <SentScreen />
                  </Only>
                }
              />
              <Route
                path="/inbox/batches/:id"
                element={
                  <Only rule={SCREEN_RULES.batches}>
                    <BatchScreen />
                  </Only>
                }
              />
              <Route
                path="/inbox/batches/:id/items/:itemId"
                element={
                  <Only rule={SCREEN_RULES.batches}>
                    <BatchItemScreen />
                  </Only>
                }
              />
              <Route
                path="/inbox/:id"
                element={
                  <Only rule={SCREEN_RULES.sent}>
                    <IncomingFileScreen />
                  </Only>
                }
              />
              <Route
                path="/sharing"
                element={
                  <Only rule={SCREEN_RULES.sharing}>
                    <SharingScreen />
                  </Only>
                }
              />
              {/* Ask for documents (5.22): from Sharing, and from a person's
                page (?person=<their id>, a hint for whoever reviews). */}
              <Route
                path="/sharing/ask"
                element={
                  <Only rule={SCREEN_RULES.ask}>
                    <AskForDocumentsScreen />
                  </Only>
                }
              />
              <Route
                path="/activity"
                element={
                  <Only rule={SCREEN_RULES.activity}>
                    <ActivityScreen />
                  </Only>
                }
              />
              {/* Open to a viewer too: a viewer sees what they filed that is in
                  the Trash, and Home sends them here when an owner asks to remove
                  it for good (5.24). */}
              <Route path="/trash" element={<TrashScreen />} />
              {/* From Home's banner, while a restore has paused something. */}
              <Route
                path="/after-restore"
                element={
                  <Only rule={SCREEN_RULES.afterRestore}>
                    <AfterRestoreScreen />
                  </Only>
                }
              />
              {/* Settings holds settings only (R1), in sections: from 768 px
                the sub-menu beside each; on a phone, /settings lists them.
                The pages it had keep their addresses, under their section. */}
              <Route path="/settings" element={<SettingsLayout />}>
                <Route index element={<SettingsScreen />} />
                <Route path="account" element={<AccountScreen />} />
                <Route path="notifications" element={<NotificationsScreen />} />
                <Route path="household" element={<HouseholdScreen />} />
                <Route path="family" element={<FamilyScreen />} />
                <Route path="kinds" element={<KindsScreen />} />
                <Route path="kinds/new" element={<KindScreen />} />
                <Route path="kinds/:key" element={<KindScreen />} />
                <Route
                  path="data"
                  element={
                    <Only rule={SCREEN_RULES.data}>
                      <DataScreen />
                    </Only>
                  }
                />
                <Route
                  path="owners"
                  element={
                    <Only rule={SCREEN_RULES.owners}>
                      <OwnersScreen />
                    </Only>
                  }
                />
                <Route
                  path="storage"
                  element={
                    <Only rule={SCREEN_RULES.storage}>
                      <StorageScreen />
                    </Only>
                  }
                />
                <Route
                  path="email"
                  element={
                    <Only rule={SCREEN_RULES.email}>
                      <EmailScreen />
                    </Only>
                  }
                />
              </Route>
            </Route>
            {MOVED.map(([from, to]) => (
              <Route key={from} path={from} element={<Moved to={to} />} />
            ))}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </BatchUploadProvider>
    </AppProvider>
  );
}
