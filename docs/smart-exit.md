# The Smart exit, measured (0.8.0)

The Phase 6 "Smart" exit asks that a folder of two hundred mixed PDFs imports with fewer than ten needing manual typing, and that no item the vault calls Ready is wrong. This is what was measured on 16 October 2026, at `feat/8.s5-exit`, after the owner's second and third rounds. 0.8.0 ships with it as it stands.

**Result:**

- **Wrong Ready is 0** in every run, on both sets, with folders and without.
- **On the 200 papers the rules were adjusted on**, 6 need typing with folder names (16 without): the target is met there.
- **On a second set written after them and held out**, 53 of 115 need typing with folder names (57 without): the target is **not** met on papers the rules have not seen.

The second number is the one to believe about a family's own papers. The rules read the layouts they were adjusted on well, and new layouts of the same kinds much less well.

## The corpora

`node scripts/smart-corpus.mjs --out <folder> [--corpus first|second|third] [--seed n]` writes any of them, with `manifest.json` (the truth for each file). The same seed gives the same bytes. `scripts/demo-seed.mjs --out <folder> --corpus` writes the first for a demo vault it has just filled, adding the two people the papers name who have no sign-in.

**All three:**

- One made-up family of five: an owner, an adult, a teen, a child and a grandmother, plus a few unknown names. Every company, school and number is invented.
- Kept as a family keeps them: tidy folders, a flat `Scans/` folder, `Downloads/`, and papers filed in the wrong folder.
- About six in ten are PDFs with their own words. About four in ten are image-only scans: skewed, specked, grey or black-and-white, at 100–200 dpi.
- A few are blank, or copies of another paper.

**The first (seed 1), 200 papers:** 21 kinds; 118 text and 82 scans; 20 of no kind; six with more than one page. All of it may be used to adjust the rules: it is the **tune** set.

**The second (seed 2), 115 papers:** held out.

