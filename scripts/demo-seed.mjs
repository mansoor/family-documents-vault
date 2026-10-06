#!/usr/bin/env node
// Fills a running vault with a made-up household, for trying it out or for
// a demonstration: an owner, a second adult, a teen and a viewer limited to
// the second adult's tax papers; a will, a deed, tax papers, a passport, a
// car insurance policy and a scanned page whose words the vault reads; an
// empty collection "For the attorney"; and a request to an accountant to
// send documents. Everything is invented. It talks to the vault's API only,
// as the web app does, and changes nothing else.
//
//   FDV_DEMO_OWNER_EMAIL=you@example.test FDV_DEMO_OWNER_PASSWORD='…' \
//     node scripts/demo-seed.mjs --url http://localhost:8099
//
// Options (each also read from the environment):
//   --url <address>          FDV_DEMO_URL             the vault (default http://localhost:8099)
//   --email <address>        FDV_DEMO_OWNER_EMAIL     the owner's sign-in (required)
//   --password <password>    FDV_DEMO_OWNER_PASSWORD  the owner's password (required)
//   --code <six digits>      FDV_DEMO_TOTP_CODE       only if the owner already has two-step sign-in
//   --household <name>       FDV_DEMO_HOUSEHOLD       a new vault's name (default "The Khan family")
//   --name <name>            FDV_DEMO_OWNER_NAME      a new vault's owner's name (default "Olivia")
//   --domain <domain>        FDV_DEMO_EMAIL_DOMAIN    the made-up people's addresses (default example.test)
//   --out <folder>           FDV_DEMO_OUT             also write the scanned page there, to upload by hand
//   --i-mean-it                                       allow port 8080
//
// A vault that has not been set up is set up with the owner's details. One
// that has is signed in to; run it once, as a second run adds a second set.
// The made-up people's passwords are made up here and printed at the end,
// once. Port 8080 — where a household's own vault usually runs — is refused
// unless --i-mean-it is given.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// ------------------------------------------------------------------ options

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name, env, fallback) => {
  const at = argv.indexOf(`--${name}`);
  if (at >= 0 && argv[at + 1] !== undefined) return argv[at + 1];
  return process.env[env] ?? fallback;
};

const base = option('url', 'FDV_DEMO_URL', 'http://localhost:8099').replace(/\/+$/, '');
const ownerEmail = option('email', 'FDV_DEMO_OWNER_EMAIL');
const ownerPassword = option('password', 'FDV_DEMO_OWNER_PASSWORD');
const totpCode = option('code', 'FDV_DEMO_TOTP_CODE');
const household = option('household', 'FDV_DEMO_HOUSEHOLD', 'The Khan family');
const ownerName = option('name', 'FDV_DEMO_OWNER_NAME', 'Olivia');
const domain = option('domain', 'FDV_DEMO_EMAIL_DOMAIN', 'example.test');
const out = option('out', 'FDV_DEMO_OUT');

function fail(message) {
  console.error(`demo-seed: ${message}`);
  process.exit(1);
}

let url;
try {
  url = new URL(base);
} catch {
  fail(`${base} is not an address. Give one with --url, such as http://localhost:8099.`);
}
const port = url.port || (url.protocol === 'https:' ? '443' : '80');
if (port === '8080' && !flag('i-mean-it')) {
  fail(
    `${base} is on port 8080, where a household's own vault usually runs. ` +
      'This fills a vault with made-up people and documents; pass --i-mean-it if that is what you want.',
  );
}
if (!ownerEmail || !ownerPassword) {
  fail(
    'give the owner’s sign-in with --email and --password (or FDV_DEMO_OWNER_EMAIL and FDV_DEMO_OWNER_PASSWORD).',
  );
}

// ---------------------------------------------------------------- the API

