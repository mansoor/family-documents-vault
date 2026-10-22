#!/usr/bin/env node
// The Smart exit's corpus (0.8.0, S5): two hundred made-up papers of one
// household, in the folders a family keeps them in, for measuring how many
// the vault reads well enough that nobody has to type their details.
//
//   node scripts/smart-corpus.mjs --out ./corpus [--seed 1]
//
// writes the papers there, each where the family keeps it — partly tidy
// (Ahmed/Passport, Bills/2026), partly flat (Scans/), a few misfiled — with
// manifest.json beside them: for each file, what a person would fill in
// (its kind, whose it is, its dates, its number and who issued it) and how
// it was made. The same seed gives the same bytes. demo-seed.mjs --corpus
// writes it too, for a vault it has just filled with the same people.
//
// The mix: about six in ten are PDFs that carry their words (statements and
// bills as they are downloaded), about four in ten are scans — only a
// picture of the page, crooked, specked and at a scanner's resolution, so
// only OCR reads them; a few have more than one page; three are blank or
// nearly; three are copies of another (two the same bytes, one scanned
// again); about one in ten is a paper of no kind the vault keeps (a menu,
// a newsletter, a letter for somebody who used to live there). Each paper's
// layout is in one of two sets: `tune`, which the vault's rules may be
// adjusted to read, and `held-out`, which they never are (see
// smart-corpus-papers.mjs).
//
// Options (each also read from the environment):
//   --out <folder>      FDV_CORPUS_OUT      where to write it (required)
//   --seed <number>     FDV_CORPUS_SEED     which corpus (default 1)
//   --owner <name>      FDV_CORPUS_OWNER    the owner's first name (default Olivia)
//   --surname <name>    FDV_CORPUS_SURNAME  the family's surname (default Khan)
//   --corpus <name>     FDV_CORPUS          first (the 200 the rules were tuned on) or
//                                           second (the held-out set written after, 0.8.0 S5)
//                                           or third (held out, written after the shape words froze, 0.9.0 R1)
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAPERS, addDays, addMonths } from './smart-corpus-papers.mjs';
import { PAPERS_2, home2, plan2 } from './smart-corpus-papers-2.mjs';
import { PAPERS_3, home3, plan3 } from './smart-corpus-papers-3.mjs';
import { Page, randomFor, scanLook, scanPdf, textPdf } from './smart-corpus-render.mjs';

/** The day the corpus is made as of: no clock is read. */
export const CORPUS_TODAY = '2026-10-01';

/**
 * The household: who the papers are for, as the vault knows them (`name`)
 * and as the papers write them. Olivia is the owner, Ahmed an adult, Tariq a
 * teen; Maryam and Granny Farida have no sign-in.
 */
export function corpusPeople({ owner = 'Olivia', surname = 'Khan' } = {}) {
  return [
    {
      key: 'olivia',
      name: owner,
      role: 'owner',
      first: owner,
      middle: 'Jane',
      surname,
      title: 'Mrs',
      sex: 'F',
      born: '1984-05-22',
      birthplace: 'Westmere',
      ni: 'QQ 41 72 08 A',
      nhs: '999 204 7731',
    },
    {
      key: 'ahmed',
      name: 'Ahmed',
      role: 'adult',
      first: 'Ahmed',
      middle: 'Raza',
      surname,
      title: 'Mr',
      sex: 'M',
      born: '1981-11-03',
      birthplace: 'Ashby Vale',
      ni: 'QQ 12 34 56 C',
      nhs: '999 318 5520',
    },
    {
      key: 'tariq',
      name: 'Tariq',
      role: 'teen',
      first: 'Tariq',
      middle: 'Ali',
      surname,
      title: 'Master',
      sex: 'M',
      born: '2011-02-17',
      birthplace: 'Ashby Vale',
      ni: 'QQ 98 76 54 B',
      nhs: '999 452 1196',
      child: true,
      age: 15,
    },
    {
      key: 'maryam',
      name: 'Maryam',
      role: null,
      first: 'Maryam',
      middle: 'Aisha',
      surname,
      title: 'Miss',
      sex: 'F',
      born: '2017-07-09',
      birthplace: 'Ashby Vale',
      nhs: '999 671 0384',
      child: true,
      age: 9,
    },
    {
      key: 'farida',
      name: 'Granny Farida',
      role: null,
      first: 'Farida',
      surname,
      title: 'Mrs',
      sex: 'F',
      born: '1953-08-30',
      birthplace: 'Lahore',
      nhs: '999 803 2257',
    },
  ];
}

