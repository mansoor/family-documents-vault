// The papers of smart-corpus.mjs: each kind of paper a made-up family keeps,
// written as the paper itself is laid out, with what a person would fill in
// for it (`truth`). Everything is invented — the people, the numbers, the
// addresses and every company, bank, insurer and school (the UK's own
// offices, such as HMPO, DVLA and HMRC, are named as the papers name them).
// Phone numbers are from Ofcom's ranges for drama (01632 960…, 07700 900…);
// National Insurance numbers use the QQ prefix, never issued; NHS numbers
// start 999, never issued.
//
// Each paper is in one of two sets, by its layout: `tune`, the papers the
// vault's rules may be adjusted to read (0.8.0, S5), and `held-out`, written
// as the others were but never looked at while the rules were adjusted. None
// is a copy of 5.37's fixtures (packages/shared/src/testdata).
import { Page } from './smart-corpus-render.mjs';

// -------------------------------------------------------------------- dates

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
/** French month abbreviations, as a UK passport prints them beside the English. */
const FRENCH = [
  'JAN',
  'FEV',
  'MARS',
  'AVR',
  'MAI',
  'JUIN',
  'JUIL',
  'AOUT',
  'SEPT',
  'OCT',
  'NOV',
  'DEC',
];

const parts = (iso) => iso.split('-').map(Number);
const iso = (y, m, d) =>
  `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function addDays(at, n) {
  const [y, m, d] = parts(at);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function addMonths(at, n) {
  const [y, m, d] = parts(at);
  const total = y * 12 + (m - 1) + n;
  const yy = Math.floor(total / 12);
  const mm = (total % 12) + 1;
  return iso(yy, mm, Math.min(d, daysIn(yy, mm)));
}

export const addYears = (at, n) => addMonths(at, 12 * n);

const pad = (n) => String(n).padStart(2, '0');
const ordinal = (n) =>
  `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;

/** A date as a paper writes it. */
export function fmt(at, style) {
  const [y, m, d] = parts(at);
  const month = MONTH_NAMES[m - 1];
  const mon = month.slice(0, 3);
  switch (style) {
    case 'long':
      return `${d} ${month} ${y}`;
    case 'longth':
      return `${ordinal(d)} ${month} ${y}`;
    case 'short':
      return `${pad(d)} ${mon} ${y}`;
    case 'SHORT':
      return `${pad(d)} ${mon.toUpperCase()} ${y}`;
    case 'dashed':
      return `${pad(d)}-${mon}-${y}`;
    case 'us-long':
      return `${month} ${d}, ${y}`;
    case 'slash':
      return `${pad(d)}/${pad(m)}/${y}`;
    case 'us-slash':
      return `${pad(m)}/${pad(d)}/${y}`;
    case 'dots':
      return `${pad(d)}.${pad(m)}.${y}`;
    case 'iso':
      return at;
    case 'passport':
      return `${pad(d)} ${mon.toUpperCase()} /${FRENCH[m - 1]} ${String(y).slice(2)}`;
    case 'month':
      return `${month} ${y}`;
    default:
      throw new Error(`no date style ${style}`);
  }
}

/** One of the styles a UK paper writes a date in. */
export const ukStyle = (r) => r.pick(['long', 'long', 'short', 'slash', 'longth', 'dashed']);

