#!/usr/bin/env node
// The reading model's training papers (0.9.0, R2): made-up household papers
// of every built-in kind, and papers of no kind, as text — what the vault's
// small reading model (scripts/train-reading-model.mjs) learns kinds from.
//
//   node scripts/reading-model-corpus.mjs --out <file.jsonl> [--seed 1] [--per 300]
//
// writes one JSON line a paper: its kind (a built-in kind's key, or `none`),
// its text, and how it was made. The same seed gives the same lines.
//
// Its own templates, senders, names, towns, wording, order and lengths,
// never copied from the Smart exit's corpora (smart-corpus*.mjs), the scan
// set (scan-corpus.mjs) or the 5.37 fixtures. Its first version did not hold
// to that: it was written knowing the held-out papers the docs list as
// missed (a building society's account summary, repeat slips, a health
// centre, a music exam, order confirmations, a breakdown card, a vet's
// booster reminder…) and shared phrases with them. The R2 review took every
// such template, phrase and sender out. A test
// (apps/api/src/reading-model-corpus.test.ts) checks that no paper of any
// held-out set is in it, exactly or nearly, and that it shares no
// distinctive phrase with them that the tune split does not have. Nothing
// here is a real person, company or number; public offices (HMRC, the DVLA,
// HM Passport Office) are named as any paper from them names them.
//
// Scans are read by OCR, so a share of the papers is spoilt as OCR spoils a
// page R3's scans are drawn from (scan-corpus.mjs's causes, as text): letters
// confused (rn for m, 1 for l, 0 for O), words lost, two columns run
// together, a turned page read as nonsense, a page cut short.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- random

/** A seeded random source (mulberry32 over an FNV-1a hash of the seed and a label). */
export function seeded(seed, label = '') {
  let h = 2166136261;
  for (const c of `${seed}:${label}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  let a = h || 1;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    shuffle: (arr) => {
      const out = [...arr];
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
    some: (arr, lo, hi) => r.shuffle(arr).slice(0, r.int(lo, Math.min(hi, arr.length))),
  };
  return r;
}

// ---------------------------------------------------------------- the made-up world

const FIRST = [
  'Daniel',
  'Hannah',
  'Priya',
  'Tomasz',
  'Leah',
  'Callum',
  'Nadia',
  'Owen',
  'Imogen',
  'Kofi',
  'Bethany',
  'Rhys',
  'Anika',
  'Felix',
  'Esther',
  'Marcus',
  'Yusuf',
  'Ruby',
  'Declan',
  'Sana',
  'Harriet',
  'Joel',
  'Mei',
  'Patrick',
  'Zara',
  'Gareth',
  'Ines',
  'Arjun',
  'Bronwen',
  'Luca',
  'Theo',
  'Amara',
  'Stefan',
  'Niamh',
  'Victor',
  'Layla',
  'Hugo',
  'Freya',
  'Idris',
  'Lydia',
  'Ravi',
  'Agnes',
  'Kieran',
  'Odette',
  'Samir',
  'Tilly',
  'Wesley',
  'Yasmin',
  'Bram',
  'Cerys',
];
const MIDDLE = [
  'Louise',
  'James',
  'Marie',
  'Alan',
  'Rose',
  'Kumar',
  'Elliot',
  'Anne',
  'Lee',
  'Joy',
  'Paul',
  'Mae',
];
const SURNAME = [
  'Ferrow',
  'Okafor',
  'Lindqvist',
  'Pemberton',
  'Achebe',
  'Marsh',
  'Dabrowski',
  'Haldane',
  'Iqbal',
  'Quayle',
  'Rowntree',
  'Sandoval',
  'Tremlett',
  'Underhill',
  'Vance',
  'Whitcombe',
  'Yardley',
  'Abernethy',
  'Blackwood',
  'Castellano',
  'Dunmore',
  'Everett',
  'Fairbairn',
  'Gallagher',
  'Hollis',
  'Jardine',
  'Kowalczyk',
  'Lockhart',
  'Mbeki',
  'Nightingale',
  'Osei',
  'Prentice',
  'Ramsay',
  'Sowerby',
  'Thackeray',
  'Varga',
  'Winslow',
  'Zielinski',
  'Brennan',
  'Choudry',
];
const TOWN_A = [
  'Brack',
  'Calder',
  'Fen',
  'Hollow',
  'Lark',
  'Mill',
  'Oak',
  'Red',
  'Stan',
  'Thorn',
  'Elder',
  'Gran',
  'Kel',
  'Morrow',
  'Pen',
  'Ros',
  'Sal',
  'Tam',
  'Wy',
  'Dun',
];
const TOWN_B = [
  'ford',
  'ley',
  'bridge',
  'wick',
  'ham',
  'stow',
  'combe',
  'field',
  'by',
  'mouth',
  'thorpe',
  'well',
  'den',
  'holt',
];
const STREET_A = [
  'Mill',
  'Station',
  'Church',
  'Orchard',
  'Meadow',
  'Victoria',
  'Albion',
  'Larch',
  'Rowan',
  'Quarry',
  'Brook',
  'Chapel',
  'Kestrel',
  'Hazel',
  'Linden',
  'Foundry',
];
const STREET_B = [
  'Road',
  'Lane',
  'Street',
  'Close',
  'Avenue',
  'Way',
  'Crescent',
  'Gardens',
  'Terrace',
  'Drive',
  'Court',
  'Rise',
];
const WORDS = [
  'Harbour',
  'Summit',
  'Beacon',
  'Kingfisher',
  'Granite',
  'Oakleaf',
  'Lumen',
  'Vantage',
  'Bluebell',
  'Pinnacle',
  'Riverside',
  'Silverline',
  'Heron',
  'Cobalt',
  'Thistle',
  'Northstar',
  'Evergreen',
  'Tidewater',
  'Foxglove',
  'Ironbridge',
  'Saltmarsh',
];
const LETTERS = 'ABCDEFGHJKLMNPRSTUVWXYZ';
const MONTHS = [
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

const town = (r) => `${r.pick(TOWN_A)}${r.pick(TOWN_B)}`;
const digits = (r, n) => Array.from({ length: n }, () => r.int(0, 9)).join('');
const letters = (r, n) => Array.from({ length: n }, () => r.pick(LETTERS.split(''))).join('');
const postcode = (r) => `${letters(r, 2)}${r.int(1, 29)} ${r.int(1, 9)}${letters(r, 2)}`;
const zip = (r) => digits(r, 5);
const phone = (r) =>
  r.pick([
    `0${r.int(1100, 1999)} ${digits(r, 6)}`,
    `0${r.int(300, 345)} ${digits(r, 3)} ${digits(r, 4)}`,
    `0800 ${digits(r, 3)} ${digits(r, 4)}`,
    `(${r.int(201, 989)}) ${digits(r, 3)}-${digits(r, 4)}`,
  ]);
const web = (r, name) =>
  `www.${name
    .toLowerCase()
    .replace(/[^a-z]+/g, '')
    .slice(0, 16)}.${r.pick(['co.uk', 'com', 'org.uk', 'uk'])}`;
const money = (r, lo, hi) => {
  const v = (lo + r.next() * (hi - lo)).toFixed(2);
  const [i, d] = v.split('.');
  return `${r.pick(['£', '£', '£', '$'])}${Number(i).toLocaleString('en-GB')}.${d}`;
};
const pct = (r, lo, hi) => `${(lo + r.next() * (hi - lo)).toFixed(r.pick([1, 2]))}%`;

export function person(r) {
  const female = r.chance(0.5);
  return {
    title: female ? r.pick(['Mrs', 'Ms', 'Miss', 'Dr']) : r.pick(['Mr', 'Mr', 'Dr']),
    first: r.pick(FIRST),
    middle: r.chance(0.4) ? r.pick(MIDDLE) : null,
    last: r.pick(SURNAME),
  };
}
const full = (p, r) =>
  r.pick([
    `${p.title} ${p.first} ${p.last}`,
    `${p.first} ${p.last}`,
    `${p.first}${p.middle ? ` ${p.middle}` : ''} ${p.last}`,
    `${p.title} ${p.first[0]} ${p.last}`,
    `${p.last.toUpperCase()} ${p.first.toUpperCase()}`,
  ]);
const address = (r) => {
  const t = town(r);
  return r.chance(0.85)
    ? [
        `${r.int(1, 220)} ${r.pick(STREET_A)} ${r.pick(STREET_B)}`,
        ...(r.chance(0.3) ? [`${r.pick(['Upper', 'Lower', 'Little', 'Great'])} ${town(r)}`] : []),
        t,
        postcode(r),
      ]
    : [
        `${r.int(10, 9800)} ${r.pick(STREET_A)} ${r.pick(['St', 'Ave', 'Blvd', 'Rd'])}`,
        `${t}, ${r.pick(['OH', 'TX', 'NY', 'CA', 'WA', 'GA', 'MN'])} ${zip(r)}`,
      ];
};

/** A date as a day: years 2015–2031. */
function day(r, lo = 2015, hi = 2031) {
  return { y: r.int(lo, hi), m: r.int(1, 12), d: r.int(1, 28) };
}
const plus = (dt, years = 0, months = 0, days = 0) => {
  const t = new Date(Date.UTC(dt.y + years, dt.m - 1 + months, dt.d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};
const two = (n) => String(n).padStart(2, '0');
function fmt(r, dt) {
  return r.pick([
    () => `${two(dt.d)}/${two(dt.m)}/${dt.y}`,
    () => `${dt.d} ${MONTHS[dt.m - 1]} ${dt.y}`,
    () => `${dt.d} ${MONTHS[dt.m - 1].slice(0, 3)} ${dt.y}`,
    () => `${two(dt.d)} ${MONTHS[dt.m - 1].slice(0, 3).toUpperCase()} ${String(dt.y).slice(2)}`,
    () => `${MONTHS[dt.m - 1]} ${dt.d}, ${dt.y}`,
    () => `${dt.y}-${two(dt.m)}-${two(dt.d)}`,
    () => `${two(dt.d)}.${two(dt.m)}.${dt.y}`,
    () => `${two(dt.m)}/${two(dt.d)}/${dt.y}`,
  ])();
}
const ref = (r) =>
  r.pick([
    () => `${letters(r, 3)}${digits(r, 7)}`,
    () => `${digits(r, 4)} ${digits(r, 4)} ${digits(r, 4)}`,
    () => `${letters(r, 2)}-${digits(r, 6)}-${letters(r, 1)}`,
    () => `${digits(r, 10)}`,
    () => `${letters(r, 1)}${digits(r, 8)}`,
  ])();

/** A sender's name for a kind of business. */
function company(r, sort) {
  const w = r.pick(WORDS);
  const t = town(r);
  const names = {
    bank: [
      `${w} Bank`,
      `${w} & ${r.pick(WORDS)} Bank plc`,
      `${w} Savings`,
      `The ${t} Mutual`,
      `${w} Direct`,
    ],
    card: [
      `${w} Card`,
      `${w} Credit`,
      `${w} Visa`,
      `${w} Mastercard`,
      `${t} Card Services`,
      `${w} Rewards Card`,
    ],
    invest: [
      `${w} Investments`,
      `${w} Wealth`,
      `${t} Asset Management`,
      `${w} Invest`,
      `${w} Fund Managers`,
      `${w} Pensions`,
    ],
    energy: [
      `${w} Energy`,
      `${w} Power`,
      `${w} Gas & Electric`,
      `${t} Energy Co-op`,
      `${w} Utilities`,
    ],
    water: [`${t} Water`, `${w} Water Services`, `${t} & District Water`],
    telecom: [`${w} Mobile`, `${w}net`, `${w} Broadband`, `${w} Telecom`, `${w} Fibre`],
    council: [
      `${t} Borough Council`,
      `${t} District Council`,
      `${t} City Council`,
      `${t} County Council`,
    ],
    insurer: [
      `${w} Insurance`,
      `${w} Mutual`,
      `${w} General Insurance`,
      `${w} Assurance`,
      `${w} Life`,
      `${t} Insurance Services`,
      `${w} Cover`,
    ],
    lender: [
      `${w} Finance`,
      `${w} Mortgages`,
      `${t} Home Loans`,
      `${w} Motor Finance`,
      `${w} Lending`,
      `${w} Credit Union`,
    ],
    employer: [
      `${w} Logistics Ltd`,
      `${w} Systems Ltd`,
      `${t} Foods plc`,
      `${w} Engineering`,
      `${w} Health Partnership`,
      `${w} Design Studio`,
      `${t} Community Trust`,
    ],
    shop: [
      `${w} Electricals`,
      `${w} Home Store`,
      `${w} Appliances`,
      `${t} Furniture`,
      `${w} Tech`,
      `${w} Outdoor`,
      `${w} Kitchens`,
    ],
    surgery: [
      `${r.pick(STREET_A)} ${r.pick(['Street', 'Road', 'Lane'])} Surgery`,
      `${t} Medical Group`,
      `${w} Family Practice`,
      `The ${r.pick(STREET_A)} Practice`,
    ],
    hospital: [
      `${t} General Hospital`,
      `${t} Royal Infirmary`,
      `${t} Hospitals NHS Foundation Trust`,
      `${w} Community Hospital`,
      `${t} Children's Hospital`,
    ],
    dentist: [`${w} Dental Care`, `${t} Dental Practice`, `${w} Smiles Dentistry`],
    vet: [
      `${w} Veterinary Centre`,
      `${t} Vets`,
      `${w} Animal Clinic`,
      `${t} Veterinary Hospital`,
      `${w} Pet Health`,
    ],
    school: [`${t} Primary School`, `${t} Academy`, `${t} High School`, `${w} Community College`],
    uni: [`University of ${t}`, `${t} University`, `${w} College`, `${t} Institute of Technology`],
    solicitor: [
      `${r.pick(SURNAME)} & ${r.pick(SURNAME)} Solicitors`,
      `${r.pick(SURNAME)} Law LLP`,
      `${t} Legal Services`,
    ],
    pharmacy: [`${w} Pharmacy`, `${t} Chemist`, `${w} Healthcare Pharmacy`],
    agent: [`${w} Lettings`, `${t} Property Management`, `${w} Estates`],
    club: [
      `${t} ${r.pick(['Cricket', 'Tennis', 'Running', 'Swimming', 'Bowls', 'Chess'])} Club`,
      `Friends of ${t} ${r.pick(['Library', 'Park', 'Museum'])}`,
      `${t} ${r.pick(['Choir', 'Allotment Society', 'Gardening Club', 'Rotary'])}`,
    ],
    cafe: [
      `${w} Pizza`,
      `The ${r.pick(WORDS)} Kitchen`,
      `${t} Spice`,
      `${w} Noodle Bar`,
      `${w} Fish & Chips`,
    ],
  };
  return r.pick(names[sort]);
}

