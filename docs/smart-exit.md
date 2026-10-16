# The Smart exit, measured (0.8.0)

The Phase 6 "Smart" exit asks that a folder of two hundred mixed PDFs imports with fewer than ten needing manual typing, and that no item the vault calls Ready is wrong. This is what was measured on 16 October 2026, at `feat/8.s5-exit`, after the owner's second round. 0.8.0 ships with it as it stands.

**Result:**

- **Wrong Ready is 0** in every run, on both sets, with folders and without.
- **On the 200 papers the rules were adjusted on**, 6 need typing with folder names (16 without): the target is met there.
- **On a second set written after them and held out**, 53 of 115 need typing with folder names (57 without): the target is **not** met on papers the rules have not seen.

The second number is the one to believe about a family's own papers. The rules read the layouts they were adjusted on well, and new layouts of the same kinds much less well.

## The corpora

`node scripts/smart-corpus.mjs --out <folder> [--corpus first|second] [--seed n]` writes either, with `manifest.json` (the truth for each file). The same seed gives the same bytes. `scripts/demo-seed.mjs --out <folder> --corpus` writes the first for a demo vault it has just filled, adding the two people the papers name who have no sign-in.

**Both:**

- One made-up family of five: an owner, an adult, a teen, a child and a grandmother, plus a few unknown names. Every company, school and number is invented.
- Kept as a family keeps them: tidy folders, a flat `Scans/` folder, `Downloads/`, and papers filed in the wrong folder.
- About six in ten are PDFs with their own words. About four in ten are image-only scans: skewed, specked, grey or black-and-white, at 100–200 dpi.
- A few are blank, or copies of another paper.

**The first (seed 1), 200 papers:** 21 kinds; 118 text and 82 scans; 20 of no kind; six with more than one page. All of it may be used to adjust the rules: it is the **tune** set.

**The second (seed 2), 115 papers:** held out.

