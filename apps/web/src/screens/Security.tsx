import { Navigate } from 'react-router';
import { AutoLockCard } from '../auto-lock-settings.js';
import { useApp } from '../app-context.js';
import { securityCards } from '../settings-sections.js';
import { storedRole } from '../session.js';
import { TwoStepRuleCard } from '../two-step-rule.js';
import { SettingsPage } from './Settings.js';

/**
 * Settings → Security (/settings/security; 24 Nov 2026, the owner's ask),
 * before Privacy: whether every adult must have two-step sign-in, an
 * owner's; and when the vault locks itself — the family's time, an owner's,
 * and each person's own, shorter one beside it (until then in Your account).
 */
export function SecurityScreen() {
  const { caps, session } = useApp();
  const role = session.info?.role ?? storedRole();
  const cards = securityCards(role, caps);
  // Nothing here for them (no rule of theirs, and no locking on this vault):
  // Settings itself, never an empty page. Not before the vault has said what
  // it offers.
  if (caps && !cards.twoStepRule && !cards.myLock) return <Navigate to="/settings" replace />;
  return (
    <SettingsPage title="Security">
      {/* Two-step sign-in for adults (0.9.0): an owner's to change. */}
      {cards.twoStepRule && <TwoStepRuleCard />}
      {/* Lock after a while away (0.9.0-dev.87): the family's time, an
          owner's to change, and yours beside it, in one card. */}
      {cards.myLock && <AutoLockCard />}
    </SettingsPage>
  );
}