// ---------------------------------------------------------------- shared wording

const GENERIC = [
  'If you have any questions, give us a call and quote your reference.',
  'Please keep this document somewhere safe.',
  'Calls may be recorded for quality and training.',
  'We are open Monday to Friday, 8am to 6pm, and Saturday mornings.',
  'You can manage this online or in our app.',
  'Large print and braille copies are available on request.',
  'Please tell us if any of these details are wrong.',
  'This page is for your information only.',
  'Thank you for choosing us.',
  'Our privacy notice explains how we use your information.',
  'Registered in England and Wales.',
  'Registered office as above.',
  'Please turn over.',
  'Continued on the next page.',
  'Lines are open 9am to 5pm.',
  'For help in another language, please ask.',
  'Need help? Visit our help pages.',
  'Ref',
];
const FOOTER = [
  (r) => `Page ${r.int(1, 2)} of ${r.int(2, 4)}`,
  (r) => `Registered in England No. ${digits(r, 8)}`,
  (r) => `VAT reg no. ${digits(r, 3)} ${digits(r, 4)} ${digits(r, 2)}`,
  (r) => `${r.pick(['Customer services', 'Helpline', 'Enquiries', 'Call us'])}: ${phone(r)}`,
  (r) =>
    `${r.pick(['Email', 'E-mail'])}: ${r.pick(['help', 'hello', 'info', 'customers'])}@${r.pick(WORDS).toLowerCase()}.co.uk`,
  (r) =>
    `${r.pick(['Authorised and regulated by the Financial Conduct Authority', 'Authorised by the Prudential Regulation Authority', 'A member of the Financial Ombudsman Service scheme'])}.`,
  () => "Training specimen for the vault's reading model. Not a real paper.",
];

// ---------------------------------------------------------------- the kinds

/*
 * Each kind: who sends it, its titles, its labelled details (a label's
 * wordings, then a value), what its paragraphs say, and the tables some of
 * its papers carry. A paper takes some of each, in an order of its own.
 */