/** The household's address and name. */
const household = (surname) => ({
  name: `The ${surname} family`,
  street: '14 Elm Street',
  town: 'Ashby Vale',
  postcode: 'AV4 7QT',
  today: CORPUS_TODAY,
});

/** Every month end from `from` (an ISO date at a month's end) for `n` months. */
const monthEnds = (from, n) =>
  Array.from({ length: n }, (_, i) => {
    const first = addMonths(`${from.slice(0, 7)}-01`, i + 1);
    return addDays(first, -1);
  });
const months = (from, n, day) =>
  Array.from({ length: n }, (_, i) => addMonths(`${from.slice(0, 7)}-${day}`, i));

/**
 * The papers, in the order a family gathered them: each a template of
 * smart-corpus-papers.mjs, whose it is, and what makes it this one.
 */
function plan(P) {
  const out = [];
  const add = (paper, who, opts = {}) => out.push({ paper, who, opts });
  // Passports: theirs now, and some expired ones kept.
  add('passport-uk', 'olivia', { issued: '2024-03-11' });
  add('passport-uk', 'ahmed', { issued: '2019-08-02' });
  add('passport-uk', 'tariq', { issued: '2022-04-19' });
  add('passport-uk', 'olivia', { issued: '2014-02-27' });
  add('passport-uk-photocopy', 'maryam', { issued: '2023-06-14' });
  add('passport-uk-photocopy', 'ahmed', { issued: '2009-07-30' });
  add('passport-uk-photocopy', 'tariq', { issued: '2017-03-08' });
  add('passport-pk', 'farida', { issued: '2022-01-12' });
  add('passport-pk', 'farida', { issued: '2012-01-05' });
  // Driving licences.
  add('licence-uk', 'olivia', { issued: '2021-05-10' });
  add('licence-uk', 'ahmed', { issued: '2018-11-21' });
  add('licence-summary', 'ahmed', { issued: '2018-11-21', printed: '2026-06-03' });
  add('licence-summary', 'olivia', { issued: '2021-05-10', printed: '2025-09-14' });
  // Insurance.
  for (const issued of ['2024-03-14', '2025-03-14', '2026-03-14']) {
    add('insurance-motor', 'olivia', { issued, plate: 'AV19 RKH', second: P.ahmed });
  }
  for (const issued of ['2025-07-01', '2026-07-01']) {
    add('insurance-motor', 'ahmed', { issued, plate: 'AV22 OJK', second: P.olivia });
  }
  for (const issued of ['2024-06-01', '2025-06-01', '2026-06-01']) {
    add('insurance-home', 'ahmed', { issued });
  }
  for (const issued of ['2025-07-05', '2026-07-05']) {
    add('insurance-travel', 'olivia', { issued, others: [P.ahmed, P.tariq, P.maryam] });
  }
  add('insurance-pet', 'olivia', { issued: '2024-11-02' });
  add('insurance-pet', 'olivia', { issued: '2025-11-02' });
  add('insurance-life', 'ahmed', { issued: '2020-02-01' });
  // Bank statements.
  monthEnds('2025-09-30', 11).forEach((issued, i) =>
    add('bank-current', 'ahmed', { issued, account: '41228706', twoPages: i % 4 === 1 }),
  );
  monthEnds('2025-08-31', 11).forEach((issued, i) =>
    add('bank-current', 'olivia', { issued, account: '57140932', twoPages: i % 5 === 2 }),
  );
  add('bank-savings', 'olivia', { issued: '2025-04-05' });
  add('bank-savings', 'olivia', { issued: '2026-04-05' });
  add('bank-savings', 'maryam', { issued: '2026-04-05', junior: true, parent: P.olivia });
  for (const issued of months('2026-04', 5, '18')) add('credit-card', 'ahmed', { issued });
  // Bills.
  months('2025-08', 14, '14').forEach((issued, i) =>
    add('bill-energy', 'olivia', { issued, account: '8820 4417 3391', directDebit: i % 2 === 1 }),
  );
  months('2026-01', 3, '09').forEach((issued, i) =>
    add('bill-energy', 'olivia', {
      issued,
      account: '8820 4417 3409',
      fuel: 'gas',
      directDebit: i === 1,
    }),
  );
  for (const issued of months('2026-03', 6, '02')) {
    add('bill-broadband', 'ahmed', { issued, account: 'LF-7730 1185' });
  }
  add('bill-water', 'ahmed', { issued: '2025-03-20' });
  add('bill-water', 'ahmed', { issued: '2026-03-20' });
  add('bill-council-tax', 'ahmed', { issued: '2025-03-08' });
  add('bill-council-tax', 'ahmed', { issued: '2026-03-06' });
  for (const issued of months('2026-05', 4, '03')) {
    add('bill-mobile', 'olivia', { issued, account: '1045 2290' });
  }
  for (const issued of months('2026-06', 3, '11')) {
    add('bill-mobile', 'ahmed', { issued, account: '1045 3317' });
  }
  // Tax.
  for (const year of [2023, 2024, 2025, 2026]) {
    add('p60', 'ahmed', { year, employer: 'Corvid Logistics Ltd' });
  }
  for (const year of [2024, 2025, 2026]) {
    add('p60', 'olivia', { year, employer: 'Tamsin & Pryor LLP' });
  }
  add('w2', 'ahmed', { year: 2017 });
  add('w2', 'ahmed', { year: 2018 });
  add('tax-calculation', 'olivia', { year: 2024, issued: '2025-02-10' });
  add('tax-calculation', 'olivia', { year: 2025, issued: '2026-02-12' });
  add('tax-return-receipt', 'olivia', { year: 2024, issued: '2025-01-28' });
  add('tax-return-receipt', 'olivia', { year: 2025, issued: '2026-01-20' });
  // Medical.
  for (const [who, issued] of [
    ['olivia', '2025-11-04'],
    ['olivia', '2026-03-03'],
    ['olivia', '2026-08-19'],
    ['ahmed', '2025-12-15'],
    ['ahmed', '2026-05-27'],
    ['farida', '2025-10-09'],
    ['farida', '2026-02-02'],
    ['farida', '2026-07-21'],
    ['maryam', '2026-01-26'],
    ['tariq', '2026-04-14'],
  ]) {
    add('gp-letter', who, { issued });
  }
  add('immunisation-record', 'maryam');
  add('immunisation-record', 'tariq');
  add('hospital-letter', 'tariq', { issued: '2026-06-15' });
  add('hospital-letter', 'farida', { issued: '2026-03-30' });
  add('hospital-letter', 'maryam', { issued: '2025-11-20' });
  add('dental-recall', 'ahmed', { issued: '2026-02-10' });
  add('dental-recall', 'maryam', { issued: '2026-02-10' });
  add('dental-recall', 'olivia', { issued: '2026-08-05' });
  for (const issued of ['2026-03-02', '2026-05-28', '2026-08-27', '2025-12-01']) {
    add('prescription', 'farida', { issued });
  }
  add('prescription', 'olivia', { issued: '2026-04-16' });
  add('prescription', 'ahmed', { issued: '2026-09-09' });
  // Education.
  add('gcse-certificate', 'ahmed', { issued: '1998-08-20' });
  add('school-report', 'tariq', { year: 2026 });
  add('school-report', 'maryam', { year: 2025 });
  add('school-report', 'maryam', { year: 2026 });
  add('degree-certificate', 'ahmed', {
    issued: '2003-07-12',
    degree: 'Bachelor of Science with Honours',
  });
  add('degree-certificate', 'olivia', {
    issued: '2006-07-14',
    degree: 'Bachelor of Arts with Honours',
  });
  // Warranties: receipts name nobody.
  for (const issued of [
    '2024-01-12',
    '2024-11-29',
    '2025-02-03',
    '2025-06-21',
    '2025-12-27',
    '2026-01-12',
    '2026-04-04',
    '2026-07-18',
    '2026-09-05',
    '2023-10-14',
  ]) {
    add('receipt-guarantee', null, { issued });
  }
  add('extended-warranty', 'ahmed', { issued: '2026-01-03' });
  add('extended-warranty', 'ahmed', { issued: '2024-05-17' });
  add('extended-warranty', 'olivia', { issued: '2025-09-30' });
  add('extended-warranty', 'olivia', { issued: '2023-02-11' });
  // Vehicles, loans, work, the house, wills and certificates.
  add('v5c', 'olivia', {
    plate: 'AV19 RKH',
    first: '2019-03-14',
    model: 'ESTATE 1.5',
    colour: 'SILVER',
  });
  add('v5c', 'ahmed', {
    plate: 'AV22 OJK',
    first: '2022-03-02',
    model: 'HATCH 1.2',
    colour: 'BLUE',
  });
  add('v5c', 'ahmed', {
    plate: 'AV11 TKP',
    first: '2011-09-01',
    model: 'SALOON 1.6',
    colour: 'RED',
  });
  for (const issued of ['2023-12-31', '2024-12-31', '2025-12-31']) {
    add('mortgage-statement', 'ahmed', {
      issued,
      account: '0071 2234 55',
      joint: P.olivia,
      ends: '2049-09-30',
    });
  }
  add('car-finance', 'olivia', { issued: '2025-03-02', plate: 'AV22 OJK' });
  add('employment-terms', 'ahmed', { issued: '2025-01-06' });
  add('employment-terms', 'olivia', { issued: '2019-09-02' });
  add('offer-letter', 'olivia', { issued: '2024-07-29' });
  add('tenancy', 'farida', { issued: '2026-05-01' });
  add('title-register', 'ahmed', { issued: '2023-07-14', bought: '2016-09-30', joint: P.olivia });
  add('will', 'ahmed', { issued: '2024-06-02', spouse: P.olivia });
  add('will', 'olivia', { issued: '2024-06-02', spouse: P.ahmed });
  add('birth-certificate', 'maryam', {
    issued: '2017-08-14',
    father: `Ahmed Raza ${P.ahmed.surname.toUpperCase()}`,
    mother: `${P.olivia.first} Jane ${P.olivia.surname.toUpperCase()}`,
  });
  add('birth-certificate', 'tariq', {
    issued: '2023-05-09',
    father: `Ahmed Raza ${P.ahmed.surname.toUpperCase()}`,
    mother: `${P.olivia.first} Jane ${P.olivia.surname.toUpperCase()}`,
  });
  add('birth-certificate', 'ahmed', {
    issued: '2010-01-18',
    father: `Yusuf ${P.ahmed.surname.toUpperCase()}`,
    mother: `Farida ${P.ahmed.surname.toUpperCase()}`,
  });
  add('marriage-certificate', 'ahmed', { issued: '2010-06-12', spouse: P.olivia, maiden: 'Grant' });
  add('ni-letter', 'tariq', { issued: '2026-02-20' });
  add('residence-permit', 'farida', { issued: '2019-11-30', expires: '2029-11-30' });
  for (const issued of ['2023-03-12', '2024-03-15', '2025-03-14', '2026-03-12']) {
    add('vet-vaccination', 'olivia', { issued });
  }
  for (const issued of ['2025-05-06', '2025-12-02', '2026-08-25']) {
    add('vet-invoice', 'ahmed', { issued });
  }
  // Papers of no kind the vault keeps.
  for (let i = 0; i < 3; i += 1) add('takeaway-menu', null, { n: i });
  for (const [season, issued] of [
    ['Spring 2026', '2026-03-01'],
    ['Summer 2026', '2026-06-01'],
    ['Autumn 2026', '2026-09-01'],
  ]) {
    add('park-newsletter', null, { season, issued });
  }
  add('gym-membership', 'olivia', { issued: '2025-09-01' });
  add('gym-membership', 'ahmed', { issued: '2026-01-05' });
  for (const issued of ['2025-10-02', '2026-03-09', '2026-09-14']) {
    add('school-trip', 'tariq', { issued });
  }
  add('parking-permit', 'ahmed', { expires: '2025-10-31' });
  add('parking-permit', 'ahmed', { expires: '2026-10-31' });
  for (let i = 0; i < 3; i += 1) add('estate-agent-flyer', null, { n: i });
  add('previous-occupant', null, { issued: '2024-02-12' });
  add('previous-occupant', null, { issued: '2025-01-22' });
  add('charity-thanks', 'olivia', { issued: '2025-12-19' });
  add('charity-thanks', 'ahmed', { issued: '2026-05-04' });
  return out;
}