async function call(method, route, { token, body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (token) init.headers.authorization = `Bearer ${token}`;
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${base}/api/v1${route}`, init);
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const why = json?.error ? `${json.error.code}: ${json.error.message}` : text;
    throw new Error(`${method} ${route} answered ${res.status} (${why})`);
  }
  return json;
}

const password = () => `${randomBytes(9).toString('base64url')}-demo`;

/** Somebody signed in: their tokens, and their password to confirm it is them. */
async function signIn(email, secret) {
  let tokens = await call('POST', '/auth/password', { body: { email, password: secret } });
  if (tokens.mfa_required) {
    if (!totpCode) {
      fail(`${email} has two-step sign-in: give a code from the authenticator with --code.`);
    }
    tokens = await call('POST', '/auth/mfa', {
      body: { mfa_token: tokens.mfa_token, code: totpCode },
    });
  }
  return tokens;
}

/** Confirms it is them, for what asks (inviting somebody). */
const confirm = (token, secret) =>
  call('POST', '/auth/step-up', { token, body: { password: secret } });

// ------------------------------------------------------------- made-up papers

/** A one-page PDF with these lines as real text, so the vault reads them without OCR. */
function textPdf(lines) {
  // Printable ASCII alone, as the standard font draws it; ( ) and \ escaped.
  const escape = (s) => s.replace(/[^ -~]/g, '?').replace(/[\\()]/g, (c) => `\\${c}`);
  const text = [
    'BT',
    '/F1 12 Tf',
    '14 TL',
    '72 770 Td',
    ...lines.map((l) => `(${escape(l)}) Tj T*`),
    'ET',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(text, 'latin1')} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

const day = (offsetDays) => {
  const d = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
};
const surname =
  household
    .replace(/^the\s+/i, '')
    .replace(/\s+family$/i, '')
    .trim() || 'Khan';
const SURNAME = surname.toUpperCase();

/** A scanned passport page whose words the vault reads, and suggests from (5.37). */
const passportScan = textPdf([
  'PASSPORT',
  'UNITED KINGDOM OF GREAT BRITAIN AND NORTHERN IRELAND',
  'Passport No.',
  '533401872',
  'Surname',
  SURNAME,
  'Given names',
  'AHMED',
  'Nationality',
  'BRITISH CITIZEN',
  'Date of issue',
  '14 MAR 2021',
  'Date of expiry',
  '14 MAR 2031',
  'Authority',
  'HMPO',
  'This is a made-up document for a demonstration.',
]);

// ------------------------------------------------------------------ seeding

async function main() {
  console.log(`demo-seed: ${base}`);
  const caps = await call('GET', '/capabilities');
  let owner;
  if (caps.setup_required) {
    owner = await call('POST', '/setup', {
      body: {
        household_name: household,
        display_name: ownerName,
        email: ownerEmail,
        password: ownerPassword,
      },
    });
    console.log(`  set up "${household}" with ${ownerName} as its owner`);
  } else {
    owner = await signIn(ownerEmail, ownerPassword);
    console.log(`  signed in as ${ownerEmail}`);
  }
  const t = owner.access_token;

  // The people: each invited as the web invites them, and accepted with a
  // password made up here.
  const people = {};
  const join = async (key, displayName, role, extra = {}) => {
    await confirm(t, ownerPassword);
    const email = `${key}-${randomUUID().slice(0, 6)}@${domain}`;
    const invited = await call('POST', '/invitations', {
      token: t,
      body: { display_name: displayName, email, role, ...extra },
    });
    const secret = password();
    const tokens = await call('POST', '/invitations/accept', {
      body: { token: invited.link_token, code: invited.code, password: secret },
    });
    people[key] = { name: displayName, role, email, password: secret, member_id: tokens.member_id };
    console.log(`  ${displayName} joined as ${role === 'adult' ? 'an adult' : `a ${role}`}`);
    return tokens;
  };
  await join('ahmed', 'Ahmed', 'adult');
  await join('tariq', 'Tariq', 'teen');
  // A viewer limited to Ahmed's tax papers: what the demonstration widens
  // to his Adults only ones too, which takes an owner's two-step sign-in.
  await join('vera', 'Vera', 'viewer', {
    relationship: 'the family’s accountant',
    restriction: { people: [people.ahmed.member_id], types: ['tax_return'] },
  });

  // The papers.
  const me = await call('GET', '/me', { token: t });
  const file = async (doc, lines, name) => {
    const made = await call('POST', '/documents', { token: t, body: doc });
    const form = new FormData();
    form.append('file', new Blob([textPdf(lines)], { type: 'application/pdf' }), name);
    await call('POST', `/documents/${made.id}/versions`, {
      token: t,
      body: form,
      headers: { 'idempotency-key': randomUUID() },
    });
    console.log(`  filed "${doc.title}"`);
    return made;
  };
  await file(
    {
      title: `${ownerName}'s will`,
      type_key: 'will',
      owner_member_id: me.member_id,
      visibility: 'adults',
      issued: { date: '2024-06-02', precision: 'day' },
      physical_location: 'Study, the fire safe',
    },
    [
      `LAST WILL AND TESTAMENT OF ${ownerName.toUpperCase()} ${SURNAME}`,
      'Signed 2 June 2024 in the presence of two witnesses.',
      'Executor: the family solicitor.',
      'This is a made-up document for a demonstration.',
    ],
    'will.pdf',
  );
  await file(
    {
      title: 'House deed, 14 Elm Street',
      type_key: 'property_deed',
      owner_member_id: null,
      visibility: 'household',
      issued: { date: '2016-09-30', precision: 'day' },
      physical_location: 'Study, the fire safe',
    },
    [
      'TITLE DEED',
      '14 Elm Street',
      `Registered proprietors: the ${surname} family`,
      'Completion: 30 September 2016',
      'This is a made-up document for a demonstration.',
    ],
    'deed.pdf',
  );
  await file(
    {
      title: 'Ahmed tax return 2025',
      type_key: 'tax_return',
      owner_member_id: people.ahmed.member_id,
      visibility: 'household',
      issued: { date: '2026-01-20', precision: 'day' },
    },
    [
      'SELF ASSESSMENT TAX RETURN 2024-25',
      `Taxpayer: AHMED ${SURNAME}`,
      'Filed 20 January 2026',
      'This is a made-up document for a demonstration.',
    ],
    'tax-return.pdf',
  );
  await file(
    {
      title: 'Ahmed tax return 2025, the adults’ copy',
      type_key: 'tax_return',
      owner_member_id: people.ahmed.member_id,
      visibility: 'adults',
      issued: { date: '2026-01-20', precision: 'day' },
    },
    [
      'SELF ASSESSMENT TAX RETURN 2024-25: WORKINGS',
      `Taxpayer: AHMED ${SURNAME}`,
      'This is a made-up document for a demonstration.',
    ],
    'tax-workings.pdf',
  );
  await file(
    {
      title: 'Ahmed passport',
      type_key: 'passport',
      owner_member_id: people.ahmed.member_id,
      visibility: 'household',
      identifier: '533401872',
      issued: { date: '2021-03-14', precision: 'day' },
      expires: { date: '2031-03-14', precision: 'day' },
      is_essential: true,
    },
    ['PASSPORT', `AHMED ${SURNAME}`, 'This is a made-up document for a demonstration.'],
    'passport.pdf',
  );
  await file(
    {
      title: 'Car insurance',
      type_key: 'insurance_policy',
      owner_member_id: me.member_id,
      visibility: 'household',
      issued_by: 'Example Mutual',
      expires: { date: day(25), precision: 'day' },
    },
    [
      'MOTOR INSURANCE CERTIFICATE',
      'Insurer: Example Mutual',
      `Policyholder: ${ownerName.toUpperCase()} ${SURNAME}`,
      'This is a made-up document for a demonstration.',
    ],
    'car-insurance.pdf',
  );
  // A scanned page with nothing filed about it: its page shows what the
  // vault read (5.37), once the worker has read it.
  const scan = await call('POST', '/documents', {
    token: t,
    body: { title: 'A scan from the printer' },
  });
  const form = new FormData();
  form.append('file', new Blob([passportScan], { type: 'application/pdf' }), 'scan.pdf');
  await call('POST', `/documents/${scan.id}/versions`, {
    token: t,
    body: form,
    headers: { 'idempotency-key': randomUUID() },
  });
  console.log('  filed "A scan from the printer"');
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, 'passport-scan.pdf'), passportScan);
    console.log(`  wrote ${path.join(out, 'passport-scan.pdf')}, to add by hand`);
  }

  // The collection the will and the deed go into, during the demonstration.
  await call('POST', '/collections', {
    token: t,
    body: { name: 'For the attorney', audience: 'adults' },
  });
  console.log('  made the collection "For the attorney" (Adults), empty');

  // A request to the accountant: a password, two visits.
  const request = await call('POST', '/upload-requests', {
    token: t,
    body: {
      title: 'Your 2025 tax papers',
      message: 'Please send the P60 and the bank interest statement.',
      items: ['P60', 'Bank interest statement'],
      recipient_label: 'accountant',
      expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      with_password: true,
      max_visits: 2,
    },
  });
  const link = request.link_url ?? `${base}/drop#${request.link_token}`;

  console.log('\nThe made-up people (their passwords are shown this once):');
  for (const p of Object.values(people)) {
    console.log(`  ${p.name.padEnd(6)} ${p.role.padEnd(7)} ${p.email}  ${p.password}`);
  }
  console.log('\nThe request to the accountant:');
  console.log(`  link      ${link}`);
  console.log(`  password  ${request.password}`);
  console.log(
    `\nNow sign in at ${base} as ${ownerEmail} and turn on two-step sign-in ` +
      '(Settings, then Two-step sign-in), with an authenticator app. The checks that use an ' +
      "owner's powers — locking a sign-in, a reset, limits on a viewer — need it.",
  );
}

main().catch((err) => fail(err.message));