const D = (r) => fmt(r, day(r));
const KINDS = {
  passport: {
    sender: (r) =>
      r.pick([
        'HM Passport Office',
        'United Kingdom of Great Britain and Northern Ireland',
        'UNITED STATES OF AMERICA',
        'Ireland / Éire',
        'Republic of India',
        'Islamic Republic of Pakistan',
        'Canada',
        'Republic of Poland',
        'Federal Republic of Nigeria',
      ]),
    titles: [
      'PASSPORT',
      'Passport',
      'PASSPORT / PASSEPORT',
      'Your new passport',
      'Passport card',
      'Travel document',
    ],
    fields: [
      [['Type', 'Type/Type'], () => 'P'],
      [
        ['Code', 'Country code', 'Code of issuing State'],
        (r) => r.pick(['GBR', 'USA', 'IRL', 'IND', 'PAK', 'CAN', 'POL', 'NGA']),
      ],
      [
        ['Passport No.', 'Passport number', 'Document no', 'No. du passeport'],
        (r) => `${digits(r, 9)}`,
      ],
      [['Surname', 'Surname/Nom', 'Last name'], (r) => r.pick(SURNAME).toUpperCase()],
      [['Given names', 'Given names/Prénoms', 'Forenames'], (r) => r.pick(FIRST).toUpperCase()],
      [
        ['Nationality', 'Nationality/Nationalité'],
        (r) =>
          r.pick([
            'BRITISH CITIZEN',
            'UNITED STATES OF AMERICA',
            'IRISH',
            'INDIAN',
            'PAKISTANI',
            'CANADIAN',
            'POLISH',
          ]),
      ],
      [['Date of birth', 'Date of birth/Date de naissance'], D],
      [['Sex', 'Sex/Sexe'], (r) => r.pick(['M', 'F'])],
      [['Place of birth', 'Place of birth/Lieu de naissance'], (r) => town(r).toUpperCase()],
      [['Date of issue', 'Date of issue/Date de délivrance', 'Issued on'], D],
      [['Date of expiry', "Date of expiry/Date d'expiration", 'Expires on', 'Valid until'], D],
      [
        ['Authority', 'Authority/Autorité'],
        (r) =>
          r.pick([
            'HMPO',
            'United States Department of State',
            'Passport Office',
            'Consulate General',
          ]),
      ],
      [["Holder's signature", 'Signature of bearer'], () => ''],
    ],
    sentences: [
      'Your new passport is enclosed. Please sign it in black ink before you travel.',
      'Your old passport has been cancelled and is returned to you.',
      'Check the personal details page carefully.',
      'Keep your passport safe. Report a lost or stolen passport straight away.',
      'The bearer of this passport is requested to be allowed to pass freely without let or hindrance.',
      'Some countries need your passport to be valid for at least six months after you arrive.',
      'Your passport application has been approved.',
      'This passport remains the property of the issuing government.',
    ],
    extra: (r) => {
      const s = r.pick(SURNAME).toUpperCase();
      const g = r.pick(FIRST).toUpperCase();
      const c = r.pick(['GBR', 'USA', 'IRL', 'IND', 'CAN']);
      return [
        `P<${c}${s}<<${g}`.padEnd(44, '<'),
        `${digits(r, 9)}${digits(r, 1)}${c}${digits(r, 7)}${r.pick(['M', 'F'])}${digits(r, 7)}`.padEnd(
          44,
          '<',
        ),
      ];
    },
  },
  drivers_licence: {
    sender: (r) =>
      r.pick([
        'DVLA',
        'Driver and Vehicle Licensing Agency',
        'Department of Motor Vehicles',
        'Driver & Vehicle Agency',
        'Road Safety Authority',
        `${r.pick(['Ohio', 'Texas', 'Georgia', 'Oregon', 'Maine'])} Bureau of Motor Vehicles`,
      ]),
    titles: [
      'DRIVING LICENCE',
      'Driving Licence',
      'DRIVER LICENSE',
      "Driver's License",
      'Your photocard driving licence',
      'Provisional driving licence',
      'Renew your driving licence photocard',
      'View your driving record',
      'Licence summary',
    ],
    fields: [
      [['1.', '1 Surname', 'LN'], (r) => r.pick(SURNAME).toUpperCase()],
      [['2.', '2 Forenames', 'FN'], (r) => r.pick(FIRST).toUpperCase()],
      [['3.', 'DOB', 'Date of birth'], D],
      [['4a.', 'ISS', 'Issue date', 'Valid from'], D],
      [['4b.', 'EXP', 'Expiry date', 'Photocard valid to', 'Valid to'], D],
      [['4c.', 'Issued by'], (r) => r.pick(['DVLA', 'DMV', 'DVA'])],
      [
        ['5.', 'Driver number', 'Licence number', 'DL', 'DLN'],
        (r) =>
          `${r.pick(SURNAME).toUpperCase().slice(0, 5).padEnd(5, '9')}${digits(r, 6)}${letters(r, 2)}9${letters(r, 2)}`,
      ],
      [['8.', 'Address'], (r) => address(r).join(', ')],
      [
        ['9.', 'Categories', 'CLASS', 'Entitlements'],
        (r) => r.pick(['AM/A/B1/B/f/k/l/n/p/q', 'B, BE, B1', 'D', 'C, CM', 'AM/B/f/k/p']),
      ],
      [
        ['Endorsements', 'Penalty points', 'RESTR', 'END'],
        (r) => r.pick(['None', '0', '3 points SP30', 'NONE', 'B']),
      ],
      [['Check code'], (r) => `${letters(r, 2)} ${digits(r, 2)} ${letters(r, 2)} ${letters(r, 2)}`],
      [['Licence type', 'Licence status'], (r) => r.pick(['Full', 'Provisional', 'Valid'])],
    ],
    sentences: [
      'Tell us if you change your name or address. You could be fined if you do not.',
      'You can drive the vehicle categories shown on the back of the licence.',
      'Your photocard licence will expire soon. Renew it online.',
      'Penalty points stay on your record for 4 or 11 years.',
      'Carry this license when operating a motor vehicle.',
      'Organ donor: yes.',
      'The counterpart is no longer issued.',
    ],
    card: (r) => {
      const p = person(r);
      const born = day(r, 1940, 2008);
      const issued = day(r, 2014, 2026);
      const sep = r.pick(['.', '/', ' ']);
      const dt = (d) => `${two(d.d)}${sep}${two(d.m)}${sep}${d.y}`;
      return [
        r.pick([
          'DRIVING LICENCE',
          'Driving Licence  UK',
          'DRIVER LICENSE',
          'PROVISIONAL DRIVING LICENCE',
        ]),
        `1. ${p.last.toUpperCase()}`,
        `2. ${p.first.toUpperCase()}${p.middle ? ` ${p.middle.toUpperCase()}` : ''}`,
        `3. ${dt(born)} ${r.pick(['UNITED KINGDOM', town(r).toUpperCase(), 'ENGLAND', 'WALES'])}`,
        `4a. ${dt(issued)}${' '.repeat(r.int(2, 12))}4c. ${r.pick(['DVLA', 'DVA'])}`,
        `4b. ${dt(plus(issued, 10, 0, -1))}`,
        `5. ${p.last.toUpperCase().slice(0, 5).padEnd(5, '9')}${digits(r, 6)}${p.first[0]}${letters(r, 1)}9${letters(r, 2)} ${digits(r, 2)}`,
        `8. ${address(r).join(', ').toUpperCase()}`,
        `9. ${r.pick(['AM/A/B1/B/f/k/l/n/p/q', 'AM/B/f/k/p/q', 'B/BE/B1/f/k/q'])}`,
      ];
    },
  },
  vehicle_registration: {
    sender: (r) =>
      r.pick([
        'DVLA',
        'Driver and Vehicle Licensing Agency',
        'Department of Motor Vehicles',
        'Bureau of Motor Vehicles',
      ]),
    titles: [
      'Vehicle Registration Certificate',
      'V5C',
      'Registration certificate (V5C)',
      'Certificate of Title',
      'Vehicle registration',
      'New keeper supplement',
      'Vehicle tax reminder',
      'Registration card',
    ],
    fields: [
      [
        ['Registration number', 'Reg. mark', 'Plate number', 'Registration mark'],
        (r) => `${letters(r, 2)}${r.int(10, 75)} ${letters(r, 3)}`,
      ],
      [
        ['Make', 'Make (D.1)'],
        (r) => r.pick(['Corvan', 'Halden', 'Pelton', 'Fenwick', 'Arlo', 'Stratton']),
      ],
      [
        ['Model', 'Model (D.3)'],
        (r) => r.pick(['Estate 1.6', 'Hatch SE', 'Saloon LX', 'Tourer', 'Coupe GT']),
      ],
      [['Body type', 'Body'], (r) => r.pick(['Hatchback', 'Estate', 'Saloon', 'MPV', 'Pick-up'])],
      [['Colour', 'Color'], (r) => r.pick(['Silver', 'Blue', 'Grey', 'Black', 'White', 'Red'])],
      [
        ['VIN/Chassis/Frame No', 'VIN', 'Vehicle identification number'],
        (r) => `${letters(r, 3)}${digits(r, 4)}${letters(r, 2)}${digits(r, 8)}`,
      ],
      [['Date of first registration', 'Date of first registration (B)', 'First registered'], D],
      [['Registered keeper', 'Name of registered keeper', 'Owner'], (r) => full(person(r), r)],
      [['Cylinder capacity (cc)', 'Engine size'], (r) => `${r.int(9, 30)}00`],
      [['Type of fuel', 'Fuel'], (r) => r.pick(['Petrol', 'Diesel', 'Electricity', 'Hybrid'])],
      [['Taxation class', 'Tax class'], () => 'PETROL CAR'],
      [['Document reference number', 'Title number'], (r) => digits(r, 11)],
      [['Previous registered keepers', 'Number of former keepers'], (r) => String(r.int(0, 5))],
      [['Registration expires', 'Expiration date'], D],
    ],
    sentences: [
      'This document is not proof of ownership.',
      'The registered keeper is the person responsible for taxing the vehicle.',
      'Tell us straight away if you sell or transfer the vehicle.',
      'You must tax this vehicle before you use it on the road.',
      'Keep this certificate in a safe place, not in the vehicle.',
      'Odometer reading at time of transfer: actual mileage.',
      'Lienholder released.',
    ],
  },
  insurance_policy: {
    sender: (r) => company(r, 'insurer'),
    titles: [
      'Policy schedule',
      'Your policy schedule',
      'Certificate of motor insurance',
      'Home insurance schedule',
      'Travel insurance policy',
      'Pet insurance policy',
      'Life insurance policy',
      'Your renewal invitation',
      'Statement of fact',
      'Insurance product information document',
      'Policy documents',
      'Contents insurance certificate',
      'Gadget insurance',
      'Annual multi-trip travel cover',
      'Landlord insurance schedule',
      'Policy confirmation',
    ],
    fields: [
      [
        [
          'Policyholder',
          'Policy holder',
          'Name of policyholder',
          'Insured',
          'Main member',
          'Lead traveller',
          'Life assured',
        ],
        (r) => full(person(r), r),
      ],
      [['Policy number', 'Policy no', 'Certificate number'], ref],
      [['Period of cover', 'Cover dates'], (r) => `${D(r)} to ${D(r)}`],
      [['Start date', 'Cover starts', 'Effective date', 'Inception date'], D],
      [['End date', 'Expiry date', 'Renewal date', 'Cover ends', 'Valid until', 'Expires'], D],
      [['Premium', 'Annual premium', 'Total cost', 'Monthly premium'], (r) => money(r, 6, 1400)],
      [['Excess', 'Compulsory excess', 'Voluntary excess'], (r) => money(r, 50, 500)],
      [
        [
          'Sum insured',
          'Buildings sum insured',
          'Contents sum insured',
          'Cover amount',
          'Sum assured',
        ],
        (r) => money(r, 10000, 500000),
      ],
      [
        ['Vehicle', 'Registration', 'Insured vehicle'],
        (r) => `${letters(r, 2)}${r.int(10, 75)} ${letters(r, 3)}`,
      ],
      [
        ['Named drivers', 'Persons entitled to drive'],
        (r) => r.pick(['Policyholder only', 'Policyholder and spouse', 'Any driver over 25']),
      ],
      [['No claims discount', 'No claim bonus'], (r) => `${r.int(0, 9)} years`],
      [['Underwritten by', 'Insurer'], (r) => company(r, 'insurer')],
      [
        ['Pet', "Pet's name", 'Insured pet'],
        (r) => r.pick(['Pepper', 'Mabel', 'Rufus', 'Willow', 'Nutmeg']),
      ],
      [
        ['Destination', 'Area of cover'],
        (r) => r.pick(['Europe', 'Worldwide excluding USA', 'UK only', 'Worldwide']),
      ],
      [
        ['Cover level', 'Product'],
        (r) =>
          r.pick(['Comprehensive', 'Third party, fire and theft', 'Gold', 'Essentials', 'Premier']),
      ],
    ],
    sentences: [
      'This schedule forms part of your policy. Please read it with your policy wording.',
      'If you need to make a claim, call our claims line, open 24 hours.',
      'Please check your statement of fact is correct, or your cover may be affected.',
      'You have 14 days to cancel this policy and get a full refund if you have not claimed.',
      'Your premium includes Insurance Premium Tax at the current rate.',
      'This certificate is evidence that you hold the insurance required by law.',
      'Your home emergency cover is included.',
      'Pre-existing medical conditions are not covered unless declared and accepted.',
      'We will send your renewal invitation at least 21 days before your cover ends.',
      'Your no claims discount is protected.',
      'Claims are subject to the terms, conditions and exclusions of the policy.',
    ],
  },
  utility_bill: {
    sender: (r) =>
      company(r, r.pick(['energy', 'energy', 'water', 'telecom', 'telecom', 'council'])),
    titles: [
      'Your bill',
      'Your energy bill',
      'Your electricity statement',
      'Gas and electricity bill',
      'Your water bill',
      'Your broadband bill',
      'Monthly bill',
      'Phone bill',
      'Your mobile statement',
      'Council Tax bill',
      'Annual statement of account',
      'Final bill',
      'Your account statement',
      'Invoice',
    ],
    fields: [
      [['Account number', 'Customer number', 'Account no.', 'Customer reference'], ref],
      [['Bill date', 'Invoice date', 'Statement date', 'Date issued'], D],
      [['Billing period', 'This bill covers', 'Period', 'Charges for'], (r) => `${D(r)} - ${D(r)}`],
      [
        [
          'Amount due',
          'Total to pay',
          'Total amount due',
          'Balance to pay',
          'Amount payable',
          'What you owe',
        ],
        (r) => money(r, 12, 480),
      ],
      [['Payment due', 'Pay by', 'Due date', 'Please pay by'], D],
      [
        ['Tariff', 'Your plan', 'Package'],
        (r) =>
          r.pick([
            'Standard variable',
            'Fixed 12M',
            'Unlimited data 30-day',
            'Fibre 150',
            'Economy 7',
            'SIM only 20GB',
          ]),
      ],
      [
        ['Meter reading', 'Previous reading', 'Present reading', 'Meter serial'],
        (r) => `${digits(r, 5)} ${r.pick(['(actual)', '(estimated)', 'A', 'E'])}`,
      ],
      [
        ['Electricity used', 'Gas used', 'Water used'],
        (r) => `${r.int(40, 2400)} ${r.pick(['kWh', 'm3', 'cubic metres', 'units'])}`,
      ],
      [
        ['Standing charge', 'Daily standing charge', 'Line rental'],
        (r) => `${r.int(20, 65)}.${digits(r, 2)}p per day`,
      ],
      [['Unit rate', 'Price per kWh'], (r) => `${r.int(18, 34)}.${digits(r, 2)}p`],
      [
        ['Band', 'Council Tax band', 'Valuation band'],
        (r) => r.pick(['A', 'B', 'C', 'D', 'E', 'F']),
      ],
      [['Supply address', 'Property', 'Address of property'], (r) => address(r).join(', ')],
      [
        ['Direct Debit', 'Payment method', 'How you pay'],
        (r) =>
          r.pick([
            'Monthly Direct Debit',
            'Quarterly on receipt of bill',
            'Card payment',
            'Direct Debit',
          ]),
      ],
      [['Previous balance', 'Balance brought forward', 'Last bill'], (r) => money(r, 0, 300)],
      [
        ['Calls and texts', 'Data used', 'Extras'],
        (r) => `${r.int(0, 40)} ${r.pick(['minutes', 'GB', 'texts'])}`,
      ],
    ],
    sentences: [
      'Your next meter reading is due soon. Send it to us online.',
      'Compare your energy usage with last year.',
      'If you are struggling to pay, please talk to us. We can help.',
      'Your instalments will be collected on the 1st of each month from April to January.',
      'We charge for the water you use and for taking away and treating waste water.',
      'Your monthly payment covers your broadband, landline and any extras.',
      'Your discount for paying on time has been applied.',
      'This is an estimated bill. Give us a meter reading for an accurate bill.',
      'Council Tax pays for local services such as bin collections and schools.',
      'Out of bundle charges are shown overleaf.',
      'You are on our cheapest tariff for the way you use energy.',
      'Your fixed tariff ends soon. We will write to you with your options.',
    ],
    extra: (r) =>
      r.pick([
        () => [
          `Electricity ${r.int(100, 900)} kWh x ${r.int(18, 34)}.${digits(r, 2)}p   ${money(r, 30, 300)}`,
          `Standing charge ${r.int(28, 31)} days   ${money(r, 8, 25)}`,
          `VAT at 5%   ${money(r, 2, 20)}`,
        ],
        () => [
          `Monthly charge   ${money(r, 15, 60)}`,
          `Calls outside plan   ${money(r, 0, 10)}`,
          `Total this month   ${money(r, 15, 80)}`,
        ],
        () => [
          `Water supply   ${money(r, 80, 300)}`,
          `Wastewater   ${money(r, 80, 300)}`,
          `Surface water drainage   ${money(r, 10, 40)}`,
        ],
        () => [
          `Instalment 1  ${D(r)}  ${money(r, 100, 220)}`,
          `Instalment 2  ${D(r)}  ${money(r, 100, 220)}`,
          `Instalments 3 to 10  ${money(r, 100, 220)} each`,
        ],
      ])(),
  },
  bank_statement: {
    sender: (r) => company(r, 'bank'),
    titles: [
      'Statement',
      'Your statement',
      'Current account statement',
      'Savings account statement',
      'Cash ISA statement',
      'Annual statement',
      'Checking account statement',
      'Statement of account',
      'Joint account statement',
      'Easy access saver',
    ],
    fields: [
      [['Sort code', 'Sort Code'], (r) => `${digits(r, 2)}-${digits(r, 2)}-${digits(r, 2)}`],
      [['Account number', 'Account no', 'Acct'], (r) => digits(r, 8)],
      [
        ['Statement date', 'Date of statement', 'Statement period', 'Period'],
        (r) => r.pick([D(r), `${D(r)} to ${D(r)}`]),
      ],
      [
        ['Opening balance', 'Balance brought forward', 'Beginning balance', 'Previous balance'],
        (r) => money(r, 0, 9000),
      ],
      [
        ['Closing balance', 'Balance carried forward', 'Ending balance', 'Balance at end'],
        (r) => money(r, 0, 9000),
      ],
      [['Money in', 'Paid in', 'Total deposits', 'Credits'], (r) => money(r, 0, 6000)],
      [['Money out', 'Paid out', 'Total withdrawals', 'Debits'], (r) => money(r, 0, 6000)],
      [['Interest rate', 'AER', 'Gross rate', 'APY'], (r) => pct(r, 0.1, 5)],
      [['Interest paid', 'Interest earned', 'Interest this period'], (r) => money(r, 0, 90)],
      [['Account name', 'Account holder', 'Name'], (r) => full(person(r), r)],
      [['Arranged overdraft limit', 'Overdraft limit'], (r) => money(r, 0, 1500)],
      [
        ['IBAN', 'BIC', 'Routing number'],
        (r) =>
          `GB${digits(r, 2)} ${letters(r, 4)} ${digits(r, 4)} ${digits(r, 4)} ${digits(r, 4)} ${digits(r, 2)}`,
      ],
      [['Branch', 'Branch address'], (r) => `${town(r)} branch`],
    ],
    sentences: [
      'Please check your statement and tell us about anything you do not recognise.',
      'Your eligible deposits are protected up to a total of £85,000 by the Financial Services Compensation Scheme.',
      'Interest is paid gross on your savings.',
      'Your ISA allowance for this tax year is shown below.',
      'Direct debits and standing orders are listed with your other payments.',
      'You can see your transactions any time in online banking.',
      'Any interest you have earned has been added to your account.',
      'We will tell you before we change your interest rate.',
      'Cheques paid in may take up to two working days to clear.',
    ],
    extra: (r) => {
      const rows = [
        r.pick([
          'Date  Description  Paid out  Paid in  Balance',
          'DATE  TRANSACTION  DEBIT  CREDIT  BALANCE',
          'Date  Payment type and details  Money out  Money in',
        ]),
      ];
      for (let i = 0; i < r.int(3, 12); i += 1) {
        rows.push(
          `${two(r.int(1, 28))} ${MONTHS[r.int(0, 11)].slice(0, 3)}  ${r.pick(['DD', 'SO', 'CARD', 'BGC', 'TFR', 'FPI', 'FPO', 'ATM'])} ${r.pick(['SUPERMARKET', 'SALARY', 'COUNCIL TAX', 'RENT', 'TRANSFER', 'CASH WITHDRAWAL', 'ENERGY', 'GYM', 'PHONE', 'BOOKSHOP'])}  ${money(r, 2, 900)}  ${money(r, 0, 9000)}`,
        );
      }
      return rows;
    },
  },
  credit_card_statement: {
    sender: (r) => company(r, 'card'),
    titles: [
      'Credit card statement',
      'Your credit card statement',
      'Monthly statement',
      'Card statement',
      'Your Mastercard statement',
      'Statement of account',
      'Your Visa statement',
    ],
    fields: [
      [
        ['Card number ending', 'Card ending', 'Account ending in', 'Card no.'],
        (r) => r.pick([digits(r, 4), `**** **** **** ${digits(r, 4)}`]),
      ],
      [['Credit limit', 'Your credit limit'], (r) => money(r, 500, 12000)],
      [['Available credit', 'Available to spend'], (r) => money(r, 0, 12000)],
      [['Minimum payment', 'Minimum amount due', 'Minimum repayment'], (r) => money(r, 5, 200)],
      [['Payment due date', 'Pay by', 'Payment due by', 'Due date'], D],
      [
        ['Statement balance', 'New balance', 'Balance on this statement', 'Outstanding balance'],
        (r) => money(r, 0, 6000),
      ],
      [['Previous balance', 'Balance from last statement'], (r) => money(r, 0, 6000)],
      [['Purchase rate', 'APR', 'Representative APR', 'Cash rate'], (r) => pct(r, 9, 39)],
      [['Statement date', 'Statement issued'], D],
      [['Purchases', 'New purchases'], (r) => money(r, 0, 3000)],
      [['Payments received', 'Payments and credits'], (r) => money(r, 0, 3000)],
      [['Interest charged', 'Interest'], (r) => money(r, 0, 90)],
      [['Cardholder', 'Primary cardholder', 'Name on card'], (r) => full(person(r), r)],
      [['Balance transfer', 'Promotional balance'], (r) => money(r, 0, 4000)],
    ],
    sentences: [
      'If you only make the minimum payment each month, it will take you longer and cost you more to clear your balance.',
      'Pay at least the minimum payment by the due date to avoid a late payment fee.',
      'Your promotional rate on balance transfers ends soon.',
      'Keep track of your spending with our app.',
      'Your available credit has been updated.',
      'Interest will be charged on purchases not paid off in full.',
      'Cash withdrawals are charged a fee and interest from the day they are made.',
      'Rewards points earned this month are shown below.',
    ],
    extra: (r) => {
      const rows = [
        r.pick([
          'Date  Merchant  Amount',
          'Transaction date  Description  £',
          'Posting date  Details  Amount',
        ]),
      ];
      for (let i = 0; i < r.int(3, 10); i += 1) {
        rows.push(
          `${two(r.int(1, 28))}/${two(r.int(1, 12))}  ${r.pick(['ONLINE RETAILER', 'FUEL STATION', 'RESTAURANT', 'AIRLINE', 'HOTEL', 'GROCER', 'STREAMING', 'PAYMENT THANK YOU'])} ${town(r).toUpperCase()}  ${money(r, 2, 600)}`,
        );
      }
      return rows;
    },
  },
  investment_statement: {
    sender: (r) => company(r, 'invest'),
    titles: [
      'Valuation statement',
      'Portfolio valuation',
      'Investment statement',
      'Stocks and shares ISA statement',
      'Your quarterly investment report',
      'Annual pension statement',
      'Fund statement',
      'Brokerage account statement',
      'Consolidated tax certificate',
    ],
    fields: [
      [
        ['Portfolio value', 'Total portfolio value', 'Total value', 'Fund value', 'Market value'],
        (r) => money(r, 1000, 400000),
      ],
      [['Valuation date', 'Statement date', 'As at', 'Period ending'], D],
      [['Account number', 'Plan number', 'Client reference'], ref],
      [
        ['Units held', 'Number of units', 'Number of shares', 'Quantity'],
        (r) => `${r.int(10, 9000)}.${digits(r, 3)}`,
      ],
      [['Price per unit', 'Unit price', 'Price per share', 'Bid price'], (r) => money(r, 0.5, 400)],
      [['Cost basis', 'Book cost', 'Amount invested'], (r) => money(r, 1000, 300000)],
      [
        ['Unrealised gain', 'Gain/loss', 'Change in value', 'Unrealized gain/loss'],
        (r) => money(r, 0, 40000),
      ],
      [['Dividends', 'Income received', 'Dividends reinvested'], (r) => money(r, 0, 4000)],
      [['Platform fee', 'Annual management charge', 'Ongoing charges'], (r) => pct(r, 0.1, 1.5)],
      [['Contributions', 'Payments in this year'], (r) => money(r, 0, 20000)],
      [['Investor', 'Account holder', 'Member'], (r) => full(person(r), r)],
    ],
    sentences: [
      'The value of investments can fall as well as rise and you may get back less than you invested.',
      'Past performance is not a reliable guide to future returns.',
      'Your holdings are shown at the closing price on the valuation date.',
      "Your projected pension at retirement age is shown below, in today's money.",
      'Dividends have been reinvested in the same fund.',
      "You have used part of this year's ISA allowance.",
      'Your asset allocation across equities, bonds and cash is shown overleaf.',
    ],
    extra: (r) => {
      const rows = [
        r.pick([
          'Holding  Units  Price  Value',
          'Fund name | Units held | Price | Market value',
          'Security  Quantity  Price  Market value',
        ]),
      ];
      for (let i = 0; i < r.int(2, 7); i += 1) {
        rows.push(
          `${r.pick(WORDS)} ${r.pick(['Global Equity', 'UK Index', 'Bond Fund', 'Income Trust', 'Tracker Acc', 'Emerging Markets'])}  ${r.int(10, 900)}.${digits(r, 2)}  ${money(r, 1, 300)}  ${money(r, 100, 90000)}`,
        );
      }
      return rows;
    },
  },
  pay_statement: {
    sender: (r) => company(r, 'employer'),
    titles: [
      'Payslip',
      'Pay slip',
      'Pay advice',
      'Earnings statement',
      'Pay stub',
      'Salary slip',
      'Monthly payslip',
      'Weekly pay advice',
    ],
    fields: [
      [['Employee', 'Employee name', 'Name'], (r) => full(person(r), r)],
      [['Employee number', 'Payroll number', 'Staff no', 'Employee ID'], (r) => digits(r, 6)],
      [['Pay date', 'Payment date', 'Date paid', 'Pay period ending', 'Check date'], D],
      [
        ['Tax code', 'Tax code / basis'],
        (r) => r.pick(['1257L', '1257L M1', 'BR', 'S1257L', 'K475']),
      ],
      [
        ['NI number', 'National Insurance number', 'NI No', 'SSN'],
        (r) =>
          `${letters(r, 2)} ${digits(r, 2)} ${digits(r, 2)} ${digits(r, 2)} ${r.pick(['A', 'B', 'C', 'D'])}`,
      ],
      [['Basic pay', 'Salary', 'Regular earnings', 'Basic salary'], (r) => money(r, 800, 6000)],
      [['Overtime', 'Overtime 1.5x', 'Bonus', 'Shift allowance'], (r) => money(r, 0, 900)],
      [
        ['Gross pay', 'Total gross pay', 'Gross earnings', 'Total earnings'],
        (r) => money(r, 800, 7000),
      ],
      [['Income tax', 'PAYE tax', 'Tax', 'Federal income tax'], (r) => money(r, 0, 1500)],
      [
        ['National Insurance', 'NIC', 'Employee NI', 'Social Security', 'Medicare'],
        (r) => money(r, 0, 500),
      ],
      [['Pension', 'Pension contribution', 'Employee pension', '401(k)'], (r) => money(r, 0, 400)],
      [['Net pay', 'Take home pay', 'Net amount', 'Amount paid'], (r) => money(r, 600, 5000)],
      [
        ['Tax period', 'Period', 'Pay period'],
        (r) => `${r.pick(['Month', 'Week', 'M', 'Wk'])} ${r.int(1, 12)}`,
      ],
      [['Gross pay to date', 'Taxable pay YTD', 'Year to date'], (r) => money(r, 1000, 60000)],
      [
        ['Department', 'Cost centre'],
        (r) => r.pick(['Operations', 'Finance', 'Ward 7', 'Warehouse', 'Customer service']),
      ],
    ],
    sentences: [
      'Your pay has been sent to your bank account.',
      'Please check your payslip and tell payroll about any errors.',
      'Student loan deductions are shown under deductions.',
      'Holiday remaining: days shown below.',
      'Your employer pension contribution is in addition to your pay.',
      'Payments and deductions for this period.',
    ],
  },
  loan: {
    sender: (r) => company(r, 'lender'),
    titles: [
      'Annual mortgage statement',
      'Mortgage statement',
      'Loan agreement',
      'Personal loan agreement',
      'Hire purchase agreement',
      'Personal contract purchase agreement',
      'Fixed sum loan agreement',
      'Your loan statement',
      'Student loan statement',
      'Mortgage offer',
      'Credit agreement regulated by the Consumer Credit Act 1974',
      'Car finance agreement',
      'Redemption statement',
    ],
    fields: [
      [
        ['Loan amount', 'Amount of credit', 'Amount borrowed', 'Advance', 'Total amount of credit'],
        (r) => money(r, 1000, 350000),
      ],
      [
        [
          'Outstanding balance',
          'Balance outstanding',
          'Amount outstanding',
          'Balance remaining',
          'Redemption figure',
        ],
        (r) => money(r, 500, 350000),
      ],
      [['Interest rate', 'Annual interest rate', 'Rate', 'Fixed rate'], (r) => pct(r, 1, 14)],
      [['APR', 'Representative APR'], (r) => pct(r, 2, 19)],
      [
        ['Monthly payment', 'Monthly repayment', 'Monthly instalment', 'Instalments'],
        (r) => money(r, 40, 2500),
      ],
      [
        ['Number of repayments', 'Number of monthly payments', 'Term', 'Remaining term'],
        (r) =>
          r.pick([
            `${r.int(12, 84)}`,
            `${r.int(5, 35)} years`,
            `${r.int(1, 30)} years ${r.int(0, 11)} months`,
          ]),
      ],
      [['First repayment date', 'First payment date', 'First payment'], D],
      [['Final payment date', 'Last payment due', 'Maturity date', 'Product end date'], D],
      [['Total amount payable', 'Total repayable', 'Total payable'], (r) => money(r, 1000, 500000)],
      [['Borrower', 'Customer', 'Borrower(s)', 'Debtor'], (r) => full(person(r), r)],
      [
        [
          'Loan account number',
          'Agreement number',
          'Mortgage account number',
          'Customer reference number',
        ],
        ref,
      ],
      [
        ['Early repayment charge', 'Settlement figure'],
        (r) => r.pick([money(r, 0, 9000), pct(r, 1, 5)]),
      ],
      [
        ['Property', 'Security address', 'Goods'],
        (r) =>
          r.pick([
            address(r).join(', '),
            `${r.pick(['Hatchback', 'Estate car', 'Van'])} registration ${letters(r, 2)}${r.int(10, 75)} ${letters(r, 3)}`,
          ]),
      ],
      [['Optional final payment', 'Balloon payment'], (r) => money(r, 2000, 15000)],
      [
        ['Repayment plan', 'Plan type'],
        (r) => r.pick(['Plan 2', 'Plan 1', 'Repayment', 'Interest only', 'Part and part']),
      ],
    ],
    sentences: [
      'Your home may be repossessed if you do not keep up repayments on your mortgage.',
      'You have the right to withdraw from this agreement within 14 days.',
      'You can repay all or part of the loan early. An early repayment charge may apply.',
      'Missing payments could have severe consequences and make obtaining credit more difficult.',
      'Your fixed rate ends soon. Talk to us about switching to a new product.',
      'Repayments are collected through the tax system once you earn over the threshold.',
      'The goods remain our property until you have paid everything you owe under this agreement.',
      'Interest is calculated daily on the balance outstanding.',
      'This statement shows the payments made and interest charged over the year.',
    ],
  },
  birth_certificate: {
    sender: (r) =>
      r.pick([
        'General Register Office',
        'Registration Service',
        `${town(r)} Register Office`,
        'Department of Health, Vital Records',
        'National Records of Scotland',
      ]),
    titles: [
      'CERTIFIED COPY OF AN ENTRY OF BIRTH',
      'Birth certificate',
      'Certificate of Birth',
      'Certificate of Live Birth',
      'Short birth certificate',
      'Extract of an entry in a register of births',
      'Birth registration',
    ],
    fields: [
      [['Registration district', 'District', 'County of'], (r) => town(r)],
      [['Sub-district', 'Sub district'], (r) => town(r)],
      [
        ['When and where born', 'Date and place of birth', 'Place of birth'],
        (r) =>
          `${D(r)}, ${town(r)} ${r.pick(['Maternity Unit', 'General Hospital', 'Birth Centre'])}`,
      ],
      [
        ['Name and surname', 'Name of child', "Child's name", 'Full name'],
        (r) => full(person(r), r),
      ],
      [['Sex', 'Sex of child'], (r) => r.pick(['Boy', 'Girl', 'Male', 'Female'])],
      [
        ['Name and surname of father', 'Father', 'Father/Parent'],
        (r) => `${r.pick(FIRST)} ${r.pick(SURNAME)}`,
      ],
      [
        ['Name and surname of mother', 'Mother', 'Mother/Parent'],
        (r) => `${r.pick(FIRST)} ${r.pick(SURNAME)}`,
      ],
      [['Maiden surname of mother', 'Maiden name'], (r) => r.pick(SURNAME)],
      [
        ['Occupation of father', 'Occupation'],
        (r) => r.pick(['Teacher', 'Electrician', 'Nurse', 'Accountant', 'Chef', 'Driver']),
      ],
      [
        ['Signature, description and residence of informant', 'Informant'],
        (r) => `${r.pick(FIRST)} ${r.pick(SURNAME)}, ${r.pick(['Mother', 'Father', 'Parent'])}`,
      ],
      [['When registered', 'Date of registration', 'Registered on'], D],
      [
        ['Signature of registrar', 'Registrar'],
        (r) => `${r.pick(FIRST)} ${r.pick(SURNAME)}, Registrar`,
      ],
      [
        ['Entry no.', 'Certificate number', 'State file number', 'System number'],
        (r) => digits(r, 6),
      ],
    ],
    sentences: [
      'Certified to be a true copy of an entry in a register in my custody.',
      'CAUTION: THERE ARE OFFENCES RELATING TO FALSIFYING OR ALTERING A CERTIFICATE AND USING OR POSSESSING A FALSE CERTIFICATE.',
      'A certificate is not evidence of identity.',
      'Given at the General Register Office under the seal of the said Office.',
      'Births and Deaths Registration Act 1953.',
      'This is a certified copy of the original record on file.',
    ],
  },
  marriage_certificate: {
    sender: (r) =>
      r.pick([
        'General Register Office',
        `${town(r)} Register Office`,
        'Registration Service',
        'Family Court',
        'County Clerk',
      ]),
    titles: [
      'CERTIFIED COPY OF AN ENTRY OF MARRIAGE',
      'Marriage certificate',
      'Certificate of Marriage',
      'Civil partnership certificate',
      'Final order',
      'Decree absolute',
      'Certificate of divorce',
      'Marriage licence',
    ],
    fields: [
      [
        ['Marriage solemnized at', 'Place of marriage', 'Where married'],
        (r) =>
          `${r.pick(['The Register Office', "St Luke's Church", 'The Old Mill', 'Town Hall'])}, ${town(r)}`,
      ],
      [['When married', 'Date of marriage', 'Date of formation'], D],
      [
        ['Name and surname', 'Husband', 'Wife', 'Partner 1', 'Partner 2', 'Spouse'],
        (r) => `${r.pick(FIRST)} ${r.pick(SURNAME)}`,
      ],
      [['Age', 'Ages'], (r) => String(r.int(19, 60))],
      [
        ['Condition', 'Marital status'],
        (r) => r.pick(['Single', 'Bachelor', 'Spinster', 'Previously married', 'Divorced']),
      ],
      [
        ['Rank or profession', 'Occupation'],
        (r) => r.pick(['Engineer', 'Pharmacist', 'Architect', 'Retail manager', 'Carpenter']),
      ],
      [
        ['Residence at the time of marriage', 'Residence'],
        (r) => address(r).slice(0, 2).join(', '),
      ],
      [
        ["Father's name and surname", "Father's name"],
        (r) => `${r.pick(FIRST)} ${r.pick(SURNAME)}`,
      ],
      [
        ['in the presence of us', 'Witnesses'],
        (r) => `${r.pick(FIRST)} ${r.pick(SURNAME)}, ${r.pick(FIRST)} ${r.pick(SURNAME)}`,
      ],
      [
        ['Case number', 'Number of matter', 'Certificate no'],
        (r) => `${letters(r, 2)}${digits(r, 2)}D${digits(r, 5)}`,
      ],
      [
        ['The marriage of', 'Between'],
        (r) => `${r.pick(FIRST)} ${r.pick(SURNAME)} and ${r.pick(FIRST)} ${r.pick(SURNAME)}`,
      ],
    ],
    sentences: [
      'Married in the Register Office according to the Marriage Act 1949.',
      'This marriage was solemnized between us in the presence of the witnesses.',
      'The marriage has been dissolved. The final order was made on the date shown.',
      'Certified to be a true copy of an entry in the certified copy of a register of marriages.',
      'The civil partnership was formed at the place and on the date shown.',
      'CAUTION: there are offences relating to falsifying or altering a certificate.',
    ],
  },
  tax_return: {
    sender: (r) =>
      r.pick([
        'HM Revenue & Customs',
        'HMRC',
        'Internal Revenue Service',
        'Department of the Treasury',
        `${r.pick(SURNAME)} & Co Accountants`,
      ]),
    titles: [
      'Tax return',
      'Self Assessment tax return',
      'SA100',
      'Your Self Assessment submission receipt',
      'Tax calculation',
      'SA302 tax calculation',
      'Form 1040 U.S. Individual Income Tax Return',
      'Tax year overview',
      'Self Assessment: your tax return has been received',
      'Amended return',
    ],
    fields: [
      [
        ['Unique Taxpayer Reference', 'UTR', 'Your UTR', 'Taxpayer reference'],
        (r) => `${digits(r, 5)} ${digits(r, 5)}`,
      ],
      [
        ['Tax year', 'Tax year ended', 'For the year'],
        (r) => `${r.int(2016, 2026)} to ${r.int(2017, 2027)}`,
      ],
      [
        ['Submission receipt reference', 'IRmark', 'Submission reference'],
        (r) => `${letters(r, 6)}${digits(r, 8)}`,
      ],
      [['Date submitted', 'Received on', 'Filed on', 'Date of filing'], D],
      [
        [
          'Total income',
          'Total income received',
          'Adjusted gross income',
          'Total income on which tax is due',
        ],
        (r) => money(r, 8000, 120000),
      ],
      [['Personal allowance', 'Standard deduction'], (r) => money(r, 10000, 15000)],
      [
        ['Income Tax due', 'Total tax due', 'Tax owed', 'Amount you owe', 'Total tax'],
        (r) => money(r, 0, 30000),
      ],
      [['Payments on account', 'Balancing payment', 'Refund'], (r) => money(r, 0, 9000)],
      [['Self-employment profit', 'Trading income', 'Property income'], (r) => money(r, 0, 60000)],
      [['Filing status'], (r) => r.pick(['Single', 'Married filing jointly', 'Head of household'])],
      [['Name', 'Taxpayer', 'Your first name and middle initial'], (r) => full(person(r), r)],
      [['Pay by', 'Payment due', 'Due date for payment'], D],
    ],
    sentences: [
      'Thank you for sending your Self Assessment tax return. We have received it.',
      'Keep this receipt with your records. You may need to show it.',
      'Your tax calculation shows how we worked out the tax you owe.',
      'You need to pay any tax you owe by 31 January.',
      'Under penalties of perjury, I declare that I have examined this return.',
      'The information I have given in this tax return is correct and complete to the best of my knowledge.',
      'Check the figures and tell us if anything is wrong.',
    ],
  },
  tax_form: {
    sender: (r) =>
      r.pick([
        'HM Revenue & Customs',
        'HMRC',
        company(r, 'employer'),
        'Internal Revenue Service',
        company(r, 'bank'),
      ]),
    titles: [
      'P60 End of Year Certificate',
      'P60',
      'P45 Details of employee leaving work',
      'P11D Expenses and benefits',
      'Form W-2 Wage and Tax Statement',
      'Form 1099-INT',
      'Form 1099-DIV',
      'Tax code notice',
      'Your tax code for the year',
      'P800 tax calculation',
      'Certificate of tax deducted',
      'Form P2',
    ],
    fields: [
      [['Tax year to 5 April', 'Tax year', 'Year'], (r) => String(r.int(2016, 2027))],
      [
        [
          "Employer's PAYE reference",
          'Employer PAYE reference',
          'Employer identification number (EIN)',
          'PAYE reference',
        ],
        (r) => `${digits(r, 3)}/${letters(r, 2)}${digits(r, 5)}`,
      ],
      [
        ['National Insurance number', 'NI number', "Employee's social security number"],
        (r) =>
          `${letters(r, 2)} ${digits(r, 2)} ${digits(r, 2)} ${digits(r, 2)} ${r.pick(['A', 'B', 'C', 'D'])}`,
      ],
      [
        ['Total pay', 'Wages, tips, other compensation', 'Taxable pay'],
        (r) => money(r, 6000, 90000),
      ],
      [['Tax deducted', 'Federal income tax withheld', 'Income tax'], (r) => money(r, 0, 25000)],
      [
        ['Final tax code', 'Tax code', 'Your tax code'],
        (r) => r.pick(['1257L', 'BR', '1185L', 'K210', 'S1257L']),
      ],
      [['Employee', "Employee's name", 'Recipient'], (r) => full(person(r), r)],
      [['Date of leaving', 'Leaving date'], D],
      [['Interest income', 'Ordinary dividends'], (r) => money(r, 0, 4000)],
      [['Works number', 'Payroll ID', 'Control number'], (r) => digits(r, 6)],
      [['Benefit in kind', 'Car benefit', 'Medical insurance benefit'], (r) => money(r, 0, 9000)],
    ],
    sentences: [
      'To the employee: please keep this certificate in a safe place. You will need it if you have to fill in a tax return.',
      'This is a printed copy of an eFiled form.',
      "Copy B to be filed with employee's federal tax return.",
      'Your tax code tells your employer how much tax to take from your pay.',
      'We have worked out that you paid too much tax last year.',
      'Hand parts 2 and 3 of this form to your new employer.',
      'The figures shown are for the whole tax year.',
    ],
  },
  prescription: {
    sender: (r) => r.pick([company(r, 'surgery'), company(r, 'pharmacy'), company(r, 'hospital')]),
    titles: [
      'Prescription',
      'Prescription label',
      'Medication record',
      'Private prescription',
      'FP10',
    ],
    fields: [
      [['Patient', 'Patient name', 'Name'], (r) => full(person(r), r)],
      [
        ['NHS No', 'NHS number', 'Patient number'],
        (r) => `${digits(r, 3)} ${digits(r, 3)} ${digits(r, 4)}`,
      ],
      [
        ['Medication', 'Drug', 'Item', 'Medicine'],
        (r) =>
          `${r.pick(['Amoxicillin', 'Lansoprazole', 'Atorvastatin', 'Salbutamol inhaler', 'Sertraline', 'Metformin', 'Ramipril', 'Levothyroxine', 'Cetirizine', 'Ibuprofen gel', 'Omeprazole', 'Amlodipine'])} ${r.pick(['5mg', '10mg', '20mg', '40mg', '100 micrograms', '250mg', '500mg'])} ${r.pick(['tablets', 'capsules', 'inhaler', 'oral solution'])}`,
      ],
      [
        ['Dose', 'Directions', 'Dosage', 'Instructions'],
        (r) =>
          r.pick([
            'Take ONE tablet daily',
            'Take one capsule three times a day',
            'TWO puffs when required',
            'One to be taken at night',
            'Take one in the morning with food',
          ]),
      ],
      [
        ['Quantity', 'Qty', 'Pack size'],
        (r) =>
          `${r.pick([7, 14, 28, 56, 84, 1])} ${r.pick(['tablets', 'capsules', 'x 200 dose', 'packs'])}`,
      ],
      [
        ['Prescriber', 'Prescribed by', 'Doctor'],
        (r) => `Dr ${r.pick(FIRST)[0]} ${r.pick(SURNAME)}`,
      ],
      [['Date of prescription', 'Date prescribed', 'Date issued', 'Last issued'], D],
      [['Review date', 'Medication review due', 'Next review'], D],
      [['Do not use after', 'Use by', 'Expiry', 'Valid until'], D],
      [['Pharmacy', 'Nominated pharmacy', 'Dispensed by'], (r) => company(r, 'pharmacy')],
      [
        ['Charge', 'Prescription charge', 'Exempt'],
        (r) => r.pick(['£9.90', 'Exempt', 'Paid', 'Free']),
      ],
    ],
    sentences: [
      'Keep all medicines out of the reach and sight of children.',
      'Do not stop taking this medicine without talking to your doctor.',
      'Your medication is due for review. Please book an appointment.',
      'Read the patient information leaflet before use.',
      'May cause drowsiness. If affected do not drive or operate machinery.',
    ],
  },
  medical_record: {
    sender: (r) => company(r, r.pick(['surgery', 'surgery', 'hospital', 'hospital', 'dentist'])),
    titles: [
      'Clinic letter',
      'Outpatient appointment',
      'Discharge summary',
      'Test results',
      'Referral letter',
      'Immunisation record',
      'Vaccination record',
      'Patient summary',
      'Dental treatment plan',
      'Your dental check-up is due',
      'Results of your blood test',
      'Letter to patient',
      'Medical report',
      'Eye examination record',
      'Appointment confirmation',
      'Health check results',
    ],
    fields: [
      [['Patient', 'Patient name', 'Name', 'Re'], (r) => full(person(r), r)],
      [
        ['NHS No', 'NHS number', 'Hospital number', 'MRN', 'Patient ID'],
        (r) => `${digits(r, 3)} ${digits(r, 3)} ${digits(r, 4)}`,
      ],
      [['Date of birth', 'DOB', 'D.O.B.'], D],
      [
        ['Clinic', 'Department', 'Ward', 'Specialty'],
        (r) =>
          r.pick([
            'Cardiology',
            'Dermatology',
            'Orthopaedics',
            'Ear, nose and throat',
            'Ward 12',
            'Fracture clinic',
            'Ophthalmology',
            'Paediatrics',
          ]),
      ],
      [
        ['Consultant', 'Clinician', 'Seen by', 'Dentist'],
        (r) => `${r.pick(['Dr', 'Mr', 'Ms'])} ${r.pick(FIRST)} ${r.pick(SURNAME)}`,
      ],
      [
        ['Diagnosis', 'Findings', 'Outcome', 'Impression'],
        (r) =>
          r.pick([
            'Mild sprain, no fracture',
            'Normal results',
            'Eczema, improving',
            'No further action needed',
            'Iron deficiency',
            'Healthy, follow up in a year',
          ]),
      ],
      [
        [
          'Date of appointment',
          'Appointment date',
          'Date seen',
          'Date of admission',
          'Date of discharge',
        ],
        D,
      ],
      [
        ['Vaccine', 'Immunisation', 'Vaccination'],
        (r) =>
          r.pick([
            'MMR',
            'Influenza',
            'Tetanus booster',
            'HPV',
            'Hepatitis B',
            'Pneumococcal',
            '6-in-1',
            'COVID-19 booster',
          ]),
      ],
      [['Batch number', 'Batch no', 'Lot'], (r) => `${letters(r, 2)}${digits(r, 4)}`],
      [['Dose', 'Dose number'], (r) => `${r.int(1, 3)}`],
      [['Next due', 'Recall date', 'Next check-up', 'Follow-up'], D],
      [['GP', 'Registered GP', 'Usual GP'], (r) => `Dr ${r.pick(FIRST)} ${r.pick(SURNAME)}`],
    ],
    sentences: [
      'I saw this patient in clinic today with their mother.',
      'Blood pressure was normal. Heart sounds were normal.',
      'We have made a referral and the hospital will write to you with an appointment.',
      'Your test results are back and are within the normal range.',
      'Please bring a list of your current medicines to your appointment.',
      'If you cannot attend, please let us know so we can offer the slot to someone else.',
      'Thank you for referring this patient.',
      'Plan: continue current treatment and review in six months.',
      'It is time for your routine dental examination.',
      'Your vaccinations are up to date.',
      'Please speak to reception to book a follow-up.',
      'cc: GP',
      'Thank you for coming to your annual review.',
      'Please carry on with your medicines as before and see us again next year.',
      'Your blood pressure check was normal.',
      'Re: your recent appointment',
      'I am writing to let you know the result of your scan.',
      'You are invited to book your annual health check.',
      'Your child is due for their pre-school vaccinations.',
      'Our records show you are due for a dental check-up.',
      'Please call the practice to book an appointment with the dentist or hygienist.',
      'NHS dental charges apply unless you are exempt.',
    ],
  },
  employment_contract: {
    sender: (r) => company(r, 'employer'),
    titles: [
      'Contract of employment',
      'Statement of main terms of employment',
      'Offer of employment',
      'Offer letter',
      'Employment agreement',
      'Fixed-term contract',
      'Written statement of particulars',
      'Terms and conditions of employment',
      'Variation to your contract',
    ],
    fields: [
      [['Employee', 'Employee name', 'Name'], (r) => full(person(r), r)],
      [['Employer', 'Company'], (r) => company(r, 'employer')],
      [
        ['Job title', 'Position', 'Role'],
        (r) =>
          r.pick([
            'Senior Analyst',
            'Warehouse Supervisor',
            'Staff Nurse',
            'Software Developer',
            'Teaching Assistant',
            'Marketing Executive',
            'Chef de Partie',
          ]),
      ],
      [['Start date', 'Commencement date', 'Date of commencement'], D],
      [['End date', 'Fixed term ends', 'The contract ends on', 'Expiry of contract'], D],
      [['Salary', 'Annual salary', 'Rate of pay', 'Hourly rate'], (r) => money(r, 18000, 90000)],
      [
        ['Hours of work', 'Working hours', 'Normal hours'],
        (r) => `${r.int(16, 40)} hours per week`,
      ],
      [
        ['Holiday entitlement', 'Annual leave', 'Holidays'],
        (r) => `${r.int(20, 33)} days plus bank holidays`,
      ],
      [['Notice period', 'Notice'], (r) => `${r.int(1, 12)} ${r.pick(['weeks', 'months'])}`],
      [['Probationary period', 'Probation'], (r) => `${r.int(3, 6)} months`],
      [['Place of work', 'Location', 'Normal place of work'], (r) => town(r)],
      [
        ['Pension', 'Pension scheme'],
        (r) =>
          r.pick([
            'Auto-enrolment, 5% employee and 3% employer',
            'Defined contribution scheme',
            'Stakeholder pension',
          ]),
      ],
      [['Reporting to', 'Line manager'], (r) => `${r.pick(FIRST)} ${r.pick(SURNAME)}`],
    ],
    sentences: [
      'We are delighted to offer you the position on the terms below.',
      'This offer is subject to satisfactory references and proof of your right to work in the UK.',
      'Please sign and return one copy of this contract.',
      'Either party may end this contract by giving the notice set out below.',
      'Your continuous employment began on the start date.',
      'Sick pay is paid in line with the company sickness policy.',
      'Signed for and on behalf of the company.',
      'You will be entitled to statutory sick pay.',
      'Your salary will be paid monthly in arrears by credit transfer into your bank account.',
      'Your gross salary will be reviewed each April.',
      'The disciplinary and grievance procedures are set out in the staff handbook.',
    ],
  },
  property_deed: {
    sender: (r) =>
      r.pick([
        'HM Land Registry',
        'Land Registry',
        company(r, 'solicitor'),
        company(r, 'agent'),
        'County Recorder',
      ]),
    titles: [
      'Official copy of register of title',
      'Title register',
      'Transfer of whole of registered title',
      'TR1',
      'Tenancy agreement',
      'Assured shorthold tenancy agreement',
      'Lease',
      'Deed of lease',
      'Warranty deed',
      'Grant deed',
      'Completion statement',
      'Leasehold information',
    ],
    fields: [
      [
        ['Title number', 'Title no', 'Parcel number', 'APN'],
        (r) => `${letters(r, 2)}${digits(r, 6)}`,
      ],
      [['Property', 'Property address', 'The property', 'Premises'], (r) => address(r).join(', ')],
      [
        ['Registered proprietor', 'Proprietor', 'Grantee', 'Buyer', 'Transferee'],
        (r) => full(person(r), r),
      ],
      [['Grantor', 'Seller', 'Transferor', 'Landlord'], (r) => full(person(r), r)],
      [['Tenant', 'Tenants', 'Lessee'], (r) => full(person(r), r)],
      [['Price paid', 'Consideration', 'Purchase price'], (r) => money(r, 80000, 900000)],
      [['Rent', 'Monthly rent', 'Ground rent'], (r) => money(r, 300, 3000)],
      [['Deposit', 'Tenancy deposit', 'Deposit protected with'], (r) => money(r, 300, 4000)],
      [
        ['Term', 'Length of tenancy', 'Term of years'],
        (r) => r.pick([`${r.int(6, 24)} months`, `${r.int(99, 999)} years`]),
      ],
      [['Start of tenancy', 'Commencement date', 'Date of completion', 'Edition date'], D],
      [['End of tenancy', 'The term ends on', 'Expiry of the term', 'Lease ends'], D],
      [
        ['Tenure', 'Class of title'],
        (r) => r.pick(['Freehold', 'Leasehold', 'Absolute freehold', 'Good leasehold']),
      ],
      [['Charge', 'Registered charge'], (r) => `${company(r, 'lender')} dated ${D(r)}`],
    ],
    sentences: [
      'This official copy shows the entries on the register of title on the date and time shown.',
      'A. Property Register. This register describes the land and estate comprised in the title.',
      'B. Proprietorship Register. This register specifies the class of title and identifies the owner.',
      'C. Charges Register. This register contains any charges and other matters that affect the land.',
      'The tenant agrees to pay the rent on the first day of each month.',
      'The tenant must keep the property clean and in good repair.',
      'Executed as a deed by the transferor in the presence of a witness.',
      'For and in consideration of the sum stated, the grantor grants to the grantee.',
    ],
  },
  will: {
    sender: (r) =>
      r.pick([
        company(r, 'solicitor'),
        'Office of the Public Guardian',
        `${town(r)} Will Writing Service`,
      ]),
    titles: [
      'LAST WILL AND TESTAMENT',
      'Last Will and Testament',
      'This is the last will',
      'Lasting power of attorney',
      'Lasting power of attorney for property and financial affairs',
      'Lasting power of attorney for health and welfare',
      'Codicil',
      'Declaration of trust',
      'Trust deed',
      'Will storage certificate',
    ],
    fields: [
      [['Testator', 'Testatrix', 'Donor', 'Settlor'], (r) => full(person(r), r)],
      [
        ['Executors', 'Executor', 'Attorneys', 'Trustees'],
        (r) => `${r.pick(FIRST)} ${r.pick(SURNAME)} and ${r.pick(FIRST)} ${r.pick(SURNAME)}`,
      ],
      [['Date of will', 'Dated', 'Date signed', 'Registered on'], D],
      [
        ['Witness', 'First witness', 'Second witness'],
        (r) => `${r.pick(FIRST)} ${r.pick(SURNAME)}, ${town(r)}`,
      ],
      [['Review on', 'Review date', 'Review by'], D],
      [
        ['Reference', 'LPA reference', 'Will reference'],
        (r) => `${letters(r, 1)}${digits(r, 4)}-${digits(r, 4)}-${digits(r, 4)}`,
      ],
      [['Guardian', 'Guardians'], (r) => `${r.pick(FIRST)} ${r.pick(SURNAME)}`],
    ],
    sentences: [
      'I revoke all former wills and testamentary dispositions made by me.',
      'I appoint my spouse to be the executor and trustee of this my will.',
      'I give all my estate to my trustees on trust to pay my debts and funeral expenses.',
      'I give the residue of my estate to my children in equal shares.',
      'Signed by the testator in our presence and then by us in theirs.',
      'If any beneficiary dies before me, their share passes to their children.',
      'I appoint the persons named as guardians of any minor children.',
      'This lasting power of attorney has been registered by the Office of the Public Guardian.',
      'My attorneys can make decisions jointly and severally.',
      'I wish my funeral to be simple.',
    ],
  },
  diploma: {
    sender: (r) =>
      r.pick([
        company(r, 'uni'),
        `${r.pick(WORDS)} Examinations Board`,
        'Awarding Body',
        company(r, 'school'),
      ]),
    titles: [
      'Degree certificate',
      'This is to certify that',
      'Bachelor of Science',
      'Master of Arts',
      'Diploma',
      'Certificate',
      'General Certificate of Secondary Education',
      'Advanced Level General Certificate of Education',
      'Statement of results',
      'Transcript of records',
      'Academic transcript',
      'Certificate of achievement',
      'Level 3 Diploma',
      'Certificate of completion',
    ],
    fields: [
      [['Awarded to', 'Candidate', 'Student', 'Name'], (r) => full(person(r), r)],
      [
        ['Qualification', 'Award', 'Degree', 'Programme'],
        (r) =>
          r.pick([
            'BSc (Hons) Biology',
            'MA History',
            'BA (Hons) English Literature',
            'BEng Civil Engineering',
            'Level 3 Diploma in Health and Social Care',
            'GCSE Mathematics',
            'A level Chemistry',
          ]),
      ],
      [
        ['Classification', 'Result', 'Grade', 'Class'],
        (r) =>
          r.pick([
            'First Class Honours',
            'Upper Second Class Honours',
            'Distinction',
            'Pass',
            'A*',
            'B',
            '7',
            '9',
          ]),
      ],
      [
        ['Date of award', 'Conferred on', 'Date awarded', 'Examination date', 'Date of completion'],
        D,
      ],
      [['Candidate number', 'Student number', 'ULN'], (r) => digits(r, r.pick([4, 8, 10]))],
      [['Centre number', 'Centre'], (r) => digits(r, 5)],
      [['Credits', 'Total credits'], (r) => String(r.int(60, 360))],
    ],
    sentences: [
      'having fulfilled the requirements of the University, was admitted to the degree.',
      'has been awarded the following qualification.',
      'Given under the seal of the University.',
      'This certificate remains the property of the awarding body.',
      'The candidate passed the examination with the grade shown.',
      'Signed by the Vice-Chancellor and the Registrar.',
      'Modules taken and grades achieved are listed below.',
      'Congratulations on your achievement.',
    ],
  },
  visa: {
    sender: (r) =>
      r.pick([
        'UK Visas and Immigration',
        'Home Office',
        'U.S. Department of State',
        'Department of Home Affairs',
        'Immigration, Refugees and Citizenship Canada',
        'Embassy of the United States',
      ]),
    titles: [
      'Biometric residence permit',
      'Residence permit',
      'Visa',
      'Entry clearance',
      'Your eVisa',
      'Decision on your application',
      'Permanent residence card',
      'Leave to remain',
      'Visitor visa',
      'Work permit',
      'Immigration status confirmation',
    ],
    fields: [
      [['Name', 'Surname', 'Given names', 'Holder'], (r) => full(person(r), r)],
      [
        ['Type of permit', 'Visa type', 'Category', 'Type'],
        (r) =>
          r.pick([
            'LEAVE TO REMAIN',
            'Skilled Worker',
            'Student',
            'B1/B2',
            'Family',
            'Settlement',
            'INDEFINITE LEAVE TO REMAIN',
            'Visitor',
          ]),
      ],
      [['Valid from', 'Start date', 'Issue date'], D],
      [['Valid until', 'Expires', 'Expiry date', 'Valid to', 'Expiration date'], D],
      [
        ['Remarks', 'Conditions', 'Annotation'],
        (r) =>
          r.pick([
            'Work permitted',
            'No recourse to public funds',
            'Work limited 20 hrs per week in term time',
            'NO PUBLIC FUNDS',
          ]),
      ],
      [
        [
          'Permit number',
          'Visa number',
          'Control number',
          'Document number',
          'Unique application number',
        ],
        (r) => `${letters(r, 2)}${digits(r, 7)}`,
      ],
      [['Entries', 'Number of entries'], (r) => r.pick(['M', 'Multiple', '1', 'Single'])],
      [
        ['Nationality'],
        (r) => r.pick(['INDIAN', 'NIGERIAN', 'PAKISTANI', 'AMERICAN', 'BRAZILIAN', 'CHINESE']),
      ],
      [
        ['Share code', 'Your share code'],
        (r) => `${letters(r, 3)} ${letters(r, 3)} ${letters(r, 3)}`,
      ],
      [['Place of issue', 'Issuing post'], (r) => r.pick(['UK', 'LONDON', 'MUMBAI', 'LAGOS'])],
    ],
    sentences: [
      'Your application has been granted. Your immigration status is shown below.',
      'You can prove your immigration status online with a share code.',
      'You must leave the UK before your permission ends unless you apply to extend it.',
      'This permit is evidence of your right to live and work in the UK.',
      'Report a lost or stolen residence permit immediately.',
      'Keep your eVisa details up to date.',
      'The visa does not guarantee entry.',
    ],
  },
  warranty: {
    sender: (r) => company(r, 'shop'),
    titles: [
      'Guarantee certificate',
      'Warranty certificate',
      'Extended warranty',
      'VAT receipt',
      'Receipt',
      'Product registration confirmation',
      'Care plan certificate',
      'Protection plan',
      'Proof of purchase',
      'Your guarantee is registered',
      "Manufacturer's warranty",
      'Tax invoice',
    ],
    fields: [
      [['Date of purchase', 'Purchase date', 'Date'], D],
      [
        ['Product', 'Item', 'Description', 'Appliance'],
        (r) =>
          `${r.pick(WORDS)} ${r.pick(['washing machine', 'dishwasher', 'laptop 14"', 'fridge freezer', 'cordless vacuum', 'television 55"', 'coffee machine', 'tumble dryer', 'mobile phone', 'sofa', 'boiler', 'lawn mower'])}`,
      ],
      [
        ['Model', 'Model number', 'Model no'],
        (r) => `${letters(r, 2)}${digits(r, 3)}-${letters(r, 1)}`,
      ],
      [['Serial number', 'Serial no', 'S/N', 'IMEI'], (r) => `${letters(r, 3)}${digits(r, 7)}`],
      [
        ['Guarantee period', 'Warranty period', 'Cover', 'Plan length'],
        (r) => `${r.int(1, 10)} years`,
      ],
      [
        [
          'Guarantee expires',
          'Warranty expires',
          'Covered until',
          'Cover ends',
          'Valid until',
          'Warranty end date',
        ],
        D,
      ],
      [['Receipt no', 'Invoice number', 'Transaction'], (r) => digits(r, 8)],
      [['Total', 'Total paid', 'Amount', 'Price'], (r) => money(r, 15, 2500)],
      [['Customer', 'Registered to', 'Sold to'], (r) => full(person(r), r)],
      [['Store', 'Retailer', 'Sold by'], (r) => `${company(r, 'shop')}, ${town(r)}`],
      [
        ['Payment', 'Paid by'],
        (r) => r.pick(['Card', 'Visa debit', 'Cash', 'Mastercard', 'PayPal']),
      ],
    ],
    sentences: [
      'Your product is guaranteed against faults in materials and workmanship.',
      'Keep this receipt as proof of purchase for your guarantee.',
      'Register your product online to activate your extended guarantee.',
      'This warranty does not cover accidental damage or normal wear and tear.',
      'If your appliance breaks down, call our repair line.',
      'Your statutory rights are not affected.',
      'Returns accepted within 30 days with this receipt.',
      'Your care plan covers parts and labour.',
    ],
  },
  pet_record: {
    sender: (r) => company(r, 'vet'),
    titles: [
      'Vaccination certificate',
      'Vaccination record',
      'Pet health record',
      'Invoice',
      'Treatment invoice',
      'Pet passport',
      'Microchip registration certificate',
      'Clinical history',
      'Consultation summary',
      'Neutering certificate',
    ],
    fields: [
      [
        ["Pet's name", 'Animal', 'Patient', 'Pet'],
        (r) =>
          r.pick([
            'Biscuit',
            'Luna',
            'Toby',
            'Pickle',
            'Hazel',
            'Otis',
            'Mochi',
            'Jasper',
            'Clover',
          ]),
      ],
      [['Species', 'Species/Breed'], (r) => r.pick(['Canine', 'Feline', 'Dog', 'Cat', 'Rabbit'])],
      [
        ['Breed'],
        (r) =>
          r.pick([
            'Labrador',
            'Cocker spaniel',
            'Domestic shorthair',
            'Border collie',
            'Dachshund',
            'Lop',
          ]),
      ],
      [['Microchip number', 'Microchip', 'Transponder'], (r) => digits(r, 15)],
      [['Owner', "Owner's name", 'Client'], (r) => full(person(r), r)],
      [
        ['Vaccine', 'Vaccination', 'Treatment'],
        (r) =>
          r.pick([
            'DHP + Lepto',
            'Kennel cough',
            'Feline enteritis and cat flu',
            'Rabies',
            'Myxomatosis/RVHD',
            'Flea and worm treatment',
          ]),
      ],
      [['Date given', 'Date of vaccination', 'Date of visit', 'Consultation date'], D],
      [['Next due', 'Revaccination date', 'Valid until', 'Due date'], D],
      [
        ['Vet', 'Veterinary surgeon', 'Vet surgeon MRCVS'],
        (r) => `${r.pick(FIRST)} ${r.pick(SURNAME)} MRCVS`,
      ],
      [['Weight', 'Body weight'], (r) => `${r.int(2, 40)}.${r.int(0, 9)} kg`],
      [['Amount', 'Total', 'Consultation'], (r) => money(r, 20, 400)],
      [['Date of birth', 'Age'], (r) => r.pick([D(r), `${r.int(1, 14)} years`])],
    ],
    sentences: [
      'Annual health checks help us spot problems early.',
      'Keep this record safe. You will need it for boarding kennels and catteries.',
      "Your pet's microchip is registered to the owner shown.",
      'Flea and worm treatment should be given every month.',
      'Thank you for visiting the practice today.',
      'Please keep your pet indoors for 24 hours after the procedure.',
      'Remember to update your details on the microchip database if you move house.',
    ],
  },
  national_id: {
    sender: (r) =>
      r.pick([
        'HM Revenue & Customs',
        'HMRC',
        'Department for Work and Pensions',
        'Social Security Administration',
        'National Identity Office',
        'Civil Registry',
      ]),
    titles: [
      'Your National Insurance number',
      'National Insurance number letter',
      'Social Security card',
      'National identity card',
      'Identity card',
      'Proof of your National Insurance number',
      'Citizen card',
      'Residence card',
    ],
    fields: [
      [
        [
          'National Insurance number',
          'Your National Insurance number is',
          'NI number',
          'Social Security number',
          'SSN',
          'ID number',
          'Personal number',
        ],
        (r) =>
          r.pick([
            `${letters(r, 2)} ${digits(r, 2)} ${digits(r, 2)} ${digits(r, 2)} ${r.pick(['A', 'B', 'C', 'D'])}`,
            `${digits(r, 3)}-${digits(r, 2)}-${digits(r, 4)}`,
          ]),
      ],
      [['Name', 'Surname', 'Given names'], (r) => full(person(r), r)],
      [['Date of birth'], D],
      [['Date of issue', 'Issued'], D],
      [['Date of expiry', 'Expiry', 'Valid until'], D],
      [['Card number', 'Document number', 'CAN'], (r) => `${letters(r, 3)}${digits(r, 6)}`],
      [['Nationality'], (r) => r.pick(['IRISH', 'SPANISH', 'POLISH', 'ITALIAN', 'PORTUGUESE'])],
    ],
    sentences: [
      'This letter tells you your National Insurance number. Keep it safe.',
      'Your National Insurance number makes sure your contributions and tax are recorded against your name only.',
      'You will need it if you start work or claim benefits.',
      'This number has been established for you. Keep your card in a safe place.',
      'Do not carry your card with you. Do not laminate.',
      'This card is the property of the issuing state.',
      'This letter is not proof of identity.',
    ],
  },
  school_report: {
    sender: (r) => company(r, 'school'),
    titles: [
      'End of year report',
      'School report',
      'Interim report',
      'Annual report to parents',
      'Autumn term report',
      'Summer term report',
      'Progress review',
      'Report card',
    ],
    fields: [
      [['Pupil', 'Student', 'Pupil name', 'Name'], (r) => full(person(r), r)],
      [
        ['Year group', 'Year', 'Form', 'Class', 'Grade'],
        (r) =>
          r.pick([
            `Year ${r.int(1, 13)}`,
            `${r.int(7, 11)}${letters(r, 1)}`,
            `Class ${r.pick(['Oak', 'Willow', 'Hazel', 'Birch'])}`,
          ]),
      ],
      [['Attendance', 'Attendance this year'], (r) => `${r.int(85, 100)}.${r.int(0, 9)}%`],
      [['Punctuality', 'Late marks', 'Absences'], (r) => String(r.int(0, 12))],
      [
        ['Form tutor', 'Class teacher', 'Teacher'],
        (r) => `${r.pick(['Mr', 'Mrs', 'Ms', 'Miss'])} ${r.pick(SURNAME)}`,
      ],
      [
        ['Head teacher', 'Headteacher', 'Principal', 'Head of Year'],
        (r) => `${r.pick(['Mr', 'Mrs', 'Ms', 'Dr'])} ${r.pick(SURNAME)}`,
      ],
      [
        ['Date', 'Report date', 'Term'],
        (r) => r.pick([D(r), `${r.pick(['Autumn', 'Spring', 'Summer'])} ${r.int(2018, 2027)}`]),
      ],
      [
        ['Behaviour', 'Conduct', 'Attitude to learning'],
        (r) => r.pick(['Excellent', 'Good', 'Requires improvement', 'Outstanding']),
      ],
    ],
    sentences: [
      'It has been a pleasure to teach this pupil this year.',
      'Working at the expected standard in reading, writing and maths.',
      'Effort grades: 1 excellent, 2 good, 3 satisfactory, 4 cause for concern.',
      'Next steps: to read more widely and check work carefully.',
      'A conscientious member of the class who contributes well to discussions.',
      'Targets for next term are set out below.',
      'Please sign and return the reply slip.',
      'Attainment is measured against age-related expectations.',
    ],
    extra: (r) => {
      const rows = [r.pick(['SUBJECT  GRADE  TARGET', 'Area of learning    Grade    Next step'])];
      for (const s of r.some(
        [
          'English',
          'Maths',
          'Science',
          'History',
          'Geography',
          'French',
          'Art',
          'Music',
          'PE',
          'Computing',
          'RE',
          'Design technology',
        ],
        3,
        8,
      )) {
        rows.push(
          `${s}  ${r.pick(['Expected', 'Greater depth', 'Working towards', 'A', 'B', '6', '7', 'Secure'])}  ${r.int(1, 4)}`,
        );
      }
      return rows;
    },
  },
};