export const money = (r, lo, hi) => {
  const pence = r.int(lo * 100, hi * 100);
  const pounds = Math.floor(pence / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${pounds}.${pad(pence % 100)}`;
};

// -------------------------------------------------------------- the papers

/** The made-up papers' templates, by name. */
export const PAPERS = {};

/**
 * One kind of paper: its kind (null for a paper of no kind the vault
 * keeps), its set, how often it is a scan rather than a PDF with its own
 * words, and how it is made: (random numbers, the household, the person it
 * is for, its options) → { truth, pages, family? }.
 */
function paper(name, kind, set, scanned, make) {
  PAPERS[name] = { name, kind, set, scanned, make };
}

/** The household's address, a line at a time. */
const addressLines = (h) => [h.street, h.town, h.postcode];
const full = (p) => `${p.first} ${p.surname}`;
const formal = (p) => `${p.title} ${p.first} ${p.surname}`;
const upper = (s) => s.toUpperCase();

// ---- passports

/** A passport's machine-readable lines (ICAO 9303, TD3), their check digits right. */
export function mrz(p, number, state, expires) {
  const value = (c) => {
    if (c >= '0' && c <= '9') return Number(c);
    if (c >= 'A' && c <= 'Z') return c.charCodeAt(0) - 55;
    return 0;
  };
  const check = (s) =>
    String([...s].reduce((sum, c, i) => sum + value(c) * [7, 3, 1][i % 3], 0) % 10);
  const names = `${upper(p.surname)}<<${upper([p.first, p.middle].filter(Boolean).join('<'))}`;
  const top = `P<${state}${names}`.padEnd(44, '<').slice(0, 44);
  const yymmdd = (at) => at.slice(2).replace(/-/g, '');
  const num = number.padEnd(9, '<');
  const born = yymmdd(p.born);
  const exp = yymmdd(expires);
  const personal = '<'.repeat(14);
  const composite = `${num}${check(num)}${born}${check(born)}${exp}${check(exp)}${personal}${check(personal)}`;
  const bottom = `${num}${check(num)}${state}${born}${check(born)}${p.sex}${exp}${check(exp)}${personal}${check(personal)}${check(composite)}`;
  return [top, bottom];
}

paper('passport-uk', 'passport', 'tune', 0.85, (r, h, p, o) => {
  const issued = o.issued;
  const expires = addYears(issued, p.child ? 5 : 10);
  const number = `${r.int(5, 6)}${r.digits(8)}`;
  const pg = new Page({ size: 10, top: 80 });
  pg.line('UNITED KINGDOM OF GREAT BRITAIN AND NORTHERN IRELAND', { bold: true });
  pg.line('PASSPORT', { size: 14, bold: true });
  pg.row(
    [
      [56, 'Type/Type'],
      [140, 'Code/Code'],
      [240, 'Passport No./Passeport No.'],
    ],
    { size: 7 },
  );
  pg.row([
    [56, 'P'],
    [140, 'GBR'],
    [240, number],
  ]);
  pg.line('Surname/Nom', { size: 7 });
  pg.line(upper(p.surname));
  pg.line('Given names/Prénoms', { size: 7 });
  pg.line(upper([p.first, p.middle].filter(Boolean).join(' ')));
  pg.line('Nationality/Nationalité', { size: 7 });
  pg.line('BRITISH CITIZEN');
  pg.line('Date of birth/Date de naissance', { size: 7 });
  pg.line(fmt(p.born, 'passport'));
  pg.row(
    [
      [56, 'Sex/Sexe'],
      [140, 'Place of birth/Lieu de naissance'],
    ],
    { size: 7 },
  );
  pg.row([
    [56, p.sex],
    [140, upper(p.birthplace)],
  ]);
  pg.line('Date of issue/Date de délivrance', { size: 7 });
  pg.line(fmt(issued, 'passport'));
  pg.line('Authority/Autorité', { size: 7 });
  pg.line('HMPO');
  pg.line('Date of expiry/Date d’expiration', { size: 7 });
  pg.line(fmt(expires, 'passport'));
  pg.gap(2);
  pg.line(mrz(p, number, 'GBR', expires), { mono: true, size: 11 });
  pg.foot();
  return {
    truth: { issued, expires, number, issuer: 'United Kingdom' },
    pages: [pg],
  };
});

paper('passport-uk-photocopy', 'passport', 'held-out', 0.9, (r, h, p, o) => {
  const issued = o.issued;
  const expires = addYears(issued, p.child ? 5 : 10);
  const number = `${r.int(1, 4)}${r.digits(8)}`;
  const pg = new Page({ size: 11, top: 110, left: 90 });
  pg.line('PASSPORT   UNITED KINGDOM', { size: 13, bold: true });
  pg.gap();
  pg.row([
    [90, 'Passport number'],
    [260, number],
  ]);
  pg.row([
    [90, 'Surname'],
    [260, upper(p.surname)],
  ]);
  pg.row([
    [90, 'Given names'],
    [260, upper(p.first)],
  ]);
  pg.row([
    [90, 'Nationality'],
    [260, 'BRITISH CITIZEN'],
  ]);
  pg.row([
    [90, 'Date of birth'],
    [260, fmt(p.born, 'SHORT')],
  ]);
  pg.row([
    [90, 'Place of birth'],
    [260, upper(p.birthplace)],
  ]);
  pg.row([
    [90, 'Date of issue'],
    [260, fmt(issued, 'SHORT')],
  ]);
  pg.row([
    [90, 'Date of expiry'],
    [260, fmt(expires, 'SHORT')],
  ]);
  pg.row([
    [90, 'Authority'],
    [260, 'HM Passport Office'],
  ]);
  pg.gap(2);
  pg.line(mrz(p, number, 'GBR', expires), { mono: true, size: 10.5 });
  pg.gap(3);
  pg.line('Photocopy of the photo page, kept with the family papers.', { size: 8 });
  pg.foot();
  return { truth: { issued, expires, number, issuer: 'United Kingdom' }, pages: [pg] };
});

paper('passport-pk', 'passport', 'held-out', 0.9, (r, h, p, o) => {
  const issued = o.issued;
  const expires = addDays(addYears(issued, 10), -1);
  const number = `${r.letters(2)}${r.digits(7)}`;
  const pg = new Page({ size: 10, top: 90 });
  pg.line('ISLAMIC REPUBLIC OF PAKISTAN', { size: 13, bold: true });
  pg.line('PASSPORT', { size: 12, bold: true });
  pg.row(
    [
      [56, 'Type'],
      [120, 'Country Code'],
      [230, 'Passport Number'],
    ],
    { size: 7.5 },
  );
  pg.row([
    [56, 'P'],
    [120, 'PAK'],
    [230, number],
  ]);
  pg.line('Surname', { size: 7.5 });
  pg.line(upper(p.surname));
  pg.line('Given Names', { size: 7.5 });
  pg.line(upper(p.first));
  pg.line('Nationality', { size: 7.5 });
  pg.line('PAKISTANI');
  pg.row(
    [
      [56, 'Date of Birth'],
      [230, 'Sex'],
    ],
    { size: 7.5 },
  );
  pg.row([
    [56, fmt(p.born, 'SHORT')],
    [230, p.sex],
  ]);
  pg.row(
    [
      [56, 'Date of Issue'],
      [230, 'Date of Expiry'],
    ],
    { size: 7.5 },
  );
  pg.row([
    [56, fmt(issued, 'SHORT')],
    [230, fmt(expires, 'SHORT')],
  ]);
  pg.line('Issuing Authority', { size: 7.5 });
  pg.line('PAKISTAN');
  pg.gap(2);
  pg.line(mrz(p, number, 'PAK', expires), { mono: true, size: 11 });
  pg.foot();
  return { truth: { issued, expires, number, issuer: 'Pakistan' }, pages: [pg] };
});

// ---- driving licences

/** A UK licence's number: the surname, the date of birth (a woman's month plus 50), initials. */
export function licenceNumber(r, p) {
  const [y, m, d] = parts(p.born);
  const sur = upper(p.surname)
    .replace(/[^A-Z]/g, '')
    .padEnd(5, '9')
    .slice(0, 5);
  const month = p.sex === 'F' ? m + 50 : m;
  const initials = upper(`${p.first[0]}${p.middle?.[0] ?? '9'}`);
  return `${sur}${String(y).charAt(2)}${pad(month)}${pad(d)}${String(y).charAt(3)}${initials}9${r.letters(2)}`;
}

paper('licence-uk', 'drivers_licence', 'tune', 0.9, (r, h, p, o) => {
  const issued = o.issued;
  const expires = addDays(addYears(issued, 10), -1);
  const number = licenceNumber(r, p);
  const pg = new Page({ size: 10.5, top: 100 });
  pg.row(
    [
      [56, 'DRIVING LICENCE'],
      [330, 'UK'],
    ],
    { bold: true, size: 13 },
  );
  pg.line(`1. ${upper(p.surname)}`);
  pg.line(`2. ${upper([p.first, p.middle].filter(Boolean).join(' '))}`);
  pg.line(`3. ${fmt(p.born, 'dots')} UNITED KINGDOM`);
  pg.row([
    [56, `4a. ${fmt(issued, 'dots')}`],
    [200, '4c. DVLA'],
  ]);
  pg.line(`4b. ${fmt(expires, 'dots')}`);
  pg.line(`5. ${number}  ${r.digits(2)}`);
  pg.line(`8. ${upper(addressLines(h).join(', '))}`);
  pg.line('9. AM/A/B1/B/f/k/l/p/q');
  pg.foot();
  return { truth: { issued, expires, number, issuer: 'DVLA' }, pages: [pg] };
});

paper('licence-summary', 'drivers_licence', 'held-out', 0.1, (r, h, p, o) => {
  const issued = o.issued;
  const expires = addDays(addYears(issued, 10), -1);
  const number = licenceNumber(r, p);
  const pg = new Page({ size: 10.5 });
  pg.line('View your driving licence information', { size: 15, bold: true });
  pg.line('Driver and Vehicle Licensing Agency');
  pg.gap();
  pg.line('Personal details', { bold: true, size: 12 });
  pg.row([
    [56, 'Name'],
    [220, `${formal(p)}`],
  ]);
  pg.row([
    [56, 'Date of birth'],
    [220, fmt(p.born, 'long')],
  ]);
  pg.row([
    [56, 'Address'],
    [220, addressLines(h).join(', ')],
  ]);
  pg.gap();
  pg.line('Licence details', { bold: true, size: 12 });
  pg.row([
    [56, 'Driving licence number'],
    [220, number],
  ]);
  pg.row([
    [56, 'Licence status'],
    [220, 'Valid'],
  ]);
  pg.row([
    [56, 'Licence valid from'],
    [220, fmt(issued, 'long')],
  ]);
  pg.row([
    [56, 'Licence valid to'],
    [220, fmt(expires, 'long')],
  ]);
  pg.row([
    [56, 'Photocard expiry date'],
    [220, fmt(expires, 'long')],
  ]);
  pg.gap();
  pg.line('Vehicles you can drive', { bold: true, size: 12 });
  pg.line(['Category B   Cars', 'Category AM   Mopeds', 'Penalty points: 0']);
  pg.line(`Summary generated on ${fmt(o.printed ?? h.today, 'long')}`, { size: 8 });
  pg.foot();
  return { truth: { issued, expires, number, issuer: 'DVLA' }, pages: [pg] };
});

// ---- insurance

paper('insurance-motor', 'insurance_policy', 'tune', 0.4, (r, h, p, o) => {
  const issued = o.issued;
  const expires = addDays(addYears(issued, 1), -1);
  const number = `GFM ${r.digits(7)}`;
  const plate = o.plate;
  const pg = new Page({ size: 10 });
  pg.line('GREYFRIARS INSURANCE', { size: 16, bold: true });
  pg.line('Certificate of Motor Insurance', { size: 13, bold: true });
  pg.row([
    [56, `Certificate number: GF-${r.digits(8)}`],
    [330, `Policy number: ${number}`],
  ]);
  pg.gap();
  pg.line(`1. Registration mark of vehicle: ${plate}`);
  pg.line(`2. Name of policyholder: ${formal(p)}`);
  pg.line(`3. Effective date of the commencement of insurance: 00:01 on ${fmt(issued, 'long')}`);
  pg.line(`4. Date of expiry of insurance: 23:59 on ${fmt(expires, 'long')}`);
  pg.line('5. Persons or classes of persons entitled to drive:');
  pg.line(['   The policyholder.', `   ${o.second ? full(o.second) : 'No other drivers'}.`]);
  pg.line('6. Limitations as to use: social, domestic and pleasure purposes and commuting.');
  pg.gap();
  pg.line([
    'I hereby certify that the policy to which this certificate relates satisfies the',
    'requirements of the relevant law applicable in Great Britain.',
  ]);
  pg.line('Authorised insurer: Greyfriars Insurance plc');
  pg.foot();
  return {
    truth: { issued, expires, number, issuer: 'Greyfriars Insurance' },
    pages: [pg],
  };
});

paper('insurance-home', 'insurance_policy', 'tune', 0.2, (r, h, p, o) => {
  const issued = o.issued;
  const expires = addYears(issued, 1);
  const number = `WH/${r.digits(7)}`;
  const style = ukStyle(r);
  const pg = new Page({ size: 10.5 });
  pg.line('Wren Home Insurance', { size: 16, bold: true });
  pg.line('Home Insurance Policy Schedule', { size: 13 });
  pg.gap();
  pg.row([
    [56, 'Policyholder'],
    [220, formal(p)],
  ]);
  pg.row([
    [56, 'Address insured'],
    [220, addressLines(h).join(', ')],
  ]);
  pg.row([
    [56, 'Policy number'],
    [220, number],
  ]);
  pg.row([
    [56, 'Start date'],
    [220, fmt(issued, style)],
  ]);
  pg.row([
    [56, 'Renewal date'],
    [220, fmt(expires, style)],
  ]);
  pg.gap();
  pg.line('Your cover', { bold: true });
  pg.row([
    [56, 'Buildings cover'],
    [220, `£${money(r, 300000, 500000)}`],
  ]);
  pg.row([
    [56, 'Contents cover'],
    [220, `£${money(r, 40000, 80000)}`],
  ]);
  pg.row([
    [56, 'Excess'],
    [220, '£100.00'],
  ]);
  pg.row([
    [56, 'Annual premium'],
    [220, `£${money(r, 210, 480)}`],
  ]);
  pg.foot();
  return { truth: { issued, expires, number, issuer: 'Wren Home Insurance' }, pages: [pg] };
});

paper('insurance-travel', 'insurance_policy', 'held-out', 0.1, (r, h, p, o) => {
  const issued = o.issued;
  const expires = addDays(addYears(issued, 1), -1);
  const number = `HMT-${r.digits(6)}`;
  const pg = new Page({ size: 10.5 });
  pg.line('Harbourside Mutual', { size: 16, bold: true });
  pg.line('Annual Multi-Trip Travel Insurance', { size: 13 });
  pg.line('Your policy summary');
  pg.gap();
  pg.line(`Lead traveller: ${full(p)}`);
  pg.line(`Other travellers: ${o.others.map(full).join(', ')}`);
  pg.line(`Policy reference: ${number}`);
  pg.line(`Your cover runs from ${fmt(issued, 'long')} until ${fmt(expires, 'long')}.`);
  pg.line('Area: Europe, including the UK');
  pg.gap();
  pg.line(['Medical expenses up to £10,000,000', 'Cancellation up to £3,000 a person']);
  pg.line('Baggage up to £1,500 a person, single item limit £300');
  pg.foot();
  return { truth: { issued, expires, number, issuer: 'Harbourside Mutual' }, pages: [pg] };
});

paper('insurance-pet', 'insurance_policy', 'held-out', 0.3, (r, h, p, o) => {
  const issued = o.issued;
  const expires = addDays(addYears(issued, 1), -1);
  const number = `PB${r.digits(8)}`;
  const pg = new Page({ size: 10.5 });
  pg.line('Pebble Pet Insurance', { size: 16, bold: true });
  pg.line('Your certificate of insurance', { size: 13 });
  pg.gap();
  pg.row([
    [56, 'Policyholder'],
    [220, `${p.title} ${p.first.charAt(0)} ${p.surname}`],
  ]);
  pg.row([
    [56, 'Policy number'],
    [220, number],
  ]);
  pg.row([
    [56, "Pet's name"],
    [220, 'Biscuit'],
  ]);
  pg.row([
    [56, 'Species'],
    [220, 'Cat'],
  ]);
  pg.row([
    [56, 'Policy start date'],
    [220, fmt(issued, 'slash')],
  ]);
  pg.row([
    [56, 'Policy end date'],
    [220, fmt(expires, 'slash')],
  ]);
  pg.row([
    [56, 'Vet fees cover'],
    [220, '£4,000 a year'],
  ]);
  pg.row([
    [56, 'Excess'],
    [220, '£99 a condition'],
  ]);
  pg.foot();
  return { truth: { issued, expires, number, issuer: 'Pebble Pet Insurance' }, pages: [pg] };
});

paper('insurance-life', 'insurance_policy', 'held-out', 0.2, (r, h, p, o) => {
  const issued = o.issued;
  const expires = addYears(issued, 25);
  const number = `WA-${r.digits(9)}`;
  const pg = new Page({ size: 10.5 });
  pg.line('Wolds Assurance', { size: 16, bold: true });
  pg.line('Level Term Life Insurance: Policy Schedule', { size: 13 });
  pg.gap();
  pg.line(`Policy number: ${number}`);
  pg.line(`Life insured: ${full(p)}`);
  pg.line(`Date of birth: ${fmt(p.born, 'long')}`);
  pg.line(`Policy start date: ${fmt(issued, 'long')}`);
  pg.line(`Policy end date: ${fmt(expires, 'long')}`);
  pg.line(`Sum assured: £${money(r, 150000, 300000)}`);
  pg.line(`Monthly premium: £${money(r, 12, 40)}`);
  pg.gap();
  pg.line('The sum assured is paid if the life insured dies before the policy end date.');
  pg.foot();
  return { truth: { issued, expires, number, issuer: 'Wolds Assurance' }, pages: [pg] };
});

// ---- bank statements

paper('bank-current', 'bank_statement', 'tune', 0.15, (r, h, p, o) => {
  const end = o.issued;
  const start = addDays(addMonths(end, -1), 1);
  const number = o.account;
  const pg = new Page({ size: 9.5, top: 60 });
  pg.line('HARBOURLINE BANK', { size: 16, bold: true });
  pg.line('Current Account Statement', { size: 12 });
  pg.gap();
  pg.row([
    [56, `${p.title} ${p.first} ${p.middle?.charAt(0) ?? ''} ${p.surname}`.replace(/  +/g, ' ')],
    [330, 'Statement date'],
    [440, fmt(end, 'long')],
  ]);
  pg.row([
    [56, h.street],
    [330, 'Account number'],
    [440, number],
  ]);
  pg.row([
    [56, h.town],
    [330, 'Sort code'],
    [440, '30-91-57'],
  ]);
  pg.row([[56, h.postcode]]);
  pg.gap();
  pg.line(`Statement period ${fmt(start, 'long')} to ${fmt(end, 'long')}`);
  let balance = r.int(400, 3000) + r.int(0, 99) / 100;
  pg.row([
    [56, 'Opening balance'],
    [220, `£${balance.toFixed(2)}`],
  ]);
  const rows = [];
  const payees = [
    ['BRIGHTWATER ENERGY DD', -1],
    ['LUMEN FIBRE DD', -1],
    ['NORTHFIELD BS MORTGAGE', -1],
    ['TESSELL SUPERMARKET', -1],
    ['CORVID LOGISTICS SALARY', 1],
    ['ASHBY VALE BC COUNCIL TAX', -1],
    ['CARD PAYMENT MILLHOUSE CAFE', -1],
    ['TRANSFER TO SAVINGS', -1],
  ];
  let paidIn = 0;
  let paidOut = 0;
  for (let i = 0; i < r.int(7, 12); i += 1) {
    const [what, sign] = r.pick(payees);
    const amount =
      sign > 0 ? r.int(1800, 3200) + r.int(0, 99) / 100 : r.int(4, 300) + r.int(0, 99) / 100;
    balance += sign * amount;
    if (sign > 0) paidIn += amount;
    else paidOut += amount;
    rows.push([addDays(start, r.int(0, 27)), what, sign, amount]);
  }
  rows.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  pg.row([
    [56, 'Money in'],
    [220, `£${paidIn.toFixed(2)}`],
  ]);
  pg.row([
    [56, 'Money out'],
    [220, `£${paidOut.toFixed(2)}`],
  ]);
  pg.row([
    [56, 'Closing balance'],
    [220, `£${balance.toFixed(2)}`],
  ]);
  pg.gap();
  pg.row(
    [
      [56, 'Date'],
      [120, 'Description'],
      [340, 'Paid out'],
      [410, 'Paid in'],
      [480, 'Balance'],
    ],
    { bold: true },
  );
  let running = balance - rows.reduce((s, x) => s + x[2] * x[3], 0);
  for (const [at, what, sign, amount] of rows) {
    running += sign * amount;
    pg.row([
      [56, fmt(at, 'short').slice(0, 6)],
      [120, what],
      [340, sign < 0 ? amount.toFixed(2) : ''],
      [410, sign > 0 ? amount.toFixed(2) : ''],
      [480, running.toFixed(2)],
    ]);
  }
  const pages = [pg];
  if (o.twoPages) {
    const more = new Page({ size: 9.5 });
    more.line('Important information about your account', { bold: true });
    more.line([
      'Harbourline Bank is covered by the Financial Services Compensation Scheme.',
      'If you think a payment on this statement is wrong, call us on 01632 960 118.',
      'Overdraft interest is charged at 19.9% EAR on any arranged overdraft.',
    ]);
    more.foot();
    pages.push(more);
  }
  pg.foot();
  return { truth: { issued: end, expires: null, number, issuer: 'Harbourline Bank' }, pages };
});

paper('bank-savings', 'bank_statement', 'held-out', 0.2, (r, h, p, o) => {
  const end = o.issued;
  const start = addDays(addYears(end, -1), 1);
  const number = `${r.digits(4)} ${r.digits(4)}`;
  const opening = r.int(800, 6000);
  const interest = Math.round(opening * 0.031 * 100) / 100;
  const pg = new Page({ size: 10.5 });
  pg.line('Kestrel Savings', { size: 16, bold: true });
  pg.line(o.junior ? 'Junior ISA: annual statement' : 'Easy Access Saver: annual statement', {
    size: 12,
  });
  pg.gap();
  pg.line(`Account holder: ${p.child ? full(p) : formal(p)}`);
  if (p.child) pg.line(`Registered contact: ${formal(o.parent)}`);
  pg.line(`Account no. ${number}`);
  pg.line(`Date of statement: ${fmt(end, 'long')}`);
  pg.line(`Period covered: ${fmt(start, 'long')} to ${fmt(end, 'long')}`);
  pg.gap();
  pg.row([
    [56, `Balance on ${fmt(start, 'long')}`],
    [330, `£${opening.toFixed(2)}`],
  ]);
  pg.row([
    [56, 'Interest paid'],
    [330, `£${interest.toFixed(2)}`],
  ]);
  pg.row([
    [56, `Balance on ${fmt(end, 'long')}`],
    [330, `£${(opening + interest).toFixed(2)}`],
  ]);
  pg.line('Your interest rate is 3.10% AER (variable).');
  pg.foot();
  return { truth: { issued: end, expires: null, number, issuer: 'Kestrel Savings' }, pages: [pg] };
});

paper('credit-card', 'credit_card_statement', 'held-out', 0.15, (r, h, p, o) => {
  const issued = o.issued;
  const due = addDays(issued, 25);
  const pg = new Page({ size: 10 });
  pg.line('Lantern Card', { size: 16, bold: true });
  pg.line('Your Lantern credit card statement', { size: 12 });
  pg.gap();
  pg.line([formal(p), ...addressLines(h)]);
  pg.gap();
  pg.row([
    [56, 'Statement date'],
    [220, fmt(issued, 'long')],
  ]);
  pg.row([
    [56, 'Card number ending'],
    [220, r.digits(4)],
  ]);
  const prev = money(r, 100, 900);
  pg.row([
    [56, 'Previous balance'],
    [220, `£${prev}`],
  ]);
  pg.row([
    [56, 'Payments received'],
    [220, `£${prev}`],
  ]);
  pg.row([
    [56, 'New balance'],
    [220, `£${money(r, 80, 1200)}`],
  ]);
  pg.row([
    [56, 'Minimum payment'],
    [220, '£25.00'],
  ]);
  pg.row([
    [56, 'Payment due'],
    [220, fmt(due, 'long')],
  ]);
  pg.row([
    [56, 'Credit limit'],
    [220, '£4,500.00'],
  ]);
  pg.foot();
  return { truth: { issued, expires: due, number: null, issuer: 'Lantern Card' }, pages: [pg] };
});

// ---- bills

paper('bill-energy', 'utility_bill', 'tune', 0.25, (r, h, p, o) => {
  const issued = o.issued;
  const due = addDays(issued, r.int(14, 21));
  const fuel = o.fuel ?? 'electricity';
  const style = ukStyle(r);
  const amount = money(r, 38, 190);
  const pg = new Page({ size: 10 });
  pg.line('BRIGHTWATER ENERGY', { size: 17, bold: true });
  pg.line(`Your ${fuel} bill`, { size: 12 });
  pg.row([
    [56, 'Account number'],
    [180, o.account],
    [330, 'Bill date'],
    [420, fmt(issued, style)],
  ]);
  pg.gap();
  pg.line([formal(p), ...addressLines(h)]);
  pg.gap();
  const from = addMonths(issued, -1);
  pg.line(`Billing period ${fmt(from, style)} to ${fmt(addDays(issued, -1), style)}`);
  pg.row([
    [56, fuel === 'gas' ? 'Gas used' : 'Electricity used'],
    [260, `${r.int(150, 900)} kWh`],
  ]);
  pg.row([
    [56, 'Standing charge'],
    [260, `${r.int(30, 60)} days at 53.35p`],
  ]);
  pg.row([
    [56, 'Total charges'],
    [260, `£${amount}`],
  ]);
  pg.gap();
  if (o.directDebit) {
    pg.line(`We'll collect £${amount} by Direct Debit on or just after ${fmt(due, style)}.`);
  } else {
    pg.row([
      [56, 'Amount due'],
      [260, `£${amount}`],
    ]);
    pg.row([
      [56, 'Payment due by'],
      [260, fmt(due, style)],
    ]);
  }
  pg.gap();
  pg.line('Questions about your bill? Call 01632 960 220.', { size: 8.5 });
  pg.foot();
  return {
    truth: { issued, expires: due, number: o.account, issuer: 'Brightwater Energy' },
    pages: [pg],
  };
});