- **New layouts and new issuers** (`scripts/smart-corpus-papers-2.mjs`): none used in the first set but the offices a paper is from wherever it is kept (DVLA, HMRC, the passport's country). A test checks this.
- **Its mix:** 19 kinds, including the two new ones; 69 text and 46 scans; 10 of no kind.
- **Frozen before measuring:** written and generated, with the SHA-256 of its paths and truths recorded (`d8dd8c6c…`; formatting the generator since changed no paper), before the vault read any of it. No rule was changed after it was read.

## Method

`apps/api/src/smart-exit.test.ts`, run with `FDV_SMART_EXIT=1` in `node:22-alpine` with poppler, ImageMagick and Tesseract (the worker's tools) against the test database. For each set, with its folders and then without:

1. The household is set up through the API (country GB).
2. Every file goes into one batch with Add → Many documents, each with its `relative_path` as the web sends it.
3. The worker's own jobs draw and read each item: the PDF's text, Tesseract for a scan, and the proposal thread.
4. Each card, as `GET /batches/{id}` gives it, is scored against the truth (`@fdv/shared/testdata`, `smart-exit.ts`).
5. The batch is removed before the next run.

**Needing manual typing** means that, after accepting what the card offers, one of these is missing or wrong:

- **the kind:** for a paper of no kind, any kind but "Something else" is wrong;
- **whose it is:** someone offered for a paper that names nobody is wrong too;
- **the expiry,** for a kind that has one, where the paper states it.

A kind with an expiry whose paper states none (a will's review date, a logbook) is counted apart, as `expiry_not_on_paper`. A blank page or a duplicate the vault calls a Problem needs nothing.

**Wrong Ready** means Ready with the kind, person or expiry wrong.

The run took 46 minutes on 8 cores:

- **First set:** uploading about 40 s a run; drawing and reading 16 minutes with folders, 12 without.
- **Second set:** uploading about 20 s a run; drawing and reading 8 minutes each.

To run it again, from a copy of the repository without `node_modules`, in a container that reaches the test database:

```sh
apk add poppler-utils imagemagick tesseract-ocr tesseract-ocr-data-eng font-dejavu postgresql16-client
npm i -g pnpm@9.15.9 && pnpm install --frozen-lockfile
cd apps/api && DATABASE_ADMIN_URL=postgres://… FDV_SMART_EXIT=1 FDV_SMART_EXIT_OUT=/tmp/smart-exit.json \
  npx vitest run src/smart-exit.test.ts
```

It fails on any wrong Ready, and records how many need typing. The JSON it writes has every paper's truth beside what its card offered.

## Numbers

| Corpus            | Run             | Files | Ready | Check | Not recognised | Problem | Needs typing | Wrong Ready |
| ----------------- | --------------- | ----: | ----: | ----: | -------------: | ------: | -----------: | ----------: |
| First (tune)      | With folders    |   200 |   110 |    64 |             20 |       6 |            6 |           0 |
| First (tune)      | Without folders |   200 |   108 |    60 |             26 |       6 |           16 |           0 |
| Second (held out) | With folders    |   115 |    19 |    54 |             36 |       6 |           53 |           0 |
| Second (held out) | Without folders |   115 |    22 |    30 |             57 |       6 |           57 |           0 |

**Text and scans, with folders:**

- First: 0 of 118 text PDFs need typing, and 6 of 82 scans.
- Second: 30 of 69 text PDFs, and 23 of 46 scans.

**By kind, with folders, on the second set** (papers whose kind was offered right / needing no typing / all papers):

- Every paper right: credit card statements 12/12/12, passports 4/4/4, tax forms 4/4/4, school reports 3/3/3, papers of no kind 10/10/10.
- Partly right:
  - bills 18/9/21;
  - medical 6/6/11;
  - bank statements 4/4/13;
  - insurance 6/0/9;
  - loans 2/0/2.
- None right: warranties 0/0/5, prescriptions 0/0/6, pet records 0/0/3, a music certificate 0/0/2.

**Ready with a lesser detail wrong** (first set): 4, namely two driving licence numbers that OCR misread, and two travel policies whose issuer is read as the product's name.

## What changed

**First round** (the first commit), with folders on the first set: 51 needing typing at dev.6 became 26.

- A name with a stray hyphen from OCR is still read.
- A sentence above a name ("The policyholder.") is not its label.
- Direct Debit collection dates are read as bills' due dates.
- GP letters, registers of title and GCSE certificates are recognised.
- A label above a row of more dates than labels claims none of them.
- A near-empty scanned page is cleaned and read again.

**Second round** (the owner's decisions of 16 October), 26 → 6 on the first set (41 → 16 without):

- **Two new kinds** (migration 0072):
  - **Credit card statement:** Financial, kept for adults; its expiry is "Payment due", reminding 7 days and a day before, as a bill's does.
  - **School report:** Education, with no expiry.

  They have folder words of their own ("Credit cards", "Bank/Credit card", "School reports"). A statement with a card's marks and a bank's, or neither, is offered below sure (Check). A bill is never offered for a paper with a credit limit.

- **Joint papers:** the first named of two named together is proposed, at 0.78 (Check). Until now nobody was.
- **Initials:** "Mrs O Khan" or "O. Khan" proposes the one person of the family it can only mean, at 0.78 (Check). Where two could match, nobody is proposed.
- **Everyday cues:**
  - ISAs, junior ISAs and AER are bank statements;
  - dental recalls are medical records;
  - hire purchase and "amount of credit" are loans;
  - a "your National Insurance number" letter is a national ID, issued by HMRC;
  - "HM Revenue & Customs" spelled out is the tax office;
  - the DVLA's full name means a driving licence;
  - travel, home, car and pet insurance products are insurance;
  - "lead traveller" and "pupil" are labels for whose a paper is;
  - a "registered contact" is not.
- **One cheap attempt at two-column OCR:** a scanned page read as a run of labels and then, below, a run of values is read again row by row (Tesseract `--psm 6`). The row reading is kept where its labels and values are no longer apart. On the first set it fixed two scans (a card statement and a home schedule); on a third, a home schedule, it found the expiry but lost whose it is.

None of these makes anything Ready on its own: each joint or initials proposal, and each card-or-bank doubt, is offered for a click.

## What still needs typing

**First set, 6 with folders:** all on scans whose OCR is wrong.

- A P60 read so that its name is far from its label.
- "Mr Abmed Khan".
- A vet's certificate read "14703/2025" and "Qlivia".
- A prescription's "Ou not use atter".
- A home schedule's holder lost when read by rows.
- A grainy typewriter receipt read as blank.

**Second set, 53 with folders,** almost all layouts and wording the rules have not seen.

**36 with no kind offered, or the wrong one.** A wrong one is mostly the folder's, for a paper filed in the wrong folder, offered unsure:

- a building society's quarterly "account summary" (9);
- repeat prescription slips (6);
- a health centre's letters (5);
- order confirmations with a guarantee (5);
- a breakdown membership card (3);
- a vet's booster reminder (3);
- a music exam certificate (2);
- a phone invoice (2);
- a water bill scan (1).

**16 with the kind right but the expiry not read:**

- a phone invoice's "Your Direct Debit payment date is …" (7);
- a motor schedule's "from 00:01 hours on … to midnight on …" (4);
- a renewal notice's "ends on …" in a sentence (2);
- a loan's "Final repayment date" (2);
- a water bill's "Due date" set apart from its date (1).

**1 whose person is lost** on a scanned gas statement.

## Anything to decide

- **The target is met on what the rules were adjusted on, and far from met on new layouts.** Adjusting the rules on the second set would make it a tune set too. The next honest step is a third held-out set written by someone else, for example from real (redacted) family papers.
- **Kinds that require an expiry the paper never states** (wills, logbooks, permanent contracts): 10 papers in the first set, counted apart.
- **School reports are now their own kind.** Diplomas and certificates of achievement stay diplomas.

```json
{
  "measured": "2026-10-16",
  "files": 315,
  "target_met": false,
  "first": {
    "seed": 1,
    "set": "tune",
    "target_met": true,
    "with_folders": {
      "files": 200,
      "ready": 110,
      "check": 64,
      "unrecognised": 20,
      "problem": 6,
      "manual": 6,
      "wrong_ready": 0
    },
    "without_folders": {
      "files": 200,
      "ready": 108,
      "check": 60,
      "unrecognised": 26,
      "problem": 6,
      "manual": 16,
      "wrong_ready": 0
    }
  },
  "second": {
    "seed": 2,
    "set": "held-out",
    "target_met": false,
    "with_folders": {
      "files": 115,
      "ready": 19,
      "check": 54,
      "unrecognised": 36,
      "problem": 6,
      "manual": 53,
      "wrong_ready": 0
    },
    "without_folders": {
      "files": 115,
      "ready": 22,
      "check": 30,
      "unrecognised": 57,
      "problem": 6,
      "manual": 57,
      "wrong_ready": 0
    }
  }
}
```