/** Papers of no kind the vault keeps: what else comes through the door. */
const NONE = [
  (r) => [
    company(r, 'club'),
    r.pick(['Newsletter', 'Spring newsletter', 'News from the committee', "Members' bulletin"]),
    ...r.some(
      [
        'Thank you to all our volunteers this season.',
        'Our annual general meeting will be held in the village hall.',
        'New members are always welcome, whatever your level.',
        'Subscriptions for next year are now due.',
        'Dates for your diary are listed below.',
        'Teas will be served after the match.',
      ],
      2,
      5,
    ),
    `Next meeting: ${D(r)}`,
  ],
  (r) => [
    company(r, 'cafe'),
    r.pick(['MENU', 'Takeaway menu', 'Order online', 'Opening hours']),
    ...r.some(
      [
        'Margherita  £8.50',
        'Chicken tikka masala  £9.95',
        'Chips  £2.80',
        'Vegetable spring rolls (4)  £3.90',
        'Free delivery on orders over £20',
        'Open 7 days 5pm till late',
        'Allergen information available on request',
        'Lunch special 12-3pm',
      ],
      3,
      7,
    ),
    phone(r),
  ],
  (r) => [
    company(r, 'agent'),
    r.pick([
      'Thinking of selling?',
      'We have buyers waiting in your area',
      'Free valuation',
      'Recently sold near you',
    ]),
    ...r.some(
      [
        'Properties in your street are in high demand.',
        'Book a free, no obligation valuation today.',
        'We sold a three bedroom semi nearby in just 9 days.',
        'Our fees start from 0.9% including VAT.',
        'Call our friendly team.',
      ],
      2,
      4,
    ),
  ],
  (r) => [
    company(r, r.pick(['bank', 'insurer', 'energy', 'telecom', 'card'])),
    r.pick([
      'A special offer for you',
      'Switch and save',
      'You could save with us',
      'Introducing our new app',
      'Have your say',
      'Important changes to our terms are coming',
    ]),
    ...r.some(
      [
        'As a valued customer, we would like to tell you about a new product.',
        'Apply online in minutes.',
        'This is a marketing message. You can opt out at any time.',
        'Terms and conditions apply. Offer ends soon.',
        'Take our short survey and you could win a prize draw.',
        'We are updating our privacy notice. You do not need to do anything.',
        'Our branches will have new opening hours from next month.',
      ],
      3,
      5,
    ),
    `Dear ${person(r).first},`,
  ],
  (r) => [
    company(r, 'school'),
    r.pick([
      'School newsletter',
      'Letter to parents',
      'School trip',
      'Dates for the term',
      'Uniform reminder',
      'Parents evening',
    ]),
    ...r.some(
      [
        'Non-uniform day this Friday in aid of charity.',
        'Please label all items of uniform.',
        'Book your parents evening slot online.',
        'The school will close at 1.30pm on the last day of term.',
        'Packed lunches will be provided for children on free school meals.',
      ],
      2,
      5,
    ),
    `${r.pick(['Head teacher', 'Office'])}`,
  ],
  (r) => [
    company(r, 'council'),
    r.pick([
      'Your bin collection calendar',
      'Recycling collections',
      'Have your say on local plans',
      'Garden waste subscription',
      'Poll card',
      'Polling card',
      'Parking permit',
      'Library notice',
    ]),
    ...r.some(
      [
        'Put your bins out by 7am on your collection day.',
        'Blue bin: paper and card. Green bin: garden waste.',
        'Collections may change over bank holidays.',
        'Tell us what you think about the plans for the high street.',
        'You are registered to vote at the address shown.',
        'Your polling station is the community centre.',
        'Display this permit clearly in your windscreen.',
        'Your library books are due back. You can renew them online.',
      ],
      2,
      5,
    ),
    `Valid: ${D(r)}`,
  ],
  (r) => [
    r.pick([
      "You're invited!",
      'Save the date',
      'Party invitation',
      'Wedding invitation',
      'Birthday celebration',
    ]),
    `${person(r).first} is turning ${r.int(5, 70)}`,
    ...r.some(
      [
        'Please join us for food, music and dancing.',
        'RSVP by the date below.',
        'Dress code: smart casual.',
        'Children welcome.',
        'No gifts please, just your company.',
      ],
      2,
      4,
    ),
    `${D(r)} at ${r.int(1, 9)}pm`,
  ],
  (r) => [
    company(r, r.pick(['shop', 'cafe', 'club'])),
    r.pick(['Your delivery note', 'Dispatch note', 'Packing slip', 'Collection ticket']),
    ...r.some(
      [
        'Items in this parcel are listed below.',
        'Please check your items on arrival.',
        'Signed for by the customer.',
        'Leave in a safe place: porch.',
        '1 x Garden hose 30m',
        '2 x Bird seed 2kg',
      ],
      3,
      5,
    ),
  ],
  (r) => [
    r.pick([
      'Recipe',
      'Weekend plans',
      'Shopping list',
      'Packing list',
      'Chores this week',
      'Notes',
    ]),
    ...r.some(
      [
        '250g plain flour',
        '2 eggs, beaten',
        'Bake at 180C for 25 minutes',
        'Milk, bread, apples, washing up liquid',
        'Passports! Chargers, sun cream',
        'Take the recycling out on Tuesday',
        'Call the plumber about the tap',
        'Water the tomatoes',
      ],
      3,
      6,
    ),
  ],
  (r) => [
    r.pick([company(r, 'club'), `${town(r)} Leisure Centre`, `${r.pick(WORDS)} Fitness`]),
    r.pick(['Welcome to the club', 'Your membership', 'Class timetable', 'Booking confirmation']),
    ...r.some(
      [
        'Your membership gives you access to the gym, pool and classes.',
        'Classes can be booked up to 7 days ahead.',
        'Please bring a towel and a padlock.',
        'Monthly fee collected by Direct Debit.',
        'Swimming lessons for under 8s on Saturday mornings.',
        'Your booking is confirmed for court 2.',
      ],
      2,
      5,
    ),
    `Member no. ${digits(r, 7)}`,
  ],
  (r) => [
    r.pick([
      `${town(r)} Parish Church`,
      `${town(r)} Community Centre`,
      `${r.pick(WORDS)} Foundation`,
      `${town(r)} Hospice`,
      `${r.pick(WORDS)} Animal Rescue`,
    ]),
    r.pick([
      'Thank you for your donation',
      'Our appeal',
      'News and events',
      'Gift Aid declaration',
      'Volunteer with us',
    ]),
    ...r.some(
      [
        'Your generous gift will make a real difference.',
        'With Gift Aid your donation is worth 25% more.',
        'Our coffee morning is every Wednesday.',
        'We rely on volunteers to keep our doors open.',
        'Please remember us in your plans.',
      ],
      2,
      4,
    ),
  ],
  (r) => [
    r.pick([
      `${r.pick(WORDS)} Travel`,
      `${r.pick(WORDS)} Holidays`,
      `${r.pick(WORDS)} Airways`,
      `${r.pick(WORDS)} Rail`,
    ]),
    r.pick(['Your itinerary', 'Booking confirmation', 'E-ticket', 'Boarding pass', 'Your trip']),
    ...r.some(
      [
        'Check in opens 24 hours before departure.',
        'Seat 23C. Gate closes 30 minutes before departure.',
        'Your hotel: 7 nights, half board.',
        'Coach transfers are included.',
        'Please arrive at the station 15 minutes early.',
        'Coach C, seat 41.',
      ],
      3,
      5,
    ),
    `Departure: ${D(r)}`,
  ],
  (r) => [
    r.pick([
      'Dear neighbour',
      'To the occupier',
      'Notice to residents',
      'Road closure',
      'Planned works in your area',
    ]),
    ...r.some(
      [
        'We will be resurfacing the road over three nights.',
        'Please move your car before 8am.',
        'We apologise for any noise or disruption.',
        'Water may be off for up to four hours.',
        'A planning application has been made for the land behind your home.',
        'Please keep this notice for reference.',
      ],
      2,
      5,
    ),
    company(r, r.pick(['council', 'water', 'energy'])),
  ],
  (r) => [
    r.pick([
      `${town(r)} Theatre`,
      `${r.pick(WORDS)} Cinema`,
      `${town(r)} Festival`,
      `${r.pick(WORDS)} Arena`,
    ]),
    r.pick(['Your tickets', 'Ticket', 'Admit one', "What's on"]),
    ...r.some(
      [
        'Doors open 7pm, show starts 7.30pm.',
        'Stalls row F seats 12-13.',
        'Please present this ticket at the door.',
        'No refunds or exchanges.',
        'Free programme with every booking this month.',
      ],
      2,
      4,
    ),
    D(r),
  ],
];