paper('bill-broadband', 'utility_bill', 'tune', 0.1, (r, h, p, o) => {
  const issued = o.issued;
  const due = addDays(issued, 14);
  const number = o.account;
  const pg = new Page({ size: 10 });
  pg.line('Lumen Fibre', { size: 18, bold: true });
  pg.line('Your bill', { size: 12 });
  pg.gap();
  pg.line([formal(p), ...addressLines(h)]);
  pg.gap();
  pg.row([
    [56, 'Account number'],
    [200, number],
  ]);
  pg.row([
    [56, 'Invoice date'],
    [200, fmt(issued, 'slash')],
  ]);
  pg.row([
    [56, 'Due date'],
    [200, fmt(due, 'slash')],
  ]);
  pg.gap();
  pg.row([
    [56, 'Full Fibre 500 broadband'],
    [380, '£32.00'],
  ]);
  pg.row([
    [56, 'Landline calls'],
    [380, `£${money(r, 0, 9)}`],
  ]);
  pg.row([
    [56, 'Total to pay'],
    [380, `£${money(r, 32, 42)}`],
  ]);
  pg.foot();
  return { truth: { issued, expires: due, number, issuer: 'Lumen Fibre' }, pages: [pg] };
});

paper('bill-water', 'utility_bill', 'held-out', 0.3, (r, h, p, o) => {
  const issued = o.issued;
  const due = addDays(issued, 30);
  const number = `${r.digits(3)} ${r.digits(4)} ${r.digits(3)}`;
  const pg = new Page({ size: 10.5 });
  pg.line('Ashvale Water', { size: 17, bold: true });
  pg.line(
    `Your water and sewerage bill ${parts(issued)[0]}/${String(parts(issued)[0] + 1).slice(2)}`,
  );
  pg.gap();
  pg.line([formal(p), ...addressLines(h)]);
  pg.gap();
  pg.line(`Customer reference: ${number}`);
  pg.line(`Bill date: ${fmt(issued, 'long')}`);
  pg.gap();
  pg.row([
    [56, 'Water supply'],
    [330, `£${money(r, 180, 260)}`],
  ]);
  pg.row([
    [56, 'Sewerage'],
    [330, `£${money(r, 200, 300)}`],
  ]);
  const total = money(r, 380, 560);
  pg.row([
    [56, 'Total to pay'],
    [330, `£${total}`],
  ]);
  pg.gap();
  pg.line(`Please pay £${total} by ${fmt(due, 'long')}, or set up instalments online.`);
  pg.foot();
  return { truth: { issued, expires: due, number, issuer: 'Ashvale Water' }, pages: [pg] };
});