// ------------------------------------------------------------------ folders

/** The folder a family keeps each paper in, and a name for the file. */
function home(item, P) {
  const who = item.who ? P[item.who].name : null;
  const [y, m] = (item.truth.issued ?? item.opts.issued ?? CORPUS_TODAY).split('-');
  const ym = `${y}-${m}`;
  switch (item.paper) {
    case 'passport-uk':
    case 'passport-uk-photocopy':
    case 'passport-pk':
      return [`${who}/Passport`, `passport ${y}`];
    case 'licence-uk':
    case 'licence-summary':
      return [
        `${who}/Driving licence`,
        item.paper === 'licence-uk' ? 'licence' : `licence check ${ym}`,
      ];
    case 'insurance-motor':
      return ['Insurance/Car', `car insurance ${y}`];
    case 'insurance-home':
      return ['Insurance/Home', `home insurance ${y}`];
    case 'insurance-travel':
      return ['Insurance/Travel', `travel ${y}`];
    case 'insurance-pet':
      return ['Insurance/Pet', `Biscuit insurance ${y}`];
    case 'insurance-life':
      return ['Insurance/Life', 'life policy'];
    case 'bank-current':
      return [`Bank/Harbourline ${who}`, `statement ${ym}`];
    case 'bank-savings':
      return ['Bank/Savings', `${who} savings ${y}`];
    case 'credit-card':
      return ['Bank/Credit card', `Lantern ${ym}`];
    case 'bill-energy':
    case 'bill-broadband':
    case 'bill-water':
    case 'bill-mobile':
      return [`Bills/${y}`, `${item.paper.slice(5)} ${ym}`];
    case 'bill-council-tax':
      return ['Bills/Council tax', `council tax ${y}`];
    case 'p60':
      return ['Tax/P60', `P60 ${who} ${item.opts.year}`];
    case 'w2':
      return ['Tax/US', `W2 ${item.opts.year}`];
    case 'tax-calculation':
    case 'tax-return-receipt':
      return [`Tax/${item.opts.year}`, item.paper === 'tax-calculation' ? 'SA302' : 'receipt'];
    case 'gp-letter':
    case 'immunisation-record':
    case 'hospital-letter':
    case 'dental-recall':
      return [`Medical/${who}`, `${item.paper} ${ym}`];
    case 'prescription':
      return [`Medical/${who}/Prescriptions`, `prescription ${ym}`];
    case 'gcse-certificate':
    case 'degree-certificate':
      return [`${who}/Certificates`, item.paper.replace('-certificate', '')];
    case 'school-report':
      return [`School/${who}`, `report ${item.opts.year}`];
    case 'receipt-guarantee':
    case 'extended-warranty':
      return ['Warranties', `${item.paper} ${ym}`];
    case 'v5c':
      return ['Car', `V5C ${item.opts.plate}`];
    case 'mortgage-statement':
      return ['House/Mortgage', `mortgage ${y}`];
    case 'car-finance':
      return ['Car', 'finance agreement'];
    case 'employment-terms':
    case 'offer-letter':
      return [`${who}/Work`, `${item.paper} ${y}`];
    case 'tenancy':
      return [`${who}/Flat`, 'tenancy agreement'];
    case 'title-register':
      return ['House', 'title register'];
    case 'will':
      return ['Wills', `will ${who}`];
    case 'birth-certificate':
      return ['Certificates/Birth', who];
    case 'marriage-certificate':
      return ['Certificates', 'marriage'];
    case 'ni-letter':
      return [who, 'NI number'];
    case 'residence-permit':
      return [`${who}/Immigration`, 'BRP'];
    case 'vet-vaccination':
    case 'vet-invoice':
      return ['Pets/Biscuit', `${item.paper} ${ym}`];
    case 'school-trip':
      return [`School/${who}`, `trip ${ym}`];
    default:
      return ['Letters', `${item.paper} ${ym}`];
  }
}