/**
 * Letters of no kind, set out as the kinds' letters are (a letterhead, an
 * address, a date, "Dear …", a signature): so the shape of a letter says
 * nothing of its kind, only its words do.
 */
const NONE_LETTERS = [
  {
    sender: (r) => company(r, r.pick(['bank', 'insurer', 'energy', 'telecom', 'card', 'lender'])),
    titles: [
      'Changes to your terms',
      'Important information about your account',
      'We are updating our terms and conditions',
      'Our new app',
      'A change to our opening hours',
      'Your feedback',
      'Thank you for being a customer',
      'Moving home?',
    ],
    fields: [
      [['Your reference', 'Customer reference'], ref],
      [['Changes take effect', 'From'], D],
    ],
    sentences: [
      'We are writing to let you know about some changes we are making.',
      'You do not need to do anything.',
      'The full terms are on our website, or we can post you a copy.',
      'If you are not happy with the changes, you can close your account without charge.',
      'We would love to hear what you think of our service.',
      'Our branch on the high street will close on the date below.',
      'Tell us your new address before you move.',
    ],
  },
  {
    sender: (r) =>
      r.pick([
        `${town(r)} Hospice`,
        `${r.pick(WORDS)} Animal Rescue`,
        `${town(r)} Food Bank`,
        `${r.pick(WORDS)} Children's Trust`,
        `${town(r)} Air Ambulance`,
        `${town(r)} Parish Church`,
      ]),
    titles: [
      'Thank you',
      'Thank you for your gift',
      'Our winter appeal',
      'Your support matters',
      'Gift Aid declaration',
      'Volunteer with us',
    ],
    fields: [
      [['Supporter number', 'Donor ref'], (r) => digits(r, 7)],
      [['Gift', 'Your donation'], (r) => money(r, 5, 200)],
    ],
    sentences: [
      'Thank you so much for your generous donation.',
      'Your support helps us be there for local families when they need it most.',
      'With Gift Aid, your gift is worth a quarter more to us at no extra cost to you.',
      'With warm wishes and thanks,',
      'The fundraising team',
      'We would love you to join us at our open day.',
    ],
  },
  {
    sender: (r) => company(r, 'school'),
    titles: [
      'Letter to parents and carers',
      'School trip',
      'Year 6 residential',
      'Sports day',
      'Term dates',
      'Uniform',
      'Parents evening',
      'Consent form',
    ],
    fields: [
      [['Pupil', 'Child'], (r) => full(person(r), r)],
      [['Cost', 'Contribution'], (r) => money(r, 2, 300)],
      [['Return by', 'Reply by', 'Date of trip'], D],
    ],
    sentences: [
      'Dear Parents and Carers,',
      'We are delighted to tell you about a visit to the local museum.',
      'Payment can be made through the school payments app.',
      'Sports day will go ahead whatever the weather.',
      'Yours faithfully,',
      'Head of Year',
    ],
  },
  {
    sender: (r) => company(r, 'council'),
    titles: [
      'Residents parking permit',
      'Your permit',
      'Bin collection changes',
      'Planning application near you',
      'Electoral registration',
      'Poll card',
      'Street works',
    ],
    fields: [
      [['Permit number', 'Reference', 'Elector number'], ref],
      [['Zone', 'Ward', 'Polling station'], (r) => `${letters(r, 1)}${r.int(1, 9)}`],
      [['Expires', 'Valid until', 'Date of poll'], D],
    ],
    sentences: [
      'Your permit lets you park in the zone shown.',
      'Renew online before your permit runs out.',
      'Your collection day is changing.',
      'You can comment on the application online.',
      'You are registered to vote. You do not need to take this card to vote.',
      'We are sorry for any disruption.',
    ],
  },
  {
    sender: (r) =>
      r.pick([
        `${town(r)} Leisure Centre`,
        `${r.pick(WORDS)} Fitness`,
        company(r, 'club'),
        `${r.pick(WORDS)} Golf Club`,
      ]),
    titles: [
      'Welcome to the club',
      'Your membership',
      'Membership renewal',
      'Class timetable',
      'Booking confirmed',
    ],
    fields: [
      [['Member', 'Name'], (r) => full(person(r), r)],
      [['Membership number', 'Member no'], (r) => digits(r, 7)],
      [['Renews on', 'Start date'], D],
      [['Monthly fee', 'Fee'], (r) => money(r, 10, 80)],
    ],
    sentences: [
      'Welcome! Your membership gives you access to the gym, pool and classes.',
      'Your membership will renew automatically.',
      'Your fee will be collected by Direct Debit.',
      'Book classes in our app up to a week ahead.',
    ],
  },
  {
    sender: (r) =>
      r.pick([
        `${r.pick(WORDS)} Travel`,
        `${r.pick(WORDS)} Holidays`,
        `${r.pick(WORDS)} Airways`,
        `${r.pick(WORDS)} Rail`,
        `${town(r)} Theatre`,
      ]),
    titles: ['Booking confirmation', 'Your itinerary', 'E-ticket', 'Your tickets', 'Your trip'],
    fields: [
      [['Booking reference', 'Confirmation number'], (r) => letters(r, 6)],
      [['Departure', 'Date', 'Performance'], D],
      [['Passengers', 'Guests'], (r) => full(person(r), r)],
      [['Total paid', 'Price'], (r) => money(r, 20, 3000)],
    ],
    sentences: [
      'Thank you for booking with us.',
      'Check in online from 24 hours before you fly.',
      'Please arrive in good time.',
      'Your seats are shown below.',
      'No refunds or exchanges.',
    ],
  },
];