paper('bill-council-tax', 'utility_bill', 'held-out', 0.5, (r, h, p, o) => {
  const issued = o.issued;
  const first = addDays(issued, r.int(20, 30));
  const y = parts(first)[0];
  const number = `${r.digits(8)}`;
  const pg = new Page({ size: 10 });
  pg.line('Ashby Vale Borough Council', { size: 16, bold: true });
  pg.line(`Council Tax Bill ${y}/${String(y + 1).slice(2)}`, { size: 12 });
  pg.gap();
  pg.line([formal(p), ...addressLines(h)]);
  pg.gap();
  pg.line(`Account reference: ${number}`);
  pg.line(`Date of issue: ${fmt(issued, 'long')}`);
  pg.line('Property band: C');
  const annual = r.int(1650, 2050) + r.int(0, 99) / 100;
  pg.line(`Annual charge: £${annual.toFixed(2)}`);
  pg.gap();
  pg.line('Instalments', { bold: true });
  pg.line(`First instalment due: ${fmt(first, 'long')}  £${(annual / 10).toFixed(2)}`);
  pg.line(`then 9 instalments of £${(annual / 10).toFixed(2)} on the 1st of each month.`);
  pg.foot();
  return {
    truth: { issued, expires: first, number, issuer: 'Ashby Vale Borough Council' },
    pages: [pg],
  };
});

paper('bill-mobile', 'utility_bill', 'held-out', 0.05, (r, h, p, o) => {
  const issued = o.issued;
  const due = addDays(issued, 14);
  const pg = new Page({ size: 10 });
  pg.line('Kite Mobile', { size: 17, bold: true });
  pg.line('Your monthly bill', { size: 12 });
  pg.gap();
  pg.row([
    [56, 'Name'],
    [200, full(p)],
  ]);
  pg.row([
    [56, 'Account number'],
    [200, o.account],
  ]);
  pg.row([
    [56, 'Bill date'],
    [200, fmt(issued, 'long')],
  ]);
  pg.row([
    [56, 'Mobile number'],
    [200, `07700 900${r.digits(3)}`],
  ]);
  pg.gap();
  const amount = money(r, 12, 30);
  pg.row([
    [56, 'Plan: 20GB SIM only'],
    [380, '£12.00'],
  ]);
  pg.row([
    [56, 'Amount due'],
    [380, `£${amount}`],
  ]);
  pg.line(`We will take £${amount} by Direct Debit on ${fmt(due, 'long')}.`);
  pg.foot();
  return {
    truth: { issued, expires: due, number: o.account, issuer: 'Kite Mobile' },
    pages: [pg],
  };
});

// ---- tax

paper('p60', 'tax_form', 'tune', 0.5, (r, h, p, o) => {
  const year = o.year;
  const pg = new Page({ size: 9.5 });
  pg.line('P60 End of Year Certificate', { size: 15, bold: true });
  pg.line(`Tax year to 5 April ${year}`);
  pg.line('To the employee: please keep this certificate in a safe place.', { size: 8.5 });
  pg.gap();
  pg.line("Employee's details", { bold: true });
  pg.row([
    [56, 'Surname'],
    [140, upper(p.surname)],
    [300, 'Forenames or initials'],
    [420, upper([p.first, p.middle].filter(Boolean).join(' '))],
  ]);
  pg.row([
    [56, 'National Insurance number'],
    [200, p.ni],
    [300, 'Works/payroll number'],
    [420, r.digits(5)],
  ]);
  pg.gap();
  pg.line('Pay and Income Tax details', { bold: true });
  pg.row([
    [200, 'Pay'],
    [330, 'Tax deducted'],
  ]);
  pg.row([
    [56, 'In this employment'],
    [200, `£${money(r, 28000, 62000)}`],
    [330, `£${money(r, 3000, 11000)}`],
  ]);
  pg.row([
    [56, 'Final tax code'],
    [200, '1257L'],
  ]);
  pg.gap();
  pg.line('Employer name and address', { bold: true });
  pg.line([o.employer, 'Unit 4, Harrow Park, Ashby Vale AV2 9LP']);
  pg.line(`Employer PAYE reference ${r.digits(3)}/CL${r.digits(5)}`);
  pg.foot();
  return { truth: { issued: null, expires: null, number: null, issuer: o.employer }, pages: [pg] };
});

paper('w2', 'tax_form', 'held-out', 0.5, (r, h, p, o) => {
  const pg = new Page({ size: 9 });
  pg.line(`Form W-2 Wage and Tax Statement ${o.year}`, { size: 13, bold: true });
  pg.line('Department of the Treasury - Internal Revenue Service', { size: 8 });
  pg.gap();
  pg.line(`a Employee's social security number   XXX-XX-${r.digits(4)}`);
  pg.line(`b Employer identification number (EIN)   00-${r.digits(7)}`);
  pg.line("c Employer's name, address, and ZIP code");
  pg.line(['   Bayline Analytics Inc', '   200 Harbor Way, Portland, OR 97201']);
  pg.line("e Employee's first name and initial   Last name");
  pg.line(`   ${p.first} ${p.middle?.charAt(0) ?? ''}   ${p.surname}`);
  pg.gap();
  pg.row([
    [56, '1 Wages, tips, other compensation'],
    [300, money(r, 60000, 90000)],
  ]);
  pg.row([
    [56, '2 Federal income tax withheld'],
    [300, money(r, 8000, 14000)],
  ]);
  pg.row([
    [56, '3 Social security wages'],
    [300, money(r, 60000, 90000)],
  ]);
  pg.row([
    [56, '17 State income tax'],
    [300, money(r, 3000, 6000)],
  ]);
  pg.foot();
  return {
    truth: { issued: null, expires: null, number: null, issuer: 'Bayline Analytics Inc' },
    pages: [pg],
  };
});

