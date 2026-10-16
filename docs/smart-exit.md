# The Smart exit, measured (0.8.0)

The Phase 6 "Smart" exit asks that a folder of two hundred mixed PDFs imports with fewer than ten needing manual typing, and that no item the vault calls Ready is wrong. This is what was measured on 16 October 2026, at `feat/8.s5-exit`.

**Result: wrong Ready is 0; 26 of the 200 need typing with folder names, so the target of fewer than ten is not met.** Of the papers whose layouts the rules were adjusted on, 9 of 121 need typing; of the held-out layouts, 17 of 79.

## The corpus

`node scripts/smart-corpus.mjs --out <folder> [--seed 1]` writes it, with `manifest.json` (the truth for each file). The same seed gives the same bytes. `scripts/demo-seed.mjs --out <folder> --corpus` writes it for a demo vault it has just filled, adding the two people the papers name who have no sign-in.

- **The household:** a made-up family of five (an owner, an adult, a teen, a child and a grandmother), plus a few unknown names, such as a previous occupant's post. Every company, bank, insurer, school and number is invented.
- **Kinds:** 180 papers of 21 kinds: bank statements (30), bills (35), medical letters (18), insurance (14), warranties and receipts (14), passports (9), tax forms (9), pet records (7), prescriptions (6), school reports and certificates (6), and others. There are also 20 papers of no kind (menus, newsletters, letters).
- **Mixed:**
  - 118 PDFs carry their own words, in three typefaces and several layouts. Dates come in nine styles, including a UK passport's bilingual one.
  - 82 are image-only scans, drawn by the generator from glyphs of the DejaVu fonts, skewed up to 2.5°, specked, grey or black-and-white, at 100–200 dpi.
  - Six papers have more than one page, three are blank or nearly blank, two have the same bytes as another, and one is scanned again.
- **The folder tree:** tidy folders (`Ahmed/Passport`, `Bills/2026`, `Medical/Granny Farida`), a flat `Scans/` folder of 44 files, a `Downloads/` folder, and six papers filed in the wrong folder.
- **Sets:** each layout is in one set. **Tune** (121 papers) holds the layouts the rules could be adjusted to read. **Held out** (79 papers) was written the same way but never used to change a rule. No number or text is copied from 5.37's fixtures.

## Method