// ---------------------------------------------------------------- one paper

/** A labelled detail, as papers set them out. */
function labelled(r, label, value) {
  if (value === '') return label;
  return r.pick([
    () => `${label}: ${value}`,
    () => `${label}: ${value}`,
    () => `${label}  ${value}`,
    () => `${label}${' '.repeat(r.int(3, 18))}${value}`,
    () => `${label} ${value}`,
    () => `${label}\n${value}`,
    () => `${label.toUpperCase()}: ${value}`,
  ])();
}

/** One paper of a kind, as text. */
function paperOf(r, spec) {
  // A card's face alone: its numbered details, and nothing else.
  if (spec.card && r.chance(0.35)) return spec.card(r).join('\n');
  const sender = spec.sender(r);
  const blocks = [];
  // The letterhead.
  const head = [r.chance(0.3) ? sender.toUpperCase() : sender];
  if (r.chance(0.6)) head.push(...address(r).slice(0, r.int(1, 3)));
  if (r.chance(0.4))
    head.push(r.pick([`Tel ${phone(r)}`, `${phone(r)}  ${web(r, sender)}`, web(r, sender)]));
  blocks.push(head);
  // To whom, and when.
  const who = person(r);
  if (r.chance(0.5)) blocks.push([full(who, r), ...address(r)]);
  if (r.chance(0.5)) blocks.push([r.pick(['', 'Date: ', 'Dated ', 'Issued: ']) + D(r)]);
  // What it is.
  let title = r.pick(spec.titles);
  if (r.chance(0.2)) title = title.toUpperCase();
  blocks.push([title]);
  if (r.chance(0.35))
    blocks.push([
      `Dear ${r.pick([`${who.title} ${who.last}`, who.first, 'Customer', 'Sir or Madam', 'Parent/Carer'])},`,
    ]);
  // Its details, some of them, in an order of their own.
  const fields = r
    .some(spec.fields, 3, 10)
    .map(([labels, value]) => labelled(r, r.pick(labels), value(r)));
  const said = r.some(spec.sentences, 1, 4);
  const rest = [fields];
  if (said.length > 0) rest.push(said);
  if (spec.extra && r.chance(0.6)) rest.push(spec.extra(r));
  if (r.chance(0.4)) rest.push(r.some(GENERIC, 1, 3));
  blocks.push(...(r.chance(0.5) ? rest : r.shuffle(rest)));
  if (r.chance(0.3)) blocks.push(r.some(spec.sentences, 1, 2));
  if (r.chance(0.35)) {
    const signer = person(r);
    blocks.push([
      r.pick(['Yours sincerely,', 'Yours faithfully,', 'Kind regards,', 'With best wishes,']),
      `${r.pick([signer.title, ''])} ${signer.first} ${signer.last}`.trim(),
      r.pick([
        'Customer Services',
        'Manager',
        'Team Leader',
        'Head of Service',
        'Partner',
        'Administrator',
      ]),
    ]);
  }
  if (r.chance(0.6)) blocks.push(r.some(FOOTER, 1, 3).map((f) => f(r)));
  return blocks.map((b) => b.join('\n')).join(r.pick(['\n\n', '\n', '\n\n\n']));
}