paper('tax-calculation', 'tax_return', 'tune', 0.3, (r, h, p, o) => {
  const year = o.year;
  const issued = o.issued;
  const pg = new Page({ size: 10 });
  pg.line('HM Revenue & Customs', { size: 14, bold: true });
  pg.line('Self Assessment: Tax calculation (SA302)', { size: 12 });
  pg.line(`Tax year 6 April ${year - 1} to 5 April ${year}`);
  pg.gap();
  pg.line([formal(p), ...addressLines(h)]);
  pg.gap();
  pg.line(`Unique Taxpayer Reference (UTR) ${r.digits(5)} ${r.digits(5)}`);
  pg.line(`Issue date: ${fmt(issued, 'long')}`);
  pg.gap();
  pg.row([
    [56, 'Profit from self-employment'],
    [360, `£${money(r, 8000, 30000)}`],
  ]);
  pg.row([
    [56, 'Personal allowance'],
    [360, '£12,570.00'],
  ]);
  pg.row([
    [56, 'Total tax due'],
    [360, `£${money(r, 300, 4000)}`],
  ]);
  pg.foot();
  return { truth: { issued, expires: null, number: null, issuer: 'HMRC' }, pages: [pg] };
});

paper('tax-return-receipt', 'tax_return', 'held-out', 0.2, (r, h, p, o) => {
  const issued = o.issued;
  const pg = new Page({ size: 10.5 });
  pg.line('HM Revenue & Customs', { size: 14, bold: true });
  pg.line('Your Self Assessment tax return has been received', { size: 12 });
  pg.gap();
  pg.line(`Name: ${full(p)}`);
  pg.line(`Tax return: SA100 for the year ended 5 April ${o.year}`);
  pg.line(`Submission receipt reference: ${r.letters(4)}${r.digits(8)}`);
  pg.line(`Received on ${fmt(issued, 'long')} at ${r.int(9, 21)}:${pad(r.int(0, 59))}`);
  pg.gap();
  pg.line('Keep this receipt for your records. You do not need to send it to us.');
  pg.foot();
  return { truth: { issued, expires: null, number: null, issuer: 'HMRC' }, pages: [pg] };
});

// ---- medical

const GP = ['Dr Helen Marsh', 'Dr Kofi Mensah', 'Dr Priya Raman'];

paper('gp-letter', 'medical_record', 'tune', 0.6, (r, h, p, o) => {
  const issued = o.issued;
  const style = ukStyle(r);
  const about = r.pick([
    [
      'Re: Your recent blood test',
      'I am pleased to tell you that your blood test results are within the normal range.',
    ],
    [
      'Re: Your asthma review',
      'Thank you for coming to your asthma review. Please continue your inhaler as before.',
    ],
    [
      'Re: Referral to physiotherapy',
      'I have referred you to the physiotherapy service, who will write to you.',
    ],
    [
      'Re: Your flu vaccination',
      'Our records show you are due a flu vaccination this autumn. Please book at reception.',
    ],
  ]);
  const pg = new Page({ size: 10.5 });
  pg.line('ASHBY VALE MEDICAL PRACTICE', { size: 15, bold: true });
  pg.line(['Elm Road Surgery, Ashby Vale AV4 2DN', 'Telephone 01632 960 412'], { size: 9 });
  pg.gap();
  pg.line(`Date: ${fmt(issued, style)}`);
  pg.gap();
  pg.line([formal(p), ...addressLines(h)]);
  pg.gap();
  pg.line(`NHS number: ${p.nhs}`);
  pg.gap();
  pg.line(`Dear ${p.title} ${p.surname},`);
  pg.line(about[0], { bold: true });
  pg.line(about[1]);
  pg.line('If you have any questions, please contact the surgery.');
  pg.gap();
  pg.line(['Yours sincerely,', '', r.pick(GP), 'GP Partner']);
  pg.foot();
  return {
    truth: { issued, expires: null, number: null, issuer: 'Ashby Vale Medical Practice' },
    pages: [pg],
  };
});

paper('immunisation-record', 'medical_record', 'tune', 0.7, (r, h, p) => {
  const pg = new Page({ size: 10 });
  pg.line('Ashby Vale Community Health', { size: 14, bold: true });
  pg.line('Childhood Immunisation Record', { size: 12 });
  pg.gap();
  pg.row([
    [56, `Name: ${full(p)}`],
    [330, `Date of birth: ${fmt(p.born, 'slash')}`],
  ]);
  pg.line(`NHS number: ${p.nhs}`);
  pg.gap();
  pg.row(
    [
      [56, 'Vaccine'],
      [260, 'Date given'],
      [380, 'Batch'],
    ],
    { bold: true },
  );
  for (const [vaccine, weeks] of [
    ['6-in-1 (1st dose)', 8],
    ['6-in-1 (2nd dose)', 12],
    ['6-in-1 (3rd dose)', 16],
    ['MMR (1st dose)', 56],
    ['Pre-school booster', 170],
    ['MMR (2nd dose)', 172],
  ]) {
    pg.row([
      [56, vaccine],
      [260, fmt(addDays(p.born, weeks * 7 + r.int(0, 6)), 'slash')],
      [380, `${r.letters(2)}${r.digits(4)}`],
    ]);
  }
  pg.foot();
  return {
    truth: { issued: null, expires: null, number: null, issuer: 'Ashby Vale Community Health' },
    pages: [pg],
  };
});

paper('hospital-letter', 'medical_record', 'held-out', 0.6, (r, h, p, o) => {
  const issued = o.issued;
  const pg = new Page({ size: 10.5 });
  pg.line('Ashby Vale General Hospital', { size: 15, bold: true });
  pg.line(p.child ? 'Paediatric Outpatients' : 'Cardiology Outpatients', { size: 11 });
  pg.line(`Our ref: AVH/OP/${r.digits(6)}`, { size: 9 });
  pg.gap();
  pg.line(fmt(issued, 'long'));
  pg.gap();
  if (p.child) pg.line('To the parent or guardian of');
  pg.line([full(p), ...addressLines(h)]);
  pg.gap();
  pg.line(`Hospital number: ${r.letters(1)}${r.digits(7)}`);
  pg.gap();
  pg.line(p.child ? 'Dear Parent,' : `Dear ${p.title} ${p.surname},`);
  pg.line(
    `${p.child ? `${p.first} has` : 'You have'} been referred to our clinic. The appointment is on ${fmt(addDays(issued, 21), 'long')} at 10:30.`,
  );
  pg.line('Please bring a list of any medicines with you.');
  pg.gap();
  pg.line(['Yours sincerely,', '', 'Mr S Iyer', 'Consultant']);
  pg.foot();
  return {
    truth: { issued, expires: null, number: null, issuer: 'Ashby Vale General Hospital' },
    pages: [pg],
  };
});

paper('dental-recall', 'medical_record', 'held-out', 0.5, (r, h, p, o) => {
  const issued = o.issued;
  const pg = new Page({ size: 10.5 });
  pg.line('Riverside Dental Care', { size: 15, bold: true });
  pg.line('3 Mill Lane, Ashby Vale AV4 1RT  |  01632 960 377', { size: 9 });
  pg.gap();
  pg.line(fmt(issued, 'longth'));
  pg.gap();
  pg.line([
    p.child ? `Parent of ${full(p)}` : `${p.title} ${p.first.charAt(0)} ${p.surname}`,
    ...addressLines(h),
  ]);
  pg.gap();
  pg.line('Your check-up is due', { bold: true });
  pg.line(`Dear ${p.child ? 'Parent' : `${p.title} ${p.surname}`},`);
  pg.line('Our records show that a dental check-up is now due. Please call us to book.');
  pg.gap();
  pg.line(['With best wishes,', 'The Riverside Dental Care team']);
  pg.foot();
  return {
    truth: { issued, expires: null, number: null, issuer: 'Riverside Dental Care' },
    pages: [pg],
  };
});

paper('prescription', 'prescription', 'held-out', 0.7, (r, h, p, o) => {
  const issued = o.issued;
  const expires = addDays(addYears(issued, 1), -1);
  const drug = r.pick([
    ['Amlodipine 5mg tablets', 'Take ONE tablet each morning', 28],
    ['Atorvastatin 20mg tablets', 'Take ONE tablet at night', 28],
    ['Salbutamol 100mcg inhaler', 'Inhale TWO puffs when required', 1],
    ['Omeprazole 20mg capsules', 'Take ONE capsule daily before food', 56],
  ]);
  const pg = new Page({ size: 10.5 });
  pg.line('Ashby Vale Pharmacy', { size: 15, bold: true });
  pg.line('Prescription collection receipt');
  pg.gap();
  pg.line(`Patient: ${full(p)}`);
  pg.line(`Prescribed by: ${r.pick(GP)}`);
  pg.line(`Item: ${drug[0]}    Qty: ${drug[2]}`);
  pg.line(`Directions: ${drug[1]}`);
  pg.line(`Date dispensed: ${fmt(issued, 'long')}`);
  pg.line(`Do not use after: ${fmt(expires, 'long')}`);
  pg.foot();
  return {
    truth: { issued, expires, number: null, issuer: 'Ashby Vale Pharmacy' },
    pages: [pg],
  };
});

// ---- education

paper('gcse-certificate', 'diploma', 'tune', 0.8, (r, h, p, o) => {
  const issued = o.issued;
  const pg = new Page({ size: 11, top: 110, left: 80 });
  pg.line('NORTHWICK EXAMINATIONS BOARD', { size: 15, bold: true });
  pg.line('General Certificate of Secondary Education', { size: 13 });
  pg.gap();
  pg.line('This is to certify that');
  pg.line(upper([p.first, p.middle, p.surname].filter(Boolean).join(' ')), { bold: true });
  pg.line('has been awarded the following grades');
  pg.gap();
  for (const s of ['English Language', 'Mathematics', 'Double Science', 'Geography', 'French']) {
    pg.row([
      [80, s],
      [320, r.pick(['A*', 'A', 'B', 'C'])],
    ]);
  }
  pg.gap();
  pg.line(`Date of award: ${fmt(issued, 'long')}`);
  pg.line(`Candidate number ${r.digits(4)}   Centre number ${r.digits(5)}`);
  pg.foot();
  return {
    truth: { issued, expires: null, number: null, issuer: 'Northwick Examinations Board' },
    pages: [pg],
  };
});