- **New layouts and new issuers** (`scripts/smart-corpus-papers-2.mjs`): none used in the first set but the offices a paper is from wherever it is kept (DVLA, HMRC, the passport's country). A test checks this.
- **Its mix:** 19 kinds, including the two new ones; 69 text and 46 scans; 10 of no kind.
- **Frozen before measuring:** written and generated, with the SHA-256 of its paths and truths recorded (`d8dd8c6c…`; formatting the generator since changed no paper), before the vault read any of it. No rule was changed after it was read.

**The third (seed 3), 84 papers:** held out too, written for 0.9.0's learning after its word list was frozen; it is described, and measured, under "Learning" below.

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

A will, a logbook, an employment contract or a title deed asks for no expiry (the owner's decision of 16 October): one whose paper states none, and none offered, needs nothing. Any other kind with an expiry whose paper states none is counted apart, as `expiry_not_on_paper`. A blank page or a duplicate the vault calls a Problem needs nothing.

**Wrong Ready** means Ready with the kind, person or expiry wrong.

The second round's run took 46 minutes on 8 cores (the third's, below, an hour, with the test suite running beside it):

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
| First (tune)      | With folders    |   200 |   111 |    63 |             20 |       6 |            6 |           0 |
| First (tune)      | Without folders |   200 |   109 |    59 |             26 |       6 |           16 |           0 |
| Second (held out) | With folders    |   115 |    20 |    53 |             36 |       6 |           53 |           0 |
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

**Third round** (the owner's decision of 16 October): **an expiry only if the family adds one** for wills, logbooks (`vehicle_registration`), employment contracts and title deeds (`property_deed`), whose papers rarely state one. Deeds were added to the owner's three as clearly the same: a title never runs out. Pet records stay as they are: a vaccination's due date is often on the paper.

- **In the vault:** without an expiry such a document is complete (`valid`, not "Needs an expiry date"), so it is not in Needs attention, the Add card does not wait for the date, and a batch card gains no "missing" tag for it. One that is added is counted and reminded about as before. `GET /document-types` says what it said, for phones released before 0.8.0.
- **In the scoring:** these papers no longer count as `expiry_not_on_paper` (10 → 3 on the first set with folders, the 3 left being vet invoices; 3 → 0 on the second).
- **Measured again,** as it changes the levels: what needs typing is unchanged (6, 16, 53, 57), and wrong Ready is still 0. Three cards move from Check to Ready: an offer letter in both runs of the first set, and a contract with folders in the second. The other wills, logbooks and deeds stay at Check for other reasons, such as a logbook's registration plate, which the kind requires and the vault does not read.

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

## Learning (0.9.0, R1)

0.9.0 learns each sender's paper **shape** from the papers a person accepts (`@fdv/shared` shapes.ts, migration 0075): the sender, the page's heading and label words, and which label carries the date or number that was filed ("Payment date" is the due date, for this sender). It is sure only once confirmed 3 times with no contradiction, at least once vouched for, and only on a page whose words match at a Jaccard of 0.8 or more and which names the sender exactly; anything less is offered unsure. A learned value that disagrees with a page reading never replaces it: the item is Check.

**What a shape keeps.** Only words of a fixed list (`SHAPE_WORDS`, below), and of a line only its label column: a line with no value that parts into columns (`Payment method    Direct debit`) gives its first column alone, and on a line set out with single spaces a number's value does not carry its label's words. An address — a UK postcode's column and the lines above it — and an addressee's block near the top (a run of short lines starting with a house number or ending at a postal code of any country, and a "Dear …" or "To …" line) give nothing. The names of the household, its members and its guests are never words of a shape, and a stored shape loses a word once it is somebody's name. The list has no everyday word that is a common name (Will, Grace, Rose, King, Wood, Cash, Kit, Bank: a test lists them), no word that is a value (yes, no, male, single, joint), and no word that states a fact about somebody (diagnosis, disability, blood, debt, arrears, probation). **But a shape may hold words that say what kind of paper it was** — prescription, hospital, discharge, immunisation, overdraft, salary — because each is needed to tell that kind's layout; they are sealed under the person's own key, and `shape-words.ts` lists which and why. A third party's name that is also a label word of the list could still be kept; the test's papers, with third parties' names, OCR's splits and US addresses, keep none.

**What teaches it (the R1 review and its re-check).** Only an accept a person looked at: Accept all Ready teaches no shape. A lesson is sure only once vouched for at least once — a field the person put right, or the pages' own value confirmed on an item that was not Ready. What the batch's defaults filled in teaches no person, and a value the shape suggested itself, accepted unchanged, teaches nothing: neither a confirmation nor a vouch (N2), so a paper filed wrongly once is not made right by its own echo. Whose a paper is, a shape is sure of only when the page's number, read at the learned label, is one that person's papers from that sender were filed with (a keyed hash, never the number); where the uploader filed one bank's statements for several of the family, the page's account says whose it is, once filed for that person alone on 3 papers and never contradicted. A person sure from I4's rule or a shape is unsure on a page whose account that person's lesson does not hold (N1). The proposal thread, which reads the page, is given no hash and no key: the worker settles whose account it is (N5). And on a page of a layout the vault has learned, I4's rule for the sender is sure only if that layout's own lesson is (`layoutVouches`, below).

**The word list, frozen.** `SHAPE_WORDS` was first frozen for 0.9.0 on 18 October 2026 at 15:26 UTC (1,020 words, SHA-256 of the sorted words joined by newlines `4c1490d36c6d638e0ac3a48ebf1b431ba5636b772efa0bd9a62061be05789d02`), before the third set was written. But the list, the third corpus and the results landed in one commit (`f868533`), so that freeze cannot be shown from the history. After the R1 re-check took out more name-like words and words that state a fact about somebody, it was frozen again at 23:12 UTC in a commit of its own (`5f76aff`), before anything below was measured: 1,001 words, `4fafd5b1787d59299d5ee5ce241e236c12d1a0c9333e2b51e7b14bfbdca64066`, held by a test.

**The third set (seed 3), 84 papers, held out** (`scripts/smart-corpus-papers-3.mjs`, `--corpus third`): written after the first freeze, with 16 new layouts from new issuers (none of the first or second set's, which a test checks), among them a bank where three of the family hold accounts — the owner, the adult and a child's junior account — whose statements look alike but for the name and the number. 8 kinds; 56 text and 28 scans; 8 of no kind (3 blank); 2 copies and 7 misfiled. Its SHA-256 of paths and truths, `60feec74d62935e2fc4e329b681561295aaf9faabecf4855ed568ea78998e344`, was recorded at 15:27 UTC, before the vault read any of it.

**Each set's bytes.** From the re-check on, each set is held by the SHA-256 of its files' bytes too (of `[path, sha256 of the file]` in order), not only its paths and truths, by a test, on Windows and Linux alike: first `cdbb31af58cc382df42fb17cf594508ff90ee669f43c33eebf7e5f66c354a11f`, second `dba5d56a3e9dce97e0ff4e68a9703a4472c464e0a62df6373484b4e0e068394a`, third `2263d0a95f2780071d968046e70c935a38a3dec0d6760075ac397bebf7893068`.

Measured on 19 October 2026, at `feat/9.r1-shapes` with the R1 re-check's changes, on the list as frozen again, by `apps/api/src/smart-learning.test.ts` (`FDV_SMART_LEARNING=1`, in node:22-alpine with the worker's tools, as above):

1. Each set's papers arrive one at a time, in date order, so each sender's papers come in their own order.
2. Each is read by the worker's own job (the PDF's text, or Tesseract; each file's words read once and kept for the other runs of the same bytes) with whatever the person's earlier accepts taught, and its card is scored at that moment, as the exit scores it.
3. Then it is accepted as a person would: the truth sent for every field the kind keeps, correcting whatever the card got wrong, which teaches the vault. A paper of no kind, a blank page and a copy the card calls a duplicate are removed.

So a paper is only ever helped by the papers before it. Each set ran five ways with folders, and the first three without:

- **nothing learned:** Forget all before each paper, the reading alone;
- **rules:** I4's issuer rules alone (the shapes removed before each paper);
- **shapes:** I4's rules and R1's shapes, as 0.9.0 is;
- **careless:** as shapes, but a fifth of the cards (chosen by each file's path) accepted exactly as shown, whatever they got wrong — learned suggestions included — and only the rest put right;
- **Accept all Ready:** as shapes, but every card at Ready filed by Accept all Ready (which teaches no shape), the rest put right one by one.

"First" is the first paper from its sender (a paper naming no sender counts as a first); then its 2nd and 3rd; then its 4th and later.

**Needs typing (of the papers), with wrong Ready:**

| Set                | Folders | Learning         | First |   2–3 |    4+ |    All | Wrong Ready |
| ------------------ | ------- | ---------------- | ----: | ----: | ----: | -----: | ----------: |
| First (tune)       | with    | nothing          |  3/62 |  2/54 |  1/84 |  6/200 |           0 |
| First (tune)       | with    | rules            |  3/62 |  2/54 |  1/84 |  6/200 |           0 |
| First (tune)       | with    | shapes           |  3/62 |  2/54 |  1/84 |  6/200 |           0 |
| First (tune)       | with    | careless         |  3/62 |  2/54 |  1/84 |  6/200 |           0 |
| First (tune)       | with    | Accept all Ready |  3/62 |  2/54 |  3/84 |  8/200 |           0 |
| First (tune)       | without | nothing          |  6/62 |  3/54 |  7/84 | 16/200 |           0 |
| First (tune)       | without | rules            |  6/62 |  2/54 |  5/84 | 13/200 |           0 |
| First (tune)       | without | shapes           |  6/62 |  2/54 |  2/84 | 10/200 |           0 |
| Second (held out)  | with    | nothing          | 11/35 | 18/36 | 24/44 | 53/115 |           0 |
| Second (held out)  | with    | rules            | 11/35 | 13/36 | 16/44 | 40/115 |           0 |
| Second (held out)  | with    | shapes           | 11/35 |  5/36 |  1/44 | 17/115 |           0 |
| Second (held out)† | with    | careless         | 11/35 |  8/36 |  2/44 | 21/115 |           0 |
| Second (held out)  | with    | Accept all Ready | 11/35 |  5/36 |  2/44 | 18/115 |           0 |
| Second (held out)  | without | nothing          | 11/35 | 18/36 | 28/44 | 57/115 |           0 |
| Second (held out)  | without | rules            | 11/35 | 13/36 | 18/44 | 42/115 |           0 |
| Second (held out)  | without | shapes           | 11/35 |  5/36 |  1/44 | 17/115 |           0 |
| Third (held out)   | with    | nothing          |  8/22 | 13/24 | 17/38 |  38/84 |           0 |
| Third (held out)   | with    | rules            |  8/22 | 10/24 | 22/38 |  40/84 |           0 |
| Third (held out)†  | with    | shapes           |  8/22 |  5/24 |  7/38 |  20/84 |           0 |
| Third (held out)†  | with    | careless         |  8/22 |  5/24 |  7/38 |  20/84 |           0 |
| Third (held out)†  | with    | Accept all Ready |  8/22 |  5/24 |  7/38 |  20/84 |           0 |
| Third (held out)   | without | nothing          | 10/22 | 15/24 | 29/38 |  54/84 |           0 |
| Third (held out)   | without | rules            | 10/22 |  8/24 | 23/38 |  41/84 |           0 |
| Third (held out)†  | without | shapes           | 10/22 |  3/24 |  7/38 |  20/84 |           0 |

† After a change this set prompted, so these runs no longer test it as a held-out set would: the second set's careless run found the wrong Ready that `layoutVouches` fixes (below); the third set's shape runs prompted the account rule (below). Before the account rule, the third set's shape runs needed 31/84 typing.

**Ready (of the papers):**

| Set                | Folders | Learning         | First |   2–3 |    4+ |    All |
| ------------------ | ------- | ---------------- | ----: | ----: | ----: | -----: |
| First (tune)       | with    | nothing          | 23/62 | 28/54 | 43/84 | 94/200 |
| First (tune)       | with    | rules            | 23/62 | 28/54 | 43/84 | 94/200 |
| First (tune)       | with    | shapes           | 23/62 | 28/54 | 47/84 | 98/200 |
| First (tune)       | with    | careless         | 23/62 | 29/54 | 47/84 | 99/200 |
| First (tune)       | with    | Accept all Ready | 23/62 | 28/54 | 46/84 | 97/200 |
| First (tune)       | without | nothing          | 20/62 | 29/54 | 43/84 | 92/200 |
| First (tune)       | without | rules            | 20/62 | 29/54 | 43/84 | 92/200 |
| First (tune)       | without | shapes           | 20/62 | 29/54 | 47/84 | 96/200 |
| Second (held out)  | with    | nothing          |  7/35 |  9/36 |  4/44 | 20/115 |
| Second (held out)  | with    | rules            |  7/35 |  9/36 |  7/44 | 23/115 |
| Second (held out)  | with    | shapes           |  7/35 |  9/36 |  4/44 | 20/115 |
| Second (held out)† | with    | careless         |  7/35 |  9/36 |  6/44 | 22/115 |
| Second (held out)  | with    | Accept all Ready |  7/35 |  9/36 |  4/44 | 20/115 |
| Second (held out)  | without | nothing          |  6/35 | 11/36 |  5/44 | 22/115 |
| Second (held out)  | without | rules            |  6/35 | 11/36 |  8/44 | 25/115 |
| Second (held out)  | without | shapes           |  6/35 | 11/36 |  5/44 | 22/115 |
| Third (held out)   | with    | nothing          |  1/22 |  4/24 |  3/38 |   8/84 |
| Third (held out)   | with    | rules            |  1/22 |  4/24 |  6/38 |  11/84 |
| Third (held out)†  | with    | shapes           |  1/22 |  4/24 | 10/38 |  15/84 |
| Third (held out)†  | with    | careless         |  1/22 |  4/24 |  8/38 |  13/84 |
| Third (held out)†  | with    | Accept all Ready |  1/22 |  4/24 | 10/38 |  15/84 |
| Third (held out)   | without | nothing          |  2/22 |  4/24 |  3/38 |   9/84 |
| Third (held out)   | without | rules            |  2/22 |  4/24 |  7/38 |  13/84 |
| Third (held out)†  | without | shapes           |  2/22 |  4/24 | 11/38 |  17/84 |

**Result:**

- **Wrong Ready is 0 in all 24 runs**, the careless ones and Accept all Ready's included.
- **On the second set, shapes take what needs typing from 53 to 17 with folders, and from 57 to 17 without;** from a sender's fourth paper on, 1 of 44 needs typing.
- **On the third set, shapes take it from 38 to 20 with folders, and from 54 to 20 without** (†). From the fourth paper on, 7 of 38 still need typing, every one of them whose statement it is at the bank three of the family share: the account rule proposes the right person once an account is known, but it is not sure of it until that account was filed for them on 3 papers — and accepting its own suggestion no longer counts (N2) — so the bank's statements are Check, and the junior account, filed 4 times among 22, is unlearned between its statements by the others' (N3). Every other sender's later papers need nothing.
- **Ready is what the re-check cost.** Since a shape's own suggestion accepted unchanged teaches it nothing (N2), a lesson becomes sure only from papers the person put right or the pages read themselves, so fewer cards are Ready: the second set's shape runs are Ready 20/115 with folders (22 without), where before the re-check they were 28 (31); the third set's 15/84 (17 without), where they were 25 (29). The first set is unchanged (98/200). What needs typing is unchanged on the first and second sets, and up from 18 to 20 on the third, both of the new misses the bank's.
- **Careless accepts, as measured.** With a fifth of the cards accepted as shown (chosen by path, the same fifth each run), no card was Ready and wrong in these runs, on any set. That is what was measured, not a promise for any share or any family's mistakes. The first careless run did find one: the second set's surgery sends letters and repeat slips, a slip accepted as a letter made I4's rule for the surgery sure (5 confirmations, none against), and the next slip was Ready as a letter. On a page that matches a layout the vault has learned, the sender's rule is now sure only if that layout's own lesson is (`layoutVouches`); a page of a layout not learned yet is as I4 had it. With that, the slip is Check.
- **Accept all Ready teaches less, and nothing wrong.** The Ready cards filed in bulk teach no shape, so a few later papers need typing that would not have (6 to 8 on the first set, 17 to 18 on the second, 20 to 20 on the third).
- **The first paper of a sender is unchanged** (11 of 35 on the second set, 8 of 22 on the third). Learning cannot help a sender the vault has not seen.
- **On the tune set** the reading alone already needs little typing (6 with folders), and shapes leave it there; without folders, 16 becomes 10.
- **Periodic kinds are no renewals** (the owner's decision of 18 October): a statement, a bill, a tax form, a letter from the surgery is never offered as a renewal of the one before, so a sender's later papers are no longer Check for that.

**The yardstick from here is the Reading check on real papers.** Three made-up sets have now each prompted a change after they were read; a fourth would go the same way, so none will be written. What the vault learns is measured next on a family's own (redacted) papers, as planned for 0.9.

Run again as the exit is (above), with `FDV_SMART_LEARNING=1`, `FDV_SMART_EXIT_CORPORA` and `FDV_SMART_LEARNING_MODES` (`none,rules,shapes,careless,ready-all`), and `FDV_SMART_LEARNING_OUT`; `FDV_SMART_TEXT_CACHE` keeps each file's words between runs. A wrong Ready's row records its card and what was learned of its sender. With the words kept, the 24 runs took 47 minutes in all on the owner's machine, alongside other work.

## Scans (R3)

0.9.0's R3 reads **scanned papers** better: phone photos, the scanner folder's scans, and PDFs that are only pictures. The owner was away, so there were no real papers to measure on: it is measured on a **scan set** made from this page's made-up papers, and the Reading check (R0) goes on telling text from scans for a family's own.

**Result** (22 October 2026, at `feat/9.r3-scans`; measured again on 23 October after the R3 review's fixes — every number the same, but one held-out turned scan Check rather than Not recognised, and pages the wrong way up faster with Tesseract's orientation model — and again after the R3 re-check's, every paper's card the same as after the review's on both splits and in every learning run, and in the Smart exit but one held-out scan's holder now read, its level unchanged):

- **Wrong Ready is 0 in every run**: on both splits of the scan set, and on the Smart exit's and R1's reruns. Before R3 the scan set's tune split had one (below), which R3 fixed.
- **On the tune split, needing typing went from 39 of 132 to 17.** Ready from 54 to 70.
- **On the held-out split, from 94 of 132 to 84.** Ready from 15 to 18. OCR now reads 97% of the held-out pages' words where it read 80%, and every date that matters where it missed 11 — but most of what is left is what the clean scans of the held-out papers miss too (5 of 12): layouts and wording the rules have never seen, as the Smart exit found ("What still needs typing"). Better reading cannot fix that; the learning (R1) and real papers can.
- **Text PDFs are read as before**, and on the Smart exit's and R1's scans R3 is better on the first and third sets and 1 to 2 papers worse on the second (below).
- **Slower where a page reads badly:** the median page takes 5.5 seconds where it took 3.6, and the slowest 5% 14.9 where they took 16.2; a page the wrong way up about 12 with Tesseract's orientation model (16 without it). A page that reads well takes what it did (about 4 to 5 seconds).

### The scan set

`node scripts/scan-corpus.mjs --out <folder> [--split tune|held-out|both] [--per 12]` writes it, with `manifest.json` in each split's folder: each file's cause, how it was spoilt, its kind of file, its truth (as the Smart exit's manifest), the words on its pages, and the text that writes the date that matters. Node's own modules only; the same options give the same bytes, on Windows and Linux alike.

- **Two splits of 132 files, 12 of each cause.** The **tune** split is drawn from the first set's papers (seed 1), the only ones looked at while the reader was changed. The **held-out** split is drawn from the second and third sets' (seeds 2 and 3), which never were. A blank page and a copy are left out; papers of no kind are kept (14 and 10).
- **Each paper drawn again from its own page, spoilt one way** — its **cause**:
  - `clean`: a good 300 dpi scan, the fast path's control;
  - `rotated`: turned a quarter, half or three quarters;
  - `skew`: 1° to 7° off the straight;
  - `blur`: out of focus;
  - `jpeg`: saved as a JPEG at quality 12 to 30, at 150 or 200 dpi;
  - `noise`: heavy grain and thousands of specks;
  - `lowres`: 100 to 150 dpi;
  - `shadow`: a phone photo's shadow and uneven light, faint ink on grey paper;
  - `photo`: a phone photo of the page leaning on a table, its corners in perspective, a little blurred;
  - `columns`: set in two columns, small enough to fit;
  - `page2`: two pages, the date that matters at the top of page 2.
- **As a family keeps them:** PDFs of pictures (75 and 72, kept as a JPEG inside, as a scanning app keeps them), grey PNGs (23 and 24) and JPEGs (34 and 36); 15 and 12 of more than one page.
- **Held by their bytes:** the SHA-256 of `[path, sha256]` of every file, in order, is `a63f3191b10d4a0c667201bb906ad4e0f305766277734ce440282578f8c4dfcb` for the tune split and `8860aecb7ec6d0d96d7c5a006da2d5abf5e9ed3ccbc6f60e116b7d27fb795436` for the held-out split. A test draws a few causes twice and checks they are the same bytes, and where each split's papers come from.
- No word but the papers' own, and "Continued overleaf" and "Page 2 of 2".

### Method

`apps/api/src/scan-set.test.ts`, run with `FDV_SCAN_SET=1` as the exit is (node:22-alpine with poppler, ImageMagick and Tesseract 5.5.2 — the worker image's — against the test database), `FDV_SCAN_SET_DIR` set to a folder the script wrote. Each split's files go into one batch, with no folder, as their kind of file; each is read by the worker's own job (`readNextBatchItem`, with the real tools and the proposal thread) and its card, as `GET /batches/{id}` gives it, is scored by the Smart exit's scorer. Beside the levels it records, for each file, the share of its pages' words OCR found (**recall**), whether the date that matters was in the text as written, only with OCR's confusions, or not at all, and the time its reading took for each page. It fails on any wrong Ready. Both splits take about 45 minutes.

### Where scans went wrong, before R3

Measured first, on the reader as it was (`f91de44`): typing needed, of the 12 of each cause, and the share of the pages' words OCR found.

| Cause   | Tune: typing | Tune: words read | Held out: typing | Held out: words read | What went wrong                                                                                                                                                 |
| ------- | -----------: | ---------------: | ---------------: | -------------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| clean   |            4 |             100% |                5 |                 100% | Nothing of OCR's: names misread ("Mrs Olivia ] Khan") and layouts the rules do not know.                                                                        |
| rotated |            7 |              33% |               10 |                  17% | **Read upside down or sideways**: words of nonsense, the kind not found (10 and 11 not recognised).                                                             |
| skew    |            4 |              86% |                7 |                  85% | Past 4° or so Tesseract loses words, and a label and its value drift onto different lines.                                                                      |
| blur    |            5 |              88% |               12 |                  79% | Letters lost.                                                                                                                                                   |
| jpeg    |            2 |             100% |                9 |                  99% | Read well: what is missed is the layouts.                                                                                                                       |
| noise   |            3 |              97% |                8 |                  65% | On the held-out split, **3 pages read as blank** (Problem).                                                                                                     |
| lowres  |            2 |              97% |                9 |                  98% | Read well.                                                                                                                                                      |
| shadow  |            6 |              53% |               12 |                  57% | **The shadowed half of a photo read as a picture**: its words, and 4 and 3 of the dates that matter, never read.                                                |
| photo   |            4 |              82% |                8 |                  85% | The table and the shadow taken for pictures; one **wrong Ready**: a fixed-term contract, its "End date" misread, Ready without it (a contract needs no expiry). |
| columns |            2 |             100% |                6 |                 100% | **Two columns run together**, a space apart: "Employee: Olivia Khan Salary: £43,386.36", so a name runs into the next column's label, and an end date is lost.  |
| page2   |            0 |             100% |                8 |                 100% | Not a cause: every page was read (up to `FDV_OCR_MAX_PAGES`); what is missed is the layouts.                                                                    |
| All     |    39 of 132 |              85% |        94 of 132 |                  80% |                                                                                                                                                                 |

And across all of it:

- **No words at all:** 3 held-out pages (heavy noise); none in the tune split.
- **Dates and amounts misread** (O for 0, l for 1, S for 5, a comma for a point): **none found.** Of the dates that matter, none was in the text only with a confusion, before or after: Tesseract 5's errors were whole words lost, not digits swapped. The fix was made (below) and tested, but this set shows no gain from it.
- **Multi-page PDFs read only on page 1:** not so — every page is read, up to `FDV_OCR_MAX_PAGES`.

So the order was: pages the wrong way up, shadows, columns, skew; then noise and blur.

### What changed

All of it in the worker's reading (`apps/worker/src/jobs/scan-read.ts`, `extract-text.ts`, `tools.ts`) and two rules in `@fdv/shared`. No new tool, no new dependency, no migration, no network.

1. **Read in rows.** Tesseract is asked for its words with their boxes (`tsv`), and they are laid out as pdftotext -layout lays out a PDF's own text: lines at the same height put on one row however far apart Tesseract's blocks are, each word at about its place across the page, a blank line for a gap. So "Payment due by" and "29/04/2026" are on one line again, two-column pages included, and the rules — and the layouts R1 learns, whose label columns are made for this — see a scan as they see a text PDF.
2. **A page that reads well is read once** (the fast path): many words that look like words, letters big enough, most of the page read, its lines level. Anything else is looked at again, made ready as below, and **the second reading is kept only where it reads clearly more**: three more words that look like words (a page turned, always). Two readings a word or two apart differ as much in which words they get wrong — a name — as in how many; on the first set, a motor certificate read with one word more had lost its holder's name.
   - **the wrong way up** (few of its words look like words, or they stand taller than wide — a page on its side): Tesseract's orientation model (`osd`, in the worker image since the R3 review) says which way up it reads, and where it is unsure, or the worker has no model (a development machine), each way up is tried on a half-size copy, and it is turned the way that reads far better;
   - **crooked**: its slant measured by the slope of its lines, or, where its lines are too short to say (a form, a card), by ImageMagick's deskew on a quarter-size copy — checked against the page's own rows, since a small copy of a page of little text can be a degree out — and turned back; a slant of 0.3° or more measured so is used to lay the rows out even where it is too small to read the page again, and a label and a value in blocks of their own share a row only within 0.35 of a line's height, so a sparse form a little crooked never pairs a label with the next row's value;
   - **partly taken for a picture** (more than 15% of the page in blocks Tesseract found no words in — a shadow): **evened out**, the page divided by the paper's own shade near each place (a small copy, each pixel the lightest of its neighbours, blurred and made the page's size again), its faint print darkened and its paper whitened;
   - **small letters**: made bigger, to about 32 pixels a word;
   - **read unsurely, or next to nothing read**: also cleaned of speckle, as S5's grainy-page cleaning does (twice the size, a median of each pixel's neighbours).
3. **Photos first drawn by ImageMagick**, under its limits (MAGICK_LIMITS, its spill in the job's own folder): turned upright by their EXIF orientation (which Tesseract ignores), flattened onto white, grey, no bigger than 4,700 pixels a side — a JPEG longer than that shrunk as libjpeg decodes it, asked for in its own proportions (by eighths, to about 4,700 across: a phone's 108 megapixel photo, 12,000 by 9,000, is decoded at 4,500 by 3,375 and read) — and a scanner's TIFF a frame at a time as it is read, up to `FDV_OCR_MAX_PAGES`. Its header is asked first, and a picture of more than 128 megapixels, or with a side over 16,000 pixels, is refused there, as is a JPEG libjpeg would hold whole — progressive, or each colour in a scan of its own — with more than 64 million coefficients (below); one ImageMagick finds too big as it reads is refused too. A refused picture never reaches Tesseract, and is said so ("picture refused"). Each page, and every copy made of it, is let go once it is read.
4. **OCR's confusions put right in dates and sums only** (`@fdv/shared` ocr-confusions.ts): "2O26" is 2026, "l2/05" is 12/05, "£1O4.50" is £104.50 — only in a token that, so put right, is a real date or a sum, and has digits of its own; never in a word, a name, a postcode, a reference or any other number (a test lists them). A date read from a corrected token is offered at 0.75 at most, under the 0.8 a sure expiry needs, and marked `corrected`: its card is Check whichever date it is — an expiry "Expiry unsure", an issue date "A date read from unclear digits". B and Z are left alone (a seat "1B" is no 18), each part of a date must have a digit of its own ("IS/O5/2O26" is not put right), and a two-digit year only after a date's label on its line ("Sort code: O1.O2.O3" is left alone). The layouts R1 learns read the page as OCR gave it.
5. **An expiry on the page, not on the card.** A will, a logbook, an employment contract or a deed is complete without an expiry (0.8.0), so the photographed contract above was Ready with its "End date" misread. Now the worker asks the page for every such kind's words for its expiry ("End date", "The term ends"), whatever was proposed or read, and seals which kinds it found (`expiry_labels`); a card of one of those kinds with no expiry is Check, "Expiry on the page, not read" — by the kind the card has, the batch's or one changed after as much as the pages'. And a card whose expiry the pages read for the kind they proposed, not offered for the card's own (the batch says a deed; the pages, a contract), is Check: "Expiry on the page, read for another kind".

Every step that touches pixels is ImageMagick or Tesseract in its own process, under MAGICK_LIMITS and a timeout. **The second look at a page has one budget, 45 seconds in all** (SECOND_LOOK_MS), however many steps it takes; a step that fails — ImageMagick refusing a page it would have to make too big, say — or runs past the budget leaves the best reading so far, never none. A page is never made ready past 24 megapixels (PREPARE_MAX_PIXELS), and S5's cleaned copy of a grainy page is read once, with no second look of its own. A filed document's words (version.process) have 8 minutes in all (VERSION_READ_DEADLINE_MS, under its job's 14-minute expiry, which a queue made before R3 now takes too), as a batch item's read has (READ_DEADLINE_MS). **Second looks end at half of it**: the pages left are read once, with no second look, no cleaning and no reading again row by row, so a long scan is read before its deadline. Past it, its tools are stopped; a filed document keeps the pages read before then, and says it was too slow and how many were not read ("ocr: too slow (12 of 30 scanned pages read; …)"); none read, its words fail as too slow. S5's cleaning of a grainy page is made no bigger than 24 megapixels either, and is not done again where the second look has read a cleaned copy already. Tests show a picture claiming 60,000 pixels square refused by every step at once, and never handed to Tesseract.

**Memory and disk, the R3 re-check.** Measured in the worker image's tools (node:22-alpine, ImageMagick 7.1.2-34), each picture made by a test's generator or by ImageMagick — kilobytes or a few megabytes that decode to far more — read as `imagePage` reads it, at the R3 review's commit (`1767ce3`) and now: the peak memory of its largest process, and the most its spill took on disk.

| Picture                                                                      | At the R3 review                                                 | Now                                      |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------- |
| A progressive CMYK JPEG 16,000 pixels square, 2 MB                           | read: 2,207 MiB of memory, 244 MiB on disk, 7 s                  | refused from its header, 0.06 s          |
| The same as a baseline JPEG with each colour in a scan of its own, 4 MB      | read: 2,209 MiB, 244 MiB on disk, 6 s                            | refused from its header, 0.06 s          |
| A progressive CMYK JPEG 8,000 square (64 megapixels: under the area), 0.5 MB | read: 879 MiB, 668 MiB on disk, 8 s                              | refused from its header, 0.06 s          |
| A white PNG 11,000 square, 118 KB                                            | 470 MiB, 1,120 MiB on disk, 63 s, then refused by its time limit | refused at once, nothing on disk, 0.07 s |
| A CMYK JPEG 8,000 by 2,000 (a wide photo)                                    | read at 16,000 by 4,000: 346 MiB, 1,706 MiB on disk, 11 s        | read: 175 MiB, nothing on disk, 1.2 s    |
| A colour JPEG 16,000 by 1,000                                                | refused: asked to be decoded at 32,000 by 2,000                  | read: 28 MiB, nothing on disk            |
| S5's cleaning of a grainy page 4,700 square                                  | 515 MiB, 585 MiB on disk, 91 s, then refused: made 9,400 square  | 384 MiB, 208 MiB on disk, 37 s, its size |

The most a JPEG held whole may have is 64 million coefficients (two bytes each, all in memory until its last scan): a grey page of 64 megapixels, a colour photo of 42 (its colour at a quarter, as a camera's is) or 21 (in full), a CMYK one of 16. It was set by measurement: **the worst such picture allowed, a progressive grey JPEG 8,000 pixels square, peaks at 469 MiB** (280 MiB on disk), as a one-scan JPEG does at any size (190 to 470 MiB: ImageMagick's own limits); a progressive CMYK one 4,000 square, 436 MiB; at 96 million, a CMYK one reached 558 MiB. A real progressive camera photo of 42 megapixels (4:2:0) peaks at 322 MiB and is read; one of 48 is refused. A one-scan JPEG over 128 megapixels is refused too, though libjpeg's shrinking would hide its size from ImageMagick. A phone's 108 megapixel photo, read now at 4,500 by 3,375, peaks at 299 MiB.

**The JPEG check fails closed, and reads a bounded start (round four).** It reads at most the first 2 MiB of a file (JPEG_HEADER_MAX_BYTES), at once, and walks its markers in one synchronous pass in the worker; a JPEG whose frame and first scan it cannot find there — a header cut off or longer than that, a segment of a length under two, a scan before its frame, a second frame, a frame of no height — is refused, as one too big is: before, 100,001 empty segments of 4 bytes ahead of a progressive CMYK frame 8,000 square ran its marker count out, it said nothing, and the page was read at 879 MiB (668 MiB on disk). Each step moves on at least a byte, so its work is bounded by the 2 MiB: at worst 22 ms (the first of twenty passes over 524,000 empty segments; 1.5 to 4 ms after), and 2 MiB of memory. SOI and then 100 MB of nothing is refused in 9 ms. It stays on the worker's own thread because it is that small; the pictures are decoded in ImageMagick's processes as before. **The same check now comes before a person's photo, a thumbnail and page previews** are made of an uploaded JPEG, which it did not before R3 either: a progressive CMYK JPEG 11,000 square was made a person's photo at 961 MiB, and one 8,000 square a thumbnail or previews at 498 MiB and 977 MiB on disk (8 to 19 s); each is refused in under 0.1 s now. JPEGs inside PDFs are drawn by poppler, as before, and not checked.

### Numbers, after

| Split    | Reader    | Ready | Check | Not recognised | Problem | Needs typing | Wrong Ready | Words read | Dates that matter not read |
| -------- | --------- | ----: | ----: | -------------: | ------: | -----------: | ----------: | ---------: | -------------------------: |
| Tune     | before R3 |    54 |    44 |             34 |       0 |           39 |           1 |        85% |                    9 of 68 |
| Tune     | R3        |    70 |    43 |             19 |       0 |           17 |           0 |        98% |                    1 of 68 |
| Held out | before R3 |    15 |    35 |             79 |       3 |           94 |           0 |        80% |                   11 of 75 |
| Held out | R3        |    18 |    45 |             69 |       0 |           84 |           0 |        97% |                    0 of 75 |

**By cause, needing typing** (of 12; tune, then held out):

| Cause   | Tune before | Tune R3 | Held out before | Held out R3 |
| ------- | ----------: | ------: | --------------: | ----------: |
| clean   |           4 |       2 |               5 |           5 |
| rotated |           7 |       1 |              10 |           7 |
| skew    |           4 |       1 |               7 |           6 |
| blur    |           5 |       4 |              12 |          12 |
| jpeg    |           2 |       1 |               9 |           9 |
| noise   |           3 |       4 |               8 |           8 |
| lowres  |           2 |       1 |               9 |           9 |
| shadow  |           6 |       1 |              12 |          10 |
| photo   |           4 |       2 |               8 |           6 |
| columns |           2 |       0 |               6 |           4 |
| page2   |           0 |       0 |               8 |           8 |

- **Words read, by cause:** rotated 33% → 100% (tune) and 17% → 100% (held out); shadow 53% → 99% and 57% → 98%; skew 86% → 100% and 85% → 98%; photo 82% → 95% and 85% → 93%; noise 97% → 97% and 65% → 97% (the 3 blank-read pages read). Blur stays at 87% and 79%: nothing tried here brought its letters back.
- **On the tune split, 23 papers no longer need typing and 1 newly does:** a grainy GP letter, whose name OCR now reads "Farida.Khan". On the held-out split 10 no longer need typing and none newly does.
- **What is left on the tune split (17):** 6 bank statements whose holder's middle initial OCR reads as "]" or "|" ("Mrs Olivia ] Khan"; R3 changes no word of a name), 3 more names misread (a grainy GP letter's "Farida.Khan", a shadowed motor policy, a blurred dental recall), kinds a blurred or grainy page does not show (5), and 3 dates beside their labels read wrongly or not at all (a blurred travel policy, the photographed contract — Check now, not Ready — and a grainy phone bill).
- **Clean scans need typing as before** (2 of 12 and 5 of 12): what is left there is the rules, not the reading.

### Time per page

Measured apart, with nothing else running on the machine (8 cores), every third file of each split (88 files, 97 pages), one at a time, each read by `extractText` as the worker reads it with Tesseract's own threads: before R3 (`f91de44`), at R3's first commit (`821d1b4`, no orientation model), and after the R3 review (with the orientation model, as the worker image now has it). Seconds a page:

| Files               | Before: median | Before: 95th | R3 first: median | R3 first: 95th | R3 reviewed: median | R3 reviewed: 95th |
| ------------------- | -------------: | -----------: | ---------------: | -------------: | ------------------: | ----------------: |
| Tune split (44)     |            3.6 |         11.0 |              5.5 |           17.9 |                 5.4 |              14.9 |
| Held-out split (44) |            3.3 |         17.1 |              5.5 |           16.2 |                 5.8 |              14.5 |
| Both (88)           |            3.6 |         16.2 |              5.5 |           17.5 |                 5.5 |              14.9 |

**Pages the wrong way up** (all 24 `rotated` files of both splits, the reviewed reader): with Tesseract's orientation model, median 12.1 and 95th percentile 15.1 seconds a page; without it (four small readings tried instead), 15.7 and 18.9. Every one read right either way (all their words read).

- **Read well, read once:** a clean scan, a JPEG-crushed or low-resolution one, columns, two pages — about 4 seconds a page before and after (median of those causes 3.9 → 4.9: a photo is now drawn grey and upright by ImageMagick first, about a second).
- **Read again:** a page the wrong way up 12 seconds with the orientation model, 16 to 18 without (four small readings, then the page); crooked 7 to 8; a shadowed or photographed page 5 (it took 1.3 — reading half of it); a grainy one 16 to 17, as before (it was 16 to 20).
- **The slowest page** took 21.7 seconds (20.5 at the first commit), where before R3 a grainy one took 33.5. A page's first reading has Tesseract's 3 minutes at most, and its second look 45 seconds in all; S5's cleaning and its row-by-row reading keep their own limits, as before R3. An item's read and a filed document's both stop at 8 minutes: 20 pages all read twice at the 95th percentile come to about 6.
- The scan-set runs above recorded time per page too (median 8.3 and 8.2 after, 4.3 and 3.8 before), with other measurements running on the machine; these are the numbers to go by.

### The text PDFs, and what R1 learns, again

Both were run again on R3's reader, as they were run before (`smart-exit.test.ts` and `smart-learning.test.ts`, every mode), and compared paper by paper with the runs recorded above; and once more after the R3 review's fixes, and after the R3 re-check's, with the same numbers in every run (after the re-check, one held-out scan of a school trip letter has its holder read, still Not recognised).

**No text PDF changed:** every paper whose card changed is a scan. Wrong Ready is 0 in all 4 Smart exit runs and all 24 learning runs.

**The Smart exit, needing typing** (recorded above → R3):

| Corpus            | With folders | Without folders | Ready, with folders |
| ----------------- | -----------: | --------------: | ------------------: |
| First (tune)      |        6 → 4 |         16 → 13 |           111 → 114 |
| Second (held out) |      53 → 54 |         57 → 59 |             20 → 21 |

The first set's grainy typewriter receipt, read as blank before ("What still needs typing"), is read now (Problem 6 → 5).

**R1's learning, needing typing, all papers** (recorded above → R3):

| Set               | Folders | nothing | rules   | shapes  | careless | Accept all Ready |
| ----------------- | ------- | ------- | ------- | ------- | -------- | ---------------- |
| First (tune)      | with    | 6 → 4   | 6 → 4   | 6 → 5   | 6 → 5    | 8 → 6            |
| First (tune)      | without | 16 → 13 | 13 → 10 | 10 → 8  |          |                  |
| Second (held out) | with    | 53 → 54 | 40 → 40 | 17 → 17 | 21 → 21  | 18 → 18          |
| Second (held out) | without | 57 → 59 | 42 → 43 | 17 → 18 |          |                  |
| Third (held out)  | with    | 38 → 38 | 40 → 40 | 20 → 15 | 20 → 16  | 20 → 15          |
| Third (held out)  | without | 54 → 54 | 41 → 41 | 20 → 15 |          |                  |

- **Better:** scans whose holder's name is now read (a home insurance schedule, a P60, a passport), and on the third set, the bank three of the family share: its scanned statements now carry their account number beside its label, as R1's layouts expect, so 5 more of them are known as their holder's (20 → 15 with shapes).
- **Worse, on the second set, by 1 or 2:** two scans whose holder's name R3 now misreads — a logbook ("OUVIA KHAN") and a P60 ("OLIVIAKHAN"). Each was crooked, read again straightened, with 4 more words that look like words than the first time, and kept; the name was one of the words it got wrong. That is within what a second reading changes either way, and it was not adjusted for: the second set is held out. On the third set one scan of the shared bank loses its holder the same way.

## Anything to decide

- **The target is met on what the rules were adjusted on, and far from met on new layouts.** Adjusting the rules on the second set would make it a tune set too. The next honest step, planned for 0.9, is a held-out set of real (redacted) family papers.
- **School reports are now their own kind.** Diplomas and certificates of achievement stay diplomas.
- **Whose statement it is, at a bank several of the family use (0.9.0).** Done since, after the third set showed it (above): its numbers are no longer held-out ones. The next held-out set, of real (redacted) family papers, would measure it honestly.
- **What a shape's own suggestion should teach (0.9.0).** Since the R1 re-check, accepting a value a shape suggested, unchanged, teaches it nothing (N2). That closes the way a paper filed wrongly once, then accepted as suggested, became Ready and wrong; it costs Ready (the second set's shape runs 28 to 20 of 115, the third's 25 to 15 of 84, and the shared bank's statements are never Ready) and no typing but the bank's 2. Whether to count such an accept where something else vouches for it is for the Reading check on real papers to show.
- **Scans (R3): two held-out scans lose their holder's name** (the second set, 1 to 2 more needing typing; above), while the first and third sets gain. Keeping the first reading unless the second reads clearly more (3 words) was set on the first set's motor certificate; a larger margin might keep these two as well, but only the held-out set says so, so it was not changed. Real papers will say which way it should go.
- **Scans (R3): what costs time.** A page read badly takes longer — a page the wrong way up about 12 seconds, where it took 3 to read it wrongly; the median page 5.5 seconds, where it was 3.6. Tesseract's orientation model (`tesseract-ocr-data-osd`, about 10 MB) is in the worker image since the R3 review (the owner's default): a turned page takes 12 seconds where four small readings took 16. A development machine without it tries the four. No other language was needed: the papers are English.

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
      "ready": 111,
      "check": 63,
      "unrecognised": 20,
      "problem": 6,
      "manual": 6,
      "wrong_ready": 0
    },
    "without_folders": {
      "files": 200,
      "ready": 109,
      "check": 59,
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
      "ready": 20,
      "check": 53,
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
  },
  "learning": {
    "measured": "2026-10-19",
    "order": "by date; each paper scored as it arrives, then accepted with its truth",
    "periodic_kinds_renew_nothing": true,
    "shape_words": {
      "frozen": "2026-10-18T23:12:00Z",
      "commit": "5f76aff",
      "words": 1001,
      "sha256": "4fafd5b1787d59299d5ee5ce241e236c12d1a0c9333e2b51e7b14bfbdca64066",
      "first_frozen": "2026-10-18T15:26:00Z",
      "first_sha256": "4c1490d36c6d638e0ac3a48ebf1b431ba5636b772efa0bd9a62061be05789d02",
      "first_freeze_shown_by_history": false
    },
    "third": {
      "seed": 3,
      "set": "held-out",
      "files": 84,
      "recorded": "2026-10-18T15:27:28Z",
      "sha256": "60feec74d62935e2fc4e329b681561295aaf9faabecf4855ed568ea78998e344"
    },
    "bytes_sha256": {
      "first": "cdbb31af58cc382df42fb17cf594508ff90ee669f43c33eebf7e5f66c354a11f",
      "second": "dba5d56a3e9dce97e0ff4e68a9703a4472c464e0a62df6373484b4e0e068394a",
      "third": "2263d0a95f2780071d968046e70c935a38a3dec0d6760075ac397bebf7893068"
    },
    "careless_share": 0.2,
    "yardstick_from_here": "the Reading check on real papers; no fourth made-up set",
    "runs": {
      "first/folders/none": {
        "needs_typing": {
          "first": "3/62",
          "2-3": "2/54",
          "4+": "1/84",
          "all": "6/200"
        },
        "ready": {
          "first": "23/62",
          "2-3": "28/54",
          "4+": "43/84",
          "all": "94/200"
        },
        "wrong_ready": 0
      },
      "first/folders/rules": {
        "needs_typing": {
          "first": "3/62",
          "2-3": "2/54",
          "4+": "1/84",
          "all": "6/200"
        },
        "ready": {
          "first": "23/62",
          "2-3": "28/54",
          "4+": "43/84",
          "all": "94/200"
        },
        "wrong_ready": 0
      },
      "first/folders/shapes": {
        "needs_typing": {
          "first": "3/62",
          "2-3": "2/54",
          "4+": "1/84",
          "all": "6/200"
        },
        "ready": {
          "first": "23/62",
          "2-3": "28/54",
          "4+": "47/84",
          "all": "98/200"
        },
        "wrong_ready": 0
      },
      "first/folders/careless": {
        "needs_typing": {
          "first": "3/62",
          "2-3": "2/54",
          "4+": "1/84",
          "all": "6/200"
        },
        "ready": {
          "first": "23/62",
          "2-3": "29/54",
          "4+": "47/84",
          "all": "99/200"
        },
        "wrong_ready": 0
      },
      "first/folders/ready-all": {
        "needs_typing": {
          "first": "3/62",
          "2-3": "2/54",
          "4+": "3/84",
          "all": "8/200"
        },
        "ready": {
          "first": "23/62",
          "2-3": "28/54",
          "4+": "46/84",
          "all": "97/200"
        },
        "wrong_ready": 0
      },
      "first/no-folders/none": {
        "needs_typing": {
          "first": "6/62",
          "2-3": "3/54",
          "4+": "7/84",
          "all": "16/200"
        },
        "ready": {
          "first": "20/62",
          "2-3": "29/54",
          "4+": "43/84",
          "all": "92/200"
        },
        "wrong_ready": 0
      },
      "first/no-folders/rules": {
        "needs_typing": {
          "first": "6/62",
          "2-3": "2/54",
          "4+": "5/84",
          "all": "13/200"
        },
        "ready": {
          "first": "20/62",
          "2-3": "29/54",
          "4+": "43/84",
          "all": "92/200"
        },
        "wrong_ready": 0
      },
      "first/no-folders/shapes": {
        "needs_typing": {
          "first": "6/62",
          "2-3": "2/54",
          "4+": "2/84",
          "all": "10/200"
        },
        "ready": {
          "first": "20/62",
          "2-3": "29/54",
          "4+": "47/84",
          "all": "96/200"
        },
        "wrong_ready": 0
      },
      "second/folders/none": {
        "needs_typing": {
          "first": "11/35",
          "2-3": "18/36",
          "4+": "24/44",
          "all": "53/115"
        },
        "ready": {
          "first": "7/35",
          "2-3": "9/36",
          "4+": "4/44",
          "all": "20/115"
        },
        "wrong_ready": 0
      },
      "second/folders/rules": {
        "needs_typing": {
          "first": "11/35",
          "2-3": "13/36",
          "4+": "16/44",
          "all": "40/115"
        },
        "ready": {
          "first": "7/35",
          "2-3": "9/36",
          "4+": "7/44",
          "all": "23/115"
        },
        "wrong_ready": 0
      },
      "second/folders/shapes": {
        "needs_typing": {
          "first": "11/35",
          "2-3": "5/36",
          "4+": "1/44",
          "all": "17/115"
        },
        "ready": {
          "first": "7/35",
          "2-3": "9/36",
          "4+": "4/44",
          "all": "20/115"
        },
        "wrong_ready": 0
      },
      "second/folders/careless": {
        "needs_typing": {
          "first": "11/35",
          "2-3": "8/36",
          "4+": "2/44",
          "all": "21/115"
        },
        "ready": {
          "first": "7/35",
          "2-3": "9/36",
          "4+": "6/44",
          "all": "22/115"
        },
        "wrong_ready": 0,
        "prompted_a_change": true
      },
      "second/folders/ready-all": {
        "needs_typing": {
          "first": "11/35",
          "2-3": "5/36",
          "4+": "2/44",
          "all": "18/115"
        },
        "ready": {
          "first": "7/35",
          "2-3": "9/36",
          "4+": "4/44",
          "all": "20/115"
        },
        "wrong_ready": 0
      },
      "second/no-folders/none": {
        "needs_typing": {
          "first": "11/35",
          "2-3": "18/36",
          "4+": "28/44",
          "all": "57/115"
        },
        "ready": {
          "first": "6/35",
          "2-3": "11/36",
          "4+": "5/44",
          "all": "22/115"
        },
        "wrong_ready": 0
      },
      "second/no-folders/rules": {
        "needs_typing": {
          "first": "11/35",
          "2-3": "13/36",
          "4+": "18/44",
          "all": "42/115"
        },
        "ready": {
          "first": "6/35",
          "2-3": "11/36",
          "4+": "8/44",
          "all": "25/115"
        },
        "wrong_ready": 0
      },
      "second/no-folders/shapes": {
        "needs_typing": {
          "first": "11/35",
          "2-3": "5/36",
          "4+": "1/44",
          "all": "17/115"
        },
        "ready": {
          "first": "6/35",
          "2-3": "11/36",
          "4+": "5/44",
          "all": "22/115"
        },
        "wrong_ready": 0
      },
      "third/folders/none": {
        "needs_typing": {
          "first": "8/22",
          "2-3": "13/24",
          "4+": "17/38",
          "all": "38/84"
        },
        "ready": {
          "first": "1/22",
          "2-3": "4/24",
          "4+": "3/38",
          "all": "8/84"
        },
        "wrong_ready": 0
      },
      "third/folders/rules": {
        "needs_typing": {
          "first": "8/22",
          "2-3": "10/24",
          "4+": "22/38",
          "all": "40/84"
        },
        "ready": {
          "first": "1/22",
          "2-3": "4/24",
          "4+": "6/38",
          "all": "11/84"
        },
        "wrong_ready": 0
      },
      "third/folders/shapes": {
        "needs_typing": {
          "first": "8/22",
          "2-3": "5/24",
          "4+": "7/38",
          "all": "20/84"
        },
        "ready": {
          "first": "1/22",
          "2-3": "4/24",
          "4+": "10/38",
          "all": "15/84"
        },
        "wrong_ready": 0,
        "prompted_a_change": true
      },
      "third/folders/careless": {
        "needs_typing": {
          "first": "8/22",
          "2-3": "5/24",
          "4+": "7/38",
          "all": "20/84"
        },
        "ready": {
          "first": "1/22",
          "2-3": "4/24",
          "4+": "8/38",
          "all": "13/84"
        },
        "wrong_ready": 0,
        "prompted_a_change": true
      },
      "third/folders/ready-all": {
        "needs_typing": {
          "first": "8/22",
          "2-3": "5/24",
          "4+": "7/38",
          "all": "20/84"
        },
        "ready": {
          "first": "1/22",
          "2-3": "4/24",
          "4+": "10/38",
          "all": "15/84"
        },
        "wrong_ready": 0,
        "prompted_a_change": true
      },
      "third/no-folders/none": {
        "needs_typing": {
          "first": "10/22",
          "2-3": "15/24",
          "4+": "29/38",
          "all": "54/84"
        },
        "ready": {
          "first": "2/22",
          "2-3": "4/24",
          "4+": "3/38",
          "all": "9/84"
        },
        "wrong_ready": 0
      },
      "third/no-folders/rules": {
        "needs_typing": {
          "first": "10/22",
          "2-3": "8/24",
          "4+": "23/38",
          "all": "41/84"
        },
        "ready": {
          "first": "2/22",
          "2-3": "4/24",
          "4+": "7/38",
          "all": "13/84"
        },
        "wrong_ready": 0
      },
      "third/no-folders/shapes": {
        "needs_typing": {
          "first": "10/22",
          "2-3": "3/24",
          "4+": "7/38",
          "all": "20/84"
        },
        "ready": {
          "first": "2/22",
          "2-3": "4/24",
          "4+": "11/38",
          "all": "17/84"
        },
        "wrong_ready": 0,
        "prompted_a_change": true
      }
    }
  }
}
```
