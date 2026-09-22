#!/usr/bin/env node
// Writes a .env for docker compose with fresh random secrets.
// Refuses to overwrite an existing .env: the master key in it is the only
// thing that makes your documents readable, and regenerating it by accident
// would lose them all.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, '.env');

if (existsSync(target) && !process.argv.includes('--force')) {
  console.error(`.env already exists at ${target}`);
  console.error('Not overwriting it. If you really want a new one, pass --force —');
  console.error('and understand that a new FDV_MASTER_KEY makes existing documents unreadable.');
  process.exit(1);
}

const secret = (bytes) => randomBytes(bytes).toString('base64url');

// VAPID keys for Web Push: a P-256 pair, in the raw/PKCS8 base64url form
// the push protocol expects. Generated here so notifications work with no
// account anywhere and no configuration.
function vapidKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-65);
  const jwk = privateKey.export({ format: 'jwk' });
  return { publicKey: pub.toString('base64url'), privateKey: jwk.d };
}
const vapid = vapidKeys();

const env = `# Family Document Vault — generated ${new Date().toISOString()}
#
# KEEP A COPY OF THIS FILE SOMEWHERE SAFE, OFF THIS MACHINE.
# FDV_MASTER_KEY wraps every other key. Without it, the files are unreadable.

# The one line to change: what your family calls this vault.
FDV_DISPLAY_NAME=Our family vault

# Port the web app is served on, and where it is reachable. The address
# is used for links inside reminder messages.
FDV_PORT=8080
FDV_BASE_URL=http://localhost:8080

# --- secrets: generated, do not share -----------------------------------
FDV_MASTER_KEY=${secret(32)}
FDV_DB_PASSWORD=${secret(24)}
FDV_DB_APP_PASSWORD=${secret(24)}

# Web Push signing keys. Regenerating them means everyone has to turn
# notifications on again; nothing else is affected.
FDV_VAPID_PUBLIC_KEY=${vapid.publicKey}
FDV_VAPID_PRIVATE_KEY=${vapid.privateKey}
FDV_VAPID_SUBJECT=mailto:vault@example.invalid

# --- optional --------------------------------------------------------------
# LOG_LEVEL=info
# FDV_VERSION=latest
`;

writeFileSync(target, env, { mode: 0o600 });
console.log(`wrote ${target}`);
console.log('Back it up. Then: docker compose up -d');