paper('school-report', 'school_report', 'held-out', 0.5, (r, h, p, o) => {
  const year = o.year;
  const school = p.age < 11 ? 'Larchwood Primary School' : 'Ashby Vale Academy';
  const pg = new Page({ size: 10 });
  pg.line(school, { size: 15, bold: true });
  pg.line(`End of Year Report ${year - 1}/${String(year).slice(2)}`, { size: 12 });
  pg.gap();
  pg.row([
    [56, `Pupil: ${full(p)}`],
    [330, `Year ${p.age < 11 ? 4 : 10}`],
  ]);
  pg.line(`Attendance: ${r.int(91, 99)}%`);
  pg.gap();
  for (const s of ['English', 'Mathematics', 'Science', 'History', 'Art']) {
    pg.row([
      [56, s],
      [
        200,
        r.pick([
          'Working at the expected standard',
          'Working above the expected standard',
          'Working towards the expected standard',
        ]),
      ],
    ]);
  }
  pg.gap();
  pg.line(`${p.first} is a kind and thoughtful member of the class.`);
  pg.line(['Class teacher: Mrs J Ellery', 'Headteacher: Mr P Danvers']);
  pg.foot();
  return { truth: { issued: null, expires: null, number: null, issuer: school }, pages: [pg] };
});

paper('degree-certificate', 'diploma', 'held-out', 0.8, (r, h, p, o) => {
  const issued = o.issued;
  const pg = new Page({ size: 12, top: 140, left: 90 });
  pg.line('UNIVERSITY OF NORTHWICK', { size: 17, bold: true });
  pg.gap();
  pg.line('This is to certify that');
  pg.line([p.first, p.middle, p.surname].filter(Boolean).join(' '), { size: 15, bold: true });
  pg.line('having fulfilled the requirements of the University');
  pg.line(`was admitted to the degree of ${o.degree}`);
  pg.line(`on ${fmt(issued, 'longth')}`);
  pg.gap(2);
  pg.line('Vice-Chancellor', { size: 9 });
  pg.foot();
  return {
    truth: { issued, expires: null, number: null, issuer: 'University of Northwick' },
    pages: [pg],
  };
});

// ---- warranties

paper('receipt-guarantee', 'warranty', 'tune', 0.5, (r, h, p, o) => {
  const issued = o.issued;
  const years = r.pick([1, 2, 2, 3]);
  const expires = addDays(addYears(issued, years), -1);
  const item = r.pick([
    ['Calder WM8 washing machine', 'WM8-1400'],
    ['Polar 55" television', 'PT55-U4'],
    ['Fenwick cordless vacuum', 'FV-30'],
    ['Brisk 4-slice toaster', 'BT4-S'],
  ]);
  const serial = `${r.letters(3)}${r.digits(7)}`;
  const pg = new Page({ size: 9.5, left: 150, top: 80 });
  pg.line('DIXWELL ELECTRICALS', { size: 13, bold: true });
  pg.line(['Ashby Vale Retail Park', 'VAT receipt']);
  pg.gap();
  pg.line(`Date of purchase: ${fmt(issued, 'slash')}   Till 3   Receipt no ${r.digits(6)}`);
  pg.line(item[0]);
  pg.line(`Model: ${item[1]}   Serial: ${serial}`);
  pg.line(`Total £${money(r, 25, 900)}   Paid by card`);
  pg.gap();
  pg.line(`Your product comes with a ${years} year manufacturer's guarantee.`);
  pg.line(`Guarantee expires: ${fmt(expires, 'slash')}`);
  pg.line('Keep this receipt as proof of purchase.');
  pg.foot();
  return {
    truth: { issued, expires, number: null, issuer: 'Dixwell Electricals' },
    pages: [pg],
  };
});

paper('extended-warranty', 'warranty', 'held-out', 0.3, (r, h, p, o) => {
  const issued = o.issued;
  const expires = addDays(addYears(issued, 3), -1);
  const pg = new Page({ size: 10.5 });
  pg.line('Homestead Appliance Care', { size: 15, bold: true });
  pg.line('Extended Warranty Certificate', { size: 12 });
  pg.gap();
  pg.line(`Customer: ${formal(p)}`);
  pg.line(
    `Product: ${r.pick(['Fridge freezer', 'Dishwasher', 'Tumble dryer'])}   Model: ${r.letters(2)}-${r.digits(2)}`,
  );
  pg.line(`Serial number: ${r.letters(2)}${r.digits(8)}`);
  pg.line(`Certificate number: HAC-${r.digits(7)}`);
  pg.line(`Cover from ${fmt(issued, 'long')} to ${fmt(expires, 'long')}`);
  pg.gap();
  pg.line('Parts and labour are covered for breakdowns during the period of cover.');
  pg.foot();
  return {
    truth: { issued, expires, number: null, issuer: 'Homestead Appliance Care' },
    pages: [pg],
  };
});

// ---- vehicles, loans, work, property, wills, certificates

paper('v5c', 'vehicle_registration', 'tune', 0.85, (r, h, p, o) => {
  const ref = `${r.digits(4)} ${r.digits(4)} ${r.digits(3)}`;
  const pg = new Page({ size: 10 });
  pg.line('Vehicle Registration Certificate V5C', { size: 14, bold: true });
  pg.line('Driver and Vehicle Licensing Agency', { size: 9 });
  pg.gap();
  pg.row([
    [56, 'Registration number'],
    [230, o.plate],
  ]);
  pg.row([
    [56, 'Document reference number'],
    [230, ref],
  ]);
  pg.gap();
  pg.line('Registered keeper', { bold: true });
  pg.line([formal(p), ...addressLines(h)]);
  pg.gap();
  pg.row([
    [56, 'Date of first registration'],
    [230, fmt(o.first, 'slash')],
  ]);
  pg.row([
    [56, 'Make'],
    [230, 'CALDER'],
  ]);
  pg.row([
    [56, 'Model'],
    [230, o.model],
  ]);
  pg.row([
    [56, 'Colour'],
    [230, o.colour],
  ]);
  pg.row([
    [56, 'Fuel type'],
    [230, 'PETROL'],
  ]);
  pg.row([
    [56, 'VIN/Chassis/Frame no.'],
    [230, `SCA${r.letters(3)}${r.digits(11)}`],
  ]);
  pg.foot();
  return {
    truth: { issued: null, expires: null, number: ref, issuer: 'DVLA' },
    pages: [pg],
  };
});

paper('mortgage-statement', 'loan', 'tune', 0.2, (r, h, p, o) => {
  const issued = o.issued;
  const number = o.account;
  const pg = new Page({ size: 10.5 });
  pg.line('Northfield Building Society', { size: 16, bold: true });
  pg.line('Annual Mortgage Statement', { size: 12 });
  pg.gap();
  pg.line([`${formal(p)} and ${formal(o.joint)}`, ...addressLines(h)]);
  pg.gap();
  pg.line(`Mortgage account number ${number}`);
  pg.line(`Statement date ${fmt(issued, 'long')}`);
  pg.gap();
  pg.line(`Outstanding balance on ${fmt(issued, 'long')} £${money(r, 160000, 200000)}`);
  pg.line('Interest rate 4.29% fixed');
  pg.line(`Monthly payment £${money(r, 950, 1250)}`);
  pg.line(`Your mortgage term ends on ${fmt(o.ends, 'long')}`);
  pg.foot();
  return {
    truth: { issued, expires: o.ends, number, issuer: 'Northfield Building Society' },
    pages: [pg],
  };
});

paper('car-finance', 'loan', 'held-out', 0.4, (r, h, p, o) => {
  const issued = o.issued;
  const first = addMonths(issued, 1);
  const last = addMonths(first, 47);
  const number = `QMF-${r.digits(7)}`;
  const pg = new Page({ size: 10 });
  pg.line('Quayside Motor Finance', { size: 15, bold: true });
  pg.line('Hire Purchase Agreement regulated by the Consumer Credit Act 1974', { size: 10 });
  pg.gap();
  pg.line(`Agreement number ${number}`);
  pg.line(`Borrower: ${formal(p)}`);
  pg.line(`Vehicle: Calder Hatch 1.2   Registration ${o.plate}`);
  pg.line(`Amount of credit £${money(r, 7000, 14000)}`);
  pg.line('APR 8.9%');
  pg.line('Number of monthly payments 48');
  pg.line(`First payment date ${fmt(first, 'short')}`);
  pg.line(`Final payment date ${fmt(last, 'short')}`);
  pg.line(`Date of agreement ${fmt(issued, 'short')}`);
  pg.foot();
  return {
    truth: { issued, expires: last, number, issuer: 'Quayside Motor Finance' },
    pages: [pg],
  };
});

paper('employment-terms', 'employment_contract', 'tune', 0.3, (r, h, p, o) => {
  const issued = o.issued;
  const expires = addDays(addYears(issued, 2), -1);
  const pg = new Page({ size: 10.5 });
  pg.line('Corvid Logistics Ltd', { size: 15, bold: true });
  pg.line('Statement of Main Terms of Employment', { size: 12 });
  pg.gap();
  pg.line(`Employee: ${full(p)}`);
  pg.line('Job title: Operations Analyst');
  pg.line(`Start date: ${fmt(issued, 'long')}`);
  pg.line(`This is a fixed-term contract. End date: ${fmt(expires, 'long')}.`);
  pg.line(`Salary: £${money(r, 38000, 52000)} per annum`);
  pg.line('Hours of work: 37.5 a week, Monday to Friday');
  pg.line('Holiday entitlement: 25 days plus bank holidays');
  pg.line('Notice period: one month');
  pg.foot();
  return {
    truth: { issued, expires, number: null, issuer: 'Corvid Logistics Ltd' },
    pages: [pg],
  };
});