/** Folders a paper is sometimes put in by mistake. */
const WRONG = [
  'Insurance/Car',
  'Bills/2026',
  'Bills/2025',
  'Tax/P60',
  'Ahmed/Passport',
  'Medical/Olivia',
  'Bank/Savings',
  'Warranties',
  'House',
  'Tariq',
];

// ------------------------------------------------------------------- corpus

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/**
 * The corpus for a seed: every file's place, bytes and truth, sorted by
 * place as a folder is read; and the household it is for.
 */
export function smartCorpus({
  seed = 1,
  owner = 'Olivia',
  surname = 'Khan',
  corpus = 'first',
} = {}) {
  const isSecond = corpus === 'second';
  // The third (0.9.0, the R1 review): held out as the second is.
  const isThird = corpus === 'third';
  const papers = isThird ? PAPERS_3 : isSecond ? PAPERS_2 : PAPERS;
  const homeOf = isThird ? home3 : isSecond ? home2 : home;
  const people = corpusPeople({ owner, surname });
  const P = Object.fromEntries(people.map((p) => [p.key, p]));
  const h = household(surname);
  const pick = randomFor(seed, 'corpus');
  const items = [];
  for (const entry of (isThird ? plan3 : isSecond ? plan2 : plan)(P)) {
    const tpl = papers[entry.paper];
    const key = `${entry.paper}:${entry.who}:${JSON.stringify(entry.opts, (k, v) => (v && v.key ? v.key : v))}`;
    const r = randomFor(seed, key);
    const made = tpl.make(r, h, entry.who ? P[entry.who] : null, entry.opts);
    const scan = r.chance(tpl.scanned);
    const family = r.pick(['sans', 'sans', 'serif', 'serif', 'mono']);
    const looks = scan
      ? made.pages.map(() => scanLook(r, r.chance(0.25) ? 'poor' : 'normal'))
      : null;
    const bytes = scan ? scanPdf(made.pages, family, looks, r) : textPdf(made.pages, family);
    items.push({
      paper: entry.paper,
      who: entry.who,
      opts: entry.opts,
      set: tpl.set,
      mode: scan ? 'scan' : 'text',
      pages: made.pages.length,
      family,
      truth: {
        kind: tpl.kind,
        person: entry.who,
        issued: made.truth.issued ?? null,
        expires: made.truth.expires ?? null,
        number: made.truth.number ?? null,
        issuer: made.truth.issuer ?? null,
      },
      made,
      bytes,
    });
  }

  // Where each is: its own folder, the scanner's, or the wrong one.
  const files = [];
  let scanNo = 1;
  const scanName = () => `Scans/scan${String(1000 + scanNo++).slice(1)}.pdf`;
  const used = new Set();
  const unique = (p) => {
    let at = p;
    for (let n = 2; used.has(at.toLowerCase()); n += 1) at = p.replace(/\.pdf$/, ` (${n}).pdf`);
    used.add(at.toLowerCase());
    return at;
  };
  for (const item of items) {
    const [folder, name] = homeOf(item, P);
    let where = `${folder}/${name}.pdf`;
    let misfiled = false;
    const roll = pick.next();
    if (item.mode === 'scan' && roll < 0.5) where = scanName();
    else if (item.mode === 'text' && roll < 0.08) where = `Downloads/${name}.pdf`;
    else if (roll > 0.92) {
      const wrong = WRONG.filter((w) => w !== folder && !folder.startsWith(`${w}/`));
      where = `${pick.pick(wrong)}/${name}.pdf`;
      misfiled = true;
    }
    files.push({ ...item, path: unique(where), misfiled });
  }

  // Blank pages: an empty PDF page, and two scans of nothing much.
  const blank = (mode, page, name) => {
    const r = randomFor(seed, `blank:${name}`);
    const bytes =
      mode === 'scan'
        ? scanPdf([page], 'sans', [scanLook(r, 'normal')], r)
        : textPdf([page], 'sans');
    files.push({
      paper: 'blank',
      who: null,
      opts: {},
      set: isSecond || isThird ? 'held-out' : 'tune',
      mode,
      pages: 1,
      family: 'sans',
      truth: { kind: null, person: null, issued: null, expires: null, number: null, issuer: null },
      blank: true,
      bytes,
      path: unique(name === 'empty' ? 'blank page.pdf' : scanName()),
      misfiled: false,
    });
  };
  blank('text', new Page(), 'empty');
  blank('scan', new Page(), 'scan');
  const back = new Page();
  back.y = 800;
  back.at(290, '2', { size: 9 });
  blank('scan', back, 'back');

  // Copies: two the same bytes as another, one scanned again.
  const dupPick = randomFor(seed, 'copies');
  const tidy = files.filter((f) => !f.blank && !f.path.startsWith('Scans/'));
  const first = dupPick.pick(tidy.filter((f) => f.mode === 'scan'));
  const second = dupPick.pick(tidy.filter((f) => f.truth.kind === 'utility_bill'));
  files.push({ ...first, path: unique(scanName()), misfiled: false, copyOf: first });
  files.push({
    ...second,
    path: unique(`Downloads/${path.posix.basename(second.path)}`),
    misfiled: false,
    copyOf: second,
  });
  const again = dupPick.pick(tidy.filter((f) => f.mode === 'scan' && f !== first));
  {
    const r = randomFor(seed, `rescan:${again.path}`);
    const looks = again.made.pages.map(() => scanLook(r, 'normal'));
    files.push({
      ...again,
      bytes: scanPdf(again.made.pages, again.family, looks, r),
      path: unique(scanName()),
      misfiled: false,
      rescanOf: again,
    });
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // The later of two the same bytes is the duplicate, as the vault sees them in order.
  const seen = new Map();
  const out = files.map((f) => {
    const hash = sha256(f.bytes);
    const original = seen.get(hash);
    if (!original) seen.set(hash, f.path);
    return {
      path: f.path,
      bytes: f.bytes,
      entry: {
        path: f.path,
        sha256: hash,
        size: f.bytes.length,
        paper: f.paper,
        set: f.set,
        mode: f.mode,
        pages: f.pages,
        font: f.family,
        folder: path.posix.dirname(f.path) === '.' ? null : path.posix.dirname(f.path),
        misfiled: f.misfiled,
        blank: f.blank ?? false,
        duplicate_of: original ?? null,
        rescan_of: f.rescanOf ? f.rescanOf.path : null,
        truth: f.truth,
      },
    };
  });
  return {
    seed,
    corpus,
    today: CORPUS_TODAY,
    household: {
      name: h.name,
      people: people.map((p) => ({ key: p.key, name: p.name, role: p.role })),
    },
    files: out,
  };
}

/** The manifest of a corpus: everything but the bytes. */
export const corpusManifest = (corpus) => ({
  seed: corpus.seed,
  corpus: corpus.corpus,
  today: corpus.today,
  household: corpus.household,
  files: corpus.files.map((f) => f.entry),
});

/** Writes a corpus's files, each in its folder, and manifest.json, under `out`. */
export function writeCorpus(out, corpus) {
  mkdirSync(out, { recursive: true });
  for (const f of corpus.files) {
    const to = path.join(out, ...f.path.split('/'));
    mkdirSync(path.dirname(to), { recursive: true });
    writeFileSync(to, f.bytes);
  }
  writeFileSync(
    path.join(out, 'manifest.json'),
    `${JSON.stringify(corpusManifest(corpus), null, 2)}\n`,
  );
}

// --------------------------------------------------------------------- CLI

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const option = (name, env, fallback) => {
    const at = argv.indexOf(`--${name}`);
    if (at >= 0 && argv[at + 1] !== undefined) return argv[at + 1];
    return process.env[env] ?? fallback;
  };
  const out = option('out', 'FDV_CORPUS_OUT');
  if (!out) {
    console.error('smart-corpus: say where to write it with --out <folder>.');
    process.exit(1);
  }
  const corpus = smartCorpus({
    seed: Number(option('seed', 'FDV_CORPUS_SEED', '1')),
    owner: option('owner', 'FDV_CORPUS_OWNER', 'Olivia'),
    surname: option('surname', 'FDV_CORPUS_SURNAME', 'Khan'),
    corpus: option('corpus', 'FDV_CORPUS', 'first'),
  });
  writeCorpus(out, corpus);
  const scans = corpus.files.filter((f) => f.entry.mode === 'scan').length;
  console.log(
    `smart-corpus: wrote ${corpus.files.length} made-up papers (${scans} scans) and manifest.json to ${out}`,
  );
}