`apps/api/src/smart-exit.test.ts`, run with `FDV_SMART_EXIT=1` in `node:22-alpine` with poppler, ImageMagick and Tesseract (the worker's tools) against the test database:

1. The household is set up through the API (country GB).
2. All 200 files go into one batch with Add → Many documents, each with its `relative_path` as the web sends it.
3. The worker's own jobs draw and read each item: the PDF's text, Tesseract for a scan, and the proposal thread.
4. Each card, as `GET /batches/{id}` gives it, is scored against the truth (`@fdv/shared/testdata`, `smart-exit.ts`).
5. The batch is removed, and the run is repeated without folders.

**Needing manual typing** means that, after accepting what the card offers, one of these is missing or wrong:

- **the kind:** for a paper of no kind, any kind but "Something else" is wrong;
- **whose it is:** someone offered for a paper that names nobody is wrong too;
- **the expiry,** for a kind that has one, where the paper states it.

A kind with an expiry whose paper states none (a will's review date, a logbook) is counted apart, as `expiry_not_on_paper`. A blank page or a duplicate the vault calls a Problem needs nothing.

**Wrong Ready** means Ready with the kind, person or expiry wrong.

The whole run took 24 minutes on 8 cores. With folders, uploading took 37 s and drawing and reading 11 minutes. Without folders, uploading took 33 s and reading 11 minutes.

To run it again, from a copy of the repository without `node_modules`, in a container that reaches the test database:

```sh
apk add poppler-utils imagemagick tesseract-ocr tesseract-ocr-data-eng font-dejavu postgresql16-client
npm i -g pnpm@9.15.9 && pnpm install --frozen-lockfile
cd apps/api && DATABASE_ADMIN_URL=postgres://… FDV_SMART_EXIT=1 FDV_SMART_EXIT_OUT=/tmp/smart-exit.json \
  npx vitest run src/smart-exit.test.ts
```

It fails while the target is not met. The JSON it writes has every paper's truth beside what its card offered.

## Numbers

| Run             | Set      | Files | Ready | Check | Not recognised | Problem | Needs typing | Wrong Ready |
| --------------- | -------- | ----: | ----: | ----: | -------------: | ------: | -----------: | ----------: |
| With folders    | All      |   200 |    96 |    68 |             30 |       6 |           26 |           0 |
| With folders    | Tune     |   121 |    69 |    39 |              8 |       5 |            9 |           0 |
| With folders    | Held out |    79 |    27 |    29 |             22 |       1 |           17 |           0 |
| Without folders | All      |   200 |    96 |    53 |             45 |       6 |           41 |           0 |
| Without folders | Tune     |   121 |    70 |    38 |              8 |       5 |           12 |           0 |
| Without folders | Held out |    79 |    26 |    15 |             37 |       1 |           29 |           0 |

- **Text and scans, with folders:** 11 of the 118 text PDFs need typing, and 15 of the 82 scans.
- **Ready with a lesser detail wrong:** 2, both driving licence numbers that OCR misread. The kind, person and expiry were right.
- **Expiry not on the paper:** 10 with folders, 7 without.

**By kind, with folders** (papers whose kind was offered right / needing no typing / all papers):

- 100%: utility bills (35/35/35), passports (9/9/9), birth certificates, employment contracts, tax returns, wills, vehicle registrations, visas, marriage certificates, and papers of no kind (20/20/20).
- Bank statements: 26/26/30.
- Medical records: 17/17/18.
- Insurance: 14/8/14.
- Warranties: 14/13/14.
- Tax forms: 9/8/9.
- Pet records: 7/6/7.
- Prescriptions: 6/5/6.
- Diplomas and school reports: 3/3/6.
- Driving licences: 4/2/4.
- Loans: 3/0/4.
- Deeds: 2/1/2.
- National ID: 0/0/1.

## What changed, and what it did

Measured on the same corpus, with folders. The numbers in brackets are without folders.

|                      |     All |    Tune | Held out |
| -------------------- | ------: | ------: | -------: |
| Before (0.8.0-dev.6) | 51 (74) | 27 (35) |  24 (39) |
| After                | 26 (41) |  9 (12) |  17 (29) |

The changes:

- **A name OCR left a hyphen on** ("Mr Ahmed Khan-") is still the whole name.
- **A sentence above a name is not its label.** "The policyholder." over a motor certificate's named drivers no longer makes two people as sure as each other. "Registered keeper" above a name is a label.
- **A bill paid by Direct Debit** is due on the day it is collected ("by Direct Debit on or just after …").
- **New cues for kinds:**
  - a GP's letter is a medical record: its practice, an NHS or hospital number, and what it is about;
  - "Official copy of register of title" is a deed;
  - "General Certificate of Secondary Education" is a diploma.
- **A safety rule:** a label above a row of more dates than its line has labels claims none of them. With "Valid from" misread, "Valid until" had claimed the issue date, which in one OCR trial made a wrong Ready.
- **A scanned page Tesseract reads fewer than three words of** is enlarged, median-filtered and read again. The reading with more words is kept. This made a grainy vet's certificate readable, but its dates still came out garbled, so it changed no count of papers needing typing.

Tried and not kept: cleaning every scan before OCR, which read fewer papers right and once gave a wrong Ready, and Tesseract's `--psm 4`, which was better on the tune set (7) but worse held out (18).

## What still needs typing (26, with folders)

- **10: kinds the rules don't recognise on these layouts (held out):**
  - credit-card statements (3);
  - school reports (3), as the vault has no school-report kind;
  - a junior ISA statement;
  - a dentist's recall letter;
  - a hire-purchase agreement;
  - an NI-number letter.
- **6: OCR on scans:**
  - two-column forms that Tesseract reads column by column, so a label lands far from its value (a P60, two home insurance schedules);
  - a garbled date or label (a vet's certificate read "14703/2025"; a prescription's "Do not use after" read "Ou not use atter");
  - a grainy typewriter receipt read as blank.
- **4: papers of two people** (a joint mortgage, a register of title). The rules propose nobody for these by design.
- **4: whose it is:**
  - a policy naming "Mrs O Khan" by initial (2);
  - a travel policy listing four travellers, whose "cover runs from … until …" dates are not read either (2).
- **2: an expiry not read** on a downloaded licence summary ("Licence valid to", "Photocard expiry date" in a two-column table).

```json
{
  "measured": "2026-10-16",
  "seed": 1,
  "files": 200,
  "target_met": false,
  "with_folders": {
    "all": {
      "files": 200,
      "ready": 96,
      "check": 68,
      "unrecognised": 30,
      "problem": 6,
      "manual": 26,
      "wrong_ready": 0
    },
    "tune": {
      "files": 121,
      "ready": 69,
      "check": 39,
      "unrecognised": 8,
      "problem": 5,
      "manual": 9,
      "wrong_ready": 0
    },
    "held_out": {
      "files": 79,
      "ready": 27,
      "check": 29,
      "unrecognised": 22,
      "problem": 1,
      "manual": 17,
      "wrong_ready": 0
    }
  },
  "without_folders": {
    "all": {
      "files": 200,
      "ready": 96,
      "check": 53,
      "unrecognised": 45,
      "problem": 6,
      "manual": 41,
      "wrong_ready": 0
    },
    "tune": {
      "files": 121,
      "ready": 70,
      "check": 38,
      "unrecognised": 8,
      "problem": 5,
      "manual": 12,
      "wrong_ready": 0
    },
    "held_out": {
      "files": 79,
      "ready": 26,
      "check": 15,
      "unrecognised": 37,
      "problem": 1,
      "manual": 29,
      "wrong_ready": 0
    }
  }
}
```