paper('offer-letter', 'employment_contract', 'held-out', 0.3, (r, h, p, o) => {
  const issued = o.issued;
  const start = addDays(issued, r.int(20, 40));
  const pg = new Page({ size: 10.5 });
  pg.line('Tamsin & Pryor LLP', { size: 15, bold: true });
  pg.line('Solicitors  |  8 Guild Street, Ashby Vale AV1 3GS', { size: 9 });
  pg.gap();
  pg.line(fmt(issued, 'long'));
  pg.line([formal(p), ...addressLines(h)]);
  pg.gap();
  pg.line(`Dear ${p.first},`);
  pg.line('Offer of employment', { bold: true });
  pg.line('We are delighted to offer you the position of Office Manager on a permanent basis.');
  pg.line(`Your start date will be ${fmt(start, 'long')}. Your annual salary will be £36,500.`);
  pg.line('There is a probationary period of six months, and a notice period of one month.');
  pg.gap();
  pg.line(['Yours sincerely,', '', 'Grace Tamsin', 'Senior Partner']);
  pg.foot();
  return {
    truth: { issued: start, expires: null, number: null, issuer: 'Tamsin & Pryor LLP' },
    pages: [pg],
  };
});

paper('tenancy', 'property_deed', 'held-out', 0.6, (r, h, p, o) => {
  const issued = o.issued;
  const expires = addDays(addYears(issued, 1), -1);
  const pg = new Page({ size: 10.5 });
  pg.line('ASSURED SHORTHOLD TENANCY AGREEMENT', { size: 14, bold: true });
  pg.gap();
  pg.line('The Landlord: Mr Peter Hendry, of 22 Quarry Road, Ashby Vale AV3 8QR');
  pg.line(`The Tenant: ${formal(p)}`);
  pg.line('The Property: Flat 2, 9 Mill Lane, Ashby Vale AV4 1RT');
  pg.line(
    `The Term: 12 months, commencing on ${fmt(issued, 'long')} and ending on ${fmt(expires, 'long')}`,
  );
  pg.line('The Rent: £725 per calendar month, payable in advance on the 1st of each month');
  pg.line('The Deposit: £835, protected with an approved scheme');
  pg.gap();
  pg.line([
    'Signed by the Landlord ....................',
    `Signed by the Tenant ....................`,
  ]);
  const more = new Page({ size: 10 });
  more.line('Terms and conditions', { bold: true });
  more.line([
    '1. The Tenant will pay the Rent on the days and in the manner set out above.',
    '2. The Tenant will keep the interior of the Property in good and clean condition.',
    '3. The Landlord will keep the structure and exterior of the Property in repair.',
    '4. Either party may end the tenancy at the end of the Term by giving notice in writing.',
  ]);
  more.foot();
  pg.foot();
  return {
    truth: { issued, expires, number: null, issuer: null },
    pages: [pg, more],
  };
});

paper('title-register', 'property_deed', 'tune', 0.2, (r, h, p, o) => {
  const pg = new Page({ size: 10 });
  pg.line('HM Land Registry', { size: 14, bold: true });
  pg.line('Official copy of register of title', { size: 12 });
  pg.gap();
  pg.line(`Title number AV${r.digits(6)}`);
  pg.line(`Edition date ${fmt(o.issued, 'dots')}`);
  pg.gap();
  pg.line('A: Property Register', { bold: true });
  pg.line(
    `The Freehold land shown edged with red on the plan of the above Title, being ${h.street}, ${h.town} (${h.postcode}).`,
  );
  pg.line('B: Proprietorship Register', { bold: true });
  pg.line(
    `PROPRIETOR: ${upper([p.first, p.middle, p.surname].filter(Boolean).join(' '))} and ${upper([o.joint.first, o.joint.middle, o.joint.surname].filter(Boolean).join(' '))} of ${upper(h.street)}, ${upper(h.town)}.`,
  );
  pg.line(
    `The price stated to have been paid on ${fmt(o.bought, 'long')} was £${money(r, 240000, 320000)}.`,
  );
  pg.line('C: Charges Register', { bold: true });
  pg.line(
    `REGISTERED CHARGE dated ${fmt(o.bought, 'long')} in favour of Northfield Building Society.`,
  );
  pg.foot();
  return {
    truth: { issued: null, expires: null, number: null, issuer: 'HM Land Registry' },
    pages: [pg],
  };
});

paper('will', 'will', 'held-out', 0.6, (r, h, p, o) => {
  const pg = new Page({ size: 11, top: 90 });
  pg.line(`LAST WILL AND TESTAMENT OF ${upper(full(p))}`, { size: 13, bold: true });
  pg.gap();
  pg.line([
    `I ${upper(full(p))} of ${h.street}, ${h.town} hereby revoke all former wills`,
    'and testamentary dispositions made by me and declare this to be my last will.',
  ]);
  pg.line([
    `1. I appoint my ${p.sex === 'F' ? 'husband' : 'wife'} ${full(o.spouse)} to be the executor of this will.`,
    `2. I give all my estate to my ${p.sex === 'F' ? 'husband' : 'wife'} absolutely.`,
    '3. If my spouse dies before me, I give my estate to my children in equal shares.',
  ]);
  pg.gap();
  pg.line(`Signed by the testator on ${fmt(o.issued, 'longth')} in our presence.`);
  pg.line(['Witness 1: Mr Peter Hendry', 'Witness 2: Ms Ruth Allardyce']);
  pg.foot();
  return { truth: { issued: o.issued, expires: null, number: null, issuer: null }, pages: [pg] };
});

paper('birth-certificate', 'birth_certificate', 'tune', 0.8, (r, h, p, o) => {
  const pg = new Page({ size: 10, top: 90 });
  pg.line('CERTIFIED COPY OF AN ENTRY OF BIRTH', { size: 13, bold: true });
  pg.line('GIVEN AT THE GENERAL REGISTER OFFICE', { size: 9 });
  pg.gap();
  pg.line(`Registration district  ${p.birthplace}`);
  pg.gap();
  pg.line(`1. Date and place of birth: ${fmt(p.born, 'long')}, ${p.birthplace} General Hospital`);
  pg.line(
    `2. Name and surname: ${p.first} ${p.middle ?? ''} ${upper(p.surname)}`.replace(/  +/g, ' '),
  );
  pg.line(`3. Sex: ${p.sex === 'F' ? 'Female' : 'Male'}`);
  pg.line(`4. Name and surname of father: ${o.father}`);
  pg.line(`6. Name and surname of mother: ${o.mother}`);
  pg.line(`9. Date of registration: ${fmt(addDays(p.born, 24), 'long')}`);
  pg.line('10. Signature of registrar: J. Whitlow, Registrar');
  pg.gap();
  pg.line(`Certified to be a true copy. Given on ${fmt(o.issued, 'long')}.`);
  pg.foot();
  return {
    truth: { issued: o.issued, expires: null, number: null, issuer: 'General Register Office' },
    pages: [pg],
  };
});

paper('marriage-certificate', 'marriage_certificate', 'held-out', 0.8, (r, h, p, o) => {
  const pg = new Page({ size: 10, top: 90 });
  pg.line('CERTIFIED COPY OF AN ENTRY OF MARRIAGE', { size: 13, bold: true });
  pg.line('GIVEN AT THE GENERAL REGISTER OFFICE', { size: 9 });
  pg.gap();
  pg.line(`Marriage solemnized at Ashby Vale Register Office on ${fmt(o.issued, 'long')}`);
  pg.row(
    [
      [56, 'Name and surname'],
      [230, 'Age'],
      [270, 'Condition'],
      [340, 'Occupation'],
    ],
    { bold: true },
  );
  pg.row([
    [56, `${p.first} ${p.middle ?? ''} ${p.surname}`.replace(/  +/g, ' ')],
    [230, '30'],
    [270, 'Bachelor'],
    [340, 'Analyst'],
  ]);
  pg.row([
    [56, `${o.spouse.first} ${o.spouse.middle} ${o.maiden}`],
    [230, '27'],
    [270, 'Spinster'],
    [340, 'Teacher'],
  ]);
  pg.gap();
  pg.line('Witnesses: Peter Hendry, Ruth Allardyce');
  pg.foot();
  return {
    truth: { issued: o.issued, expires: null, number: null, issuer: 'General Register Office' },
    pages: [pg],
  };
});

paper('ni-letter', 'national_id', 'held-out', 0.4, (r, h, p, o) => {
  const pg = new Page({ size: 10.5 });
  pg.line('HM Revenue & Customs', { size: 14, bold: true });
  pg.line(fmt(o.issued, 'long'));
  pg.gap();
  pg.line([full(p), ...addressLines(h)]);
  pg.gap();
  pg.line('Your National Insurance number', { bold: true });
  pg.line(`Dear ${p.first} ${p.surname},`);
  pg.line(`Your National Insurance number is ${p.ni}. Keep this letter safe.`);
  pg.line('You will need your number when you start work or claim benefits.');
  pg.foot();
  return {
    truth: { issued: o.issued, expires: null, number: p.ni, issuer: 'HMRC' },
    pages: [pg],
  };
});