/** A paper of no kind: a letter set out as the kinds' are, or a leaflet, a menu, a list. */
function nonePaper(r) {
  if (r.chance(0.5)) return paperOf(r, r.pick(NONE_LETTERS));
  const lines = r.pick(NONE)(r);
  if (r.chance(0.4)) lines.splice(1, 0, ...address(r));
  if (r.chance(0.3)) lines.push(...r.some(GENERIC, 1, 2));
  if (r.chance(0.3)) lines.push(r.pick(FOOTER)(r));
  return lines.join(r.pick(['\n', '\n\n']));
}

// ---------------------------------------------------------------- as OCR reads a scan

const CONFUSE = [
  ['m', 'rn'],
  ['rn', 'm'],
  ['l', '1'],
  ['I', 'l'],
  ['1', 'l'],
  ['O', '0'],
  ['0', 'O'],
  ['e', 'c'],
  ['c', 'e'],
  ['h', 'b'],
  ['a', 'o'],
  ['u', 'n'],
  ['S', '5'],
  ['5', 'S'],
  ['B', '8'],
  ['g', 'q'],
  ['cl', 'd'],
  ['d', 'cl'],
  ['i', 'j'],
  ['t', 'f'],
  ['.', ','],
  [',', '.'],
];
const JUNK = ['|', '~', '»', '«', '—', '_', '‘', '’', ';', ':', '*', '°', '^', '/'];