paper('residence-permit', 'visa', 'tune', 0.9, (r, h, p, o) => {
  const issued = o.issued;
  const expires = o.expires;
  const number = `ZU${r.digits(7)}`;
  const pg = new Page({ size: 10, top: 110 });
  pg.row(
    [
      [56, 'RESIDENCE PERMIT'],
      [300, 'UNITED KINGDOM'],
    ],
    { size: 13, bold: true },
  );
  pg.line(`Name: ${upper(full(p))}`);
  pg.row([
    [56, 'Valid from'],
    [200, 'Valid until'],
  ]);
  pg.row([
    [56, fmt(issued, 'dots')],
    [200, fmt(expires, 'dots')],
  ]);
  pg.line(`Card number: ${number}`);
  pg.line('Type of permit: INDEFINITE LEAVE');
  pg.line('Remarks: NO TIME LIMIT');
  pg.foot();
  return {
    truth: { issued, expires, number, issuer: 'United Kingdom' },
    pages: [pg],
  };
});

// ---- pets

paper('vet-vaccination', 'pet_record', 'tune', 0.7, (r, h, p, o) => {
  const issued = o.issued;
  const due = addYears(issued, 1);
  const pg = new Page({ size: 10 });
  pg.line('Willowbank Veterinary Surgery', { size: 15, bold: true });
  pg.line('Vaccination Certificate', { size: 12 });
  pg.gap();
  pg.row([
    [56, "Pet's name: Biscuit"],
    [260, 'Species: Feline'],
    [400, 'Breed: Domestic shorthair'],
  ]);
  pg.line(`Microchip: 9810${r.digits(11)}`);
  pg.line(`Owner: ${formal(p)}`);
  pg.gap();
  pg.row(
    [
      [56, 'Vaccine'],
      [250, 'Date given'],
      [380, 'Next vaccination due'],
    ],
    { bold: true },
  );
  pg.row([
    [56, 'Feline enteritis and flu'],
    [250, fmt(issued, 'slash')],
    [380, fmt(due, 'slash')],
  ]);
  pg.gap();
  pg.line('Vet: Ms R Okonkwo MRCVS');
  pg.foot();
  return {
    truth: { issued, expires: due, number: null, issuer: 'Willowbank Veterinary Surgery' },
    pages: [pg],
  };
});

paper('vet-invoice', 'pet_record', 'held-out', 0.4, (r, h, p, o) => {
  const pg = new Page({ size: 10 });
  pg.line('Willowbank Veterinary Surgery', { size: 15, bold: true });
  pg.line('Invoice', { size: 12 });
  pg.gap();
  pg.line(`Client: ${formal(p)}`);
  pg.line('Patient: Biscuit (cat)');
  pg.line(`Date: ${fmt(o.issued, 'slash')}`);
  pg.gap();
  pg.row([
    [56, 'Consultation'],
    [380, '£48.00'],
  ]);
  pg.row([
    [56, r.pick(['Flea and worm treatment', 'Dental check', 'Blood test'])],
    [380, `£${money(r, 20, 90)}`],
  ]);
  pg.row([
    [56, 'Total paid'],
    [380, `£${money(r, 68, 140)}`],
  ]);
  pg.foot();
  return {
    truth: {
      issued: o.issued,
      expires: null,
      number: null,
      issuer: 'Willowbank Veterinary Surgery',
    },
    pages: [pg],
  };
});

// ---- papers of no kind the vault keeps

paper('takeaway-menu', null, 'tune', 0.4, (r) => {
  const pg = new Page({ size: 11 });
  pg.line('GOLDEN SPOON', { size: 22, bold: true });
  pg.line('Indian and Bangladeshi takeaway', { size: 13 });
  pg.line('Free delivery on orders over £15  |  Call 01632 960 555');
  pg.gap();
  for (const [dish, price] of [
    ['Chicken tikka masala', '8.95'],
    ['Lamb rogan josh', '9.50'],
    ['Vegetable biryani', '7.95'],
    ['Pilau rice', '2.95'],
    ['Garlic naan', '2.75'],
  ]) {
    pg.row([
      [56, dish],
      [330, `£${price}`],
    ]);
  }
  pg.gap();
  pg.line(`Open every day 5pm to 11pm. Offer code SPOON${r.digits(2)} for 10% off.`);
  pg.foot();
  return { truth: { issued: null, expires: null, number: null, issuer: null }, pages: [pg] };
});

paper('park-newsletter', null, 'tune', 0.3, (r, h, p, o) => {
  const pg = new Page({ size: 10.5 });
  pg.line('Friends of Ashby Vale Park', { size: 16, bold: true });
  pg.line(`Newsletter, ${o.season}`, { size: 12 });
  pg.gap();
  pg.line([
    'Thank you to everyone who came to the summer litter pick. Forty bags were',
    'collected and the pond is clearer than it has been for years.',
  ]);
  pg.gap();
  pg.line('Dates for your diary', { bold: true });
  pg.line(`Bulb planting: ${fmt(addDays(o.issued, 20), 'long')}, 10am at the bandstand`);
  pg.line(`Annual meeting: ${fmt(addDays(o.issued, 41), 'long')}, 7pm at the library`);
  pg.foot();
  return { truth: { issued: null, expires: null, number: null, issuer: null }, pages: [pg] };
});

paper('gym-membership', null, 'tune', 0.1, (r, h, p, o) => {
  const pg = new Page({ size: 10.5 });
  pg.line('Ashby Leisure', { size: 16, bold: true });
  pg.line('Welcome to Ashby Leisure', { size: 12 });
  pg.gap();
  pg.line(`Member: ${full(p)}`);
  pg.line(`Membership number: AL${r.digits(6)}`);
  pg.line('Membership: Off-peak, pool and gym');
  pg.line(`Start date: ${fmt(o.issued, 'long')}`);
  pg.line(`Your membership renews on ${fmt(addYears(o.issued, 1), 'long')}.`);
  pg.line('Monthly fee: £24.50, collected by Direct Debit.');
  pg.foot();
  return { truth: { issued: null, expires: null, number: null, issuer: null }, pages: [pg] };
});

paper('school-trip', null, 'held-out', 0.5, (r, h, p, o) => {
  const pg = new Page({ size: 10.5 });
  pg.line('Ashby Vale Academy', { size: 15, bold: true });
  pg.line(fmt(o.issued, 'long'));
  pg.gap();
  pg.line('Dear Parents and Carers,');
  pg.line(`Year 10 Geography field trip: ${full(p)}`, { bold: true });
  pg.line([
    `The trip to the Westmere coast is on ${fmt(addDays(o.issued, 30), 'long')}. The cost is £45,`,
    `which can be paid online. Please return the consent slip by ${fmt(addDays(o.issued, 10), 'long')}.`,
  ]);
  pg.gap();
  pg.line(['Yours faithfully,', 'Mr D Asante, Head of Geography']);
  pg.foot();
  return { truth: { issued: null, expires: null, number: null, issuer: null }, pages: [pg] };
});

paper('parking-permit', null, 'held-out', 0.4, (r, h, p, o) => {
  const pg = new Page({ size: 10.5 });
  pg.line('Ashby Vale Borough Council', { size: 15, bold: true });
  pg.line('Residents’ parking: renew your permit', { size: 12 });
  pg.gap();
  pg.line([formal(p), ...addressLines(h)]);
  pg.gap();
  pg.line(`Permit number: RP${r.digits(6)}   Zone E`);
  pg.line(`Your permit expires on ${fmt(o.expires, 'long')}. Renew online before then.`);
  pg.line('A first permit costs £60 a year.');
  pg.foot();
  return { truth: { issued: null, expires: null, number: null, issuer: null }, pages: [pg] };
});

paper('estate-agent-flyer', null, 'held-out', 0.3, (r, h) => {
  const pg = new Page({ size: 11 });
  pg.line('Quill & Barrow Estate Agents', { size: 16, bold: true });
  pg.line(`Thinking of selling your home on ${h.street.replace(/^\d+ /, '')}?`, { size: 13 });
  pg.gap();
  pg.line([
    `A three-bedroom property near you sold for £${money(r, 280000, 360000)} last month.`,
    'We have buyers waiting for homes like yours. Book a free valuation today.',
    'Call 01632 960 701 or visit our office on Guild Street.',
  ]);
  pg.foot();
  return { truth: { issued: null, expires: null, number: null, issuer: null }, pages: [pg] };
});

paper('previous-occupant', null, 'held-out', 0.2, (r, h, p, o) => {
  const pg = new Page({ size: 10.5 });
  pg.line('Harbourline Bank', { size: 15, bold: true });
  pg.line(fmt(o.issued, 'long'));
  pg.gap();
  pg.line(['Mr Daniel Okafor', ...addressLines(h)]);
  pg.gap();
  pg.line('Changes to your account terms', { bold: true });
  pg.line('Dear Mr Okafor,');
  pg.line([
    'We are writing to tell you about changes to the terms of your account, which',
    'take effect in two months. You do not need to do anything.',
  ]);
  pg.foot();
  return { truth: { issued: null, expires: null, number: null, issuer: null }, pages: [pg] };
});

paper('charity-thanks', null, 'held-out', 0.5, (r, h, p, o) => {
  const pg = new Page({ size: 10.5 });
  pg.line('Westmere Hospice', { size: 15, bold: true });
  pg.line(fmt(o.issued, 'long'));
  pg.gap();
  pg.line([`${p.title} ${p.surname}`, ...addressLines(h)]);
  pg.gap();
  pg.line(`Dear ${p.title} ${p.surname},`);
  pg.line([
    'Thank you so much for your kind gift. It will help us care for families',
    'across Westmere at the time they need it most.',
  ]);
  pg.line(['With warm thanks,', 'The fundraising team']);
  pg.foot();
  return { truth: { issued: null, expires: null, number: null, issuer: null }, pages: [pg] };
});