/**
 * The text as OCR might give a spoilt scan of the page: `light` a few
 * letters confused; `medium` words lost and specks read as marks too;
 * `columns` two columns run together on one line; `turned` mostly nonsense
 * with a few real words; `cut` only its first part.
 */
export function spoil(r, text, how) {
  const confuse = (w, p) => {
    let out = w;
    if (r.chance(p)) {
      const [a, b] = r.pick(CONFUSE);
      const at = out.indexOf(a);
      if (at >= 0) out = out.slice(0, at) + b + out.slice(at + a.length);
    }
    return out;
  };
  const words = (line, p, lose, junk) =>
    line
      .split(' ')
      .filter(() => !r.chance(lose))
      .map((w) => confuse(w, p))
      .map((w) => (r.chance(junk) ? `${w}${r.pick(JUNK)}` : w))
      .join(' ');
  const lines = text.split('\n');
  switch (how) {
    case 'light':
      return lines.map((l) => words(l, 0.06, 0.01, 0.01)).join('\n');
    case 'medium':
      return lines
        .filter(() => !r.chance(0.08))
        .map((l) => words(l, 0.15, 0.08, 0.05))
        .map((l) => (r.chance(0.05) ? `${l} ${r.pick(JUNK)}${r.pick(JUNK)}` : l))
        .join('\n');
    case 'columns': {
      const half = Math.ceil(lines.length / 2);
      const out = [];
      for (let i = 0; i < half; i += 1)
        out.push(`${lines[i] ?? ''}${' '.repeat(r.int(1, 6))}${lines[half + i] ?? ''}`.trim());
      return out.map((l) => words(l, 0.04, 0.01, 0.01)).join('\n');
    }
    case 'turned':
      return lines
        .map((l) =>
          l
            .split(' ')
            .map((w) =>
              r.chance(0.75)
                ? Array.from({ length: Math.max(1, w.length) }, () =>
                    r.pick("aeiounrstlmwvx.,;:'|".split('')),
                  ).join('')
                : w,
            )
            .join(' '),
        )
        .join('\n');
    case 'cut':
      return lines
        .slice(0, Math.max(3, Math.floor(lines.length * (0.3 + 0.4 * r.next()))))
        .join('\n');
    default:
      return text;
  }
}

// ---------------------------------------------------------------- the corpus

/** The kinds it learns: the vault's built-in kinds (never "Something else"), and `none`. */
export const READING_MODEL_KINDS = [...Object.keys(KINDS).sort(), 'none'];

/**
 * The training papers for a seed: `per` of each kind and twice that of no
 * kind, a share of each spoilt as a scan's OCR is. The same seed gives the
 * same papers.
 */
export function readingModelCorpus({ seed = 1, per = 300 } = {}) {
  const out = [];
  for (const kind of READING_MODEL_KINDS) {
    const n = kind === 'none' ? per * 2 : per;
    for (let i = 0; i < n; i += 1) {
      const r = seeded(seed, `${kind}:${i}`);
      let text = kind === 'none' ? nonePaper(r) : paperOf(r, KINDS[kind]);
      const roll = r.next();
      const how =
        roll < 0.55
          ? 'clean'
          : roll < 0.72
            ? 'light'
            : roll < 0.84
              ? 'medium'
              : roll < 0.91
                ? 'columns'
                : roll < 0.95
                  ? 'cut'
                  : 'turned';
      text = spoil(r, text, how);
      out.push({ kind, text, how });
    }
  }
  return out;
}

// --------------------------------------------------------------------- CLI

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const option = (name, fallback) => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : fallback;
  };
  const out = option('out', null);
  if (!out) {
    console.error('usage: reading-model-corpus.mjs --out <file.jsonl> [--seed 1] [--per 300]');
    process.exit(2);
  }
  const papers = readingModelCorpus({
    seed: Number(option('seed', '1')),
    per: Number(option('per', '300')),
  });
  mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  writeFileSync(out, `${papers.map((p) => JSON.stringify(p)).join('\n')}\n`);
  console.log(`${papers.length} papers written to ${out}`);
}
