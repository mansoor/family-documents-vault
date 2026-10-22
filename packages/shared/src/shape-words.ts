/**
 * The only words a paper's shape may keep (0.9.0, R1, shapes.ts): the
 * everyday words papers are laid out with — their headings, their labels
 * and the words of a form letter — in lower case. A word is kept only if it
 * is here, and even then not if it is a word of the name of anybody of the
 * household (family or guest) or of the household's own name.
 *
 * Written for any household's papers, from what bills, statements, policies,
 * letters, certificates and forms say. Left out on purpose:
 *
 * - the words of an address (street, road, lane, avenue, close, drive, way,
 *   place, gardens, court, house numbers and names), places and countries;
 * - months and days of the week (a date's own words: so not "may", nor "day");
 * - the titles before a name (Mr, Mrs, Ms, Miss);
 * - words that are often a first name or a surname (will, bill, grant, mark,
 *   read, price, page, law, swift, hand, head, key, long, best, cash, kit,
 *   charity, gross, bank, rest…);
 * - words that are a value rather than a paper's layout (male, female,
 *   single, joint, yes, no, provisional, dog, cat);
 * - words that state a fact about somebody rather than what kind of paper
 *   it is: sensitive categories (diagnosis, disability, allergy, illness,
 *   sickness, injury, critical, death, blood, hearing) and what a letter may
 *   say of them (probation, caution, debt, arrears, overdue, default,
 *   missed, benefit, removal, release).
 *
 * Kept, though they may sound like facts about somebody, because each is
 * needed to tell a paper's kind and is common on that kind's layout — so a
 * shape may say what kind of paper it was, sealed under its person's key:
 *
 * - a medical record's and a prescription's (patient, doctor, gp, nurse,
 *   surgery, clinic, hospital, inpatient, outpatient, discharge, referral,
 *   treatment, medication, dose, tablets, prescription, immunisation,
 *   vaccine, booster, dental, dentist, pharmacy);
 * - an identity paper's labels (sex, gender, nationality, citizenship);
 * - a payslip's and a pension's (salary, wages, earnings, pension);
 * - a statement's and a loan's standing boxes (overdraft, mortgage,
 *   borrower), a breakdown policy's (recovery), a school report's (conduct,
 *   grade, merit).
 *
 * So no first name or surname of the common sort, no place, no street, no
 * month, no number and no company is here. A name that is also an everyday
 * layout word would be kept as that word when it is not somebody's of the
 * household; nothing else of them would be.
 *
 * Frozen again for 0.9.0 after the R1 re-check, its SHA-256 recorded in
 * docs/smart-exit.md and held by a test (apps/api/src/smart-corpus.test.ts).
 */
const LIST = `
a about above absence accept accepted access accident account accounts accrued act action active
activities actual add added additional address addressed adjustment adjusted administration
admission adult adults advance advice advised affect after again against age agency agent agreed
agreement aid alarm all allowance allowances allowed also alternative always amended amendment
amount amounts an and animal annual annually another answer any applicable applicant application
applied applies apply appointment appointments approved apr arrangement arrangements as assessment
asset assets assistance assurance at attached attendance authorised authority automatic available
average award awarded away

baby back bag baggage balance balances band banking based basic basis be because been before begin
begins behalf below better between bic billed billing bills birth board bonus book booked booking
booster borrower borrowing both box branch breakdown breed bring broadband brought budget building
buildings business but buy by

calendar call calls can cancel cancellation cancelled candidate cannot capital capsules car card
cardholder cards care carried categories category centre center certificate certificates certified
change changed changes charge charged charges check checked cheque child children choice choose
citizen citizenship city claim claims class clearly clinic close closed closing code codes collect
collected collection collections colour come commencement commencing comments commission common
communication company compensation complaint complaints complete completed comprehensive computer
condition conditions conduct confirm confirmation confirmed connection consent consumption contact
contacts contents continue continued contract contracts contribution contributions control copy
correct cost costs council counter county cover covered credit credits current currently customer
customers customs cycle

daily damage data date dated dates days deal dear debit debits decision declared deduction
deductions deed deferred degree delivery dental dentist department deposit deposits description
destination detail details device did difference digital direct directly discharge discount
discounts dispatch distinction district do doctor document documents does domestic done dose dosage
down drive driver drivers driving due during duty

each early earned earnings ease easy education effect effective effort either electric electricity
electronic eligible else email emergency employee employees employer employment enclosed end ended
ending ends energy engine enquiries enquiry ensure entitled entitlement entitlements entry equal
equipment estate estimate estimated estimates evening event every evidence exam examination
examinations example excess exchange excluded excluding executor executors exemption existing
expected expenses expire expired expires expiring expiry explained extended extension extra

face facility family fee fees file final finance financial find first fixed flexible following for
form former forms forward found free freehold frequency frequently from fuel full fully fund funds
further future

gas gcse gender general geography given go goods government gp grade grades group guarantee
guaranteed guardian guide

had half has have he health held help helpline her here high higher him hire his history hm hold
holder holders holiday home hospital hour hours how however

id identification identity if immunisation immunisations important in incl include included includes
including income increase increased independent index individual information initial inpatient
inside instalment instalments instruction instructions insurance insured insurer interest internet
into invoice invoiced invoices is isa issue issued issuer issues issuing it item items its itself

job just

keep keeper kind know

land landlord language last late later latest lead lease leasehold leave left legal lender less
letter level liability licence licences license life limit limited limits line lines list listed
loan loans local location look loss ltd lump

made main make management manager mandate match maturity maximum me means measure medical medication
medicine medicines meeting member members membership merit message meter method microchip middle
mileage minimum minutes mobile model money month monthly months more mortgage most mot motor much
multi music must my

name named names nationality national near need needed net network new next nhs ni nominated none
normal not note notes notice notification now number numbers nurse

of off offer offered office officer official often on once one online only open opened opening
option optional options or order ordered orders original other others our out outpatient outstanding
over overdraft overleaf overview own owner

paid paper parent parents part partial participant particular partner pass passed passport past
patient patients pay payable payee payment payments payslip pending pension per percentage period
periods permanent permit person personal pet pets pharmacy pharmacist phone physical pin plan plans
please plus point policies policy policyholder portal position possible post practice premium
premiums prepaid prescribed prescriber prescription prescriptions present previous previously
primary principal print printed prior priority privacy private procedure process product products
professional profile programme progress promotion proof property protected protection provide
provided provider pupil purchase purchased purpose

qualification qualifications quantity quarter quarterly queries query question questions quote
quoted

rate rates rating reading readings reason receipt received recent record recorded records recovery
reduced reduction ref reference referral refund regarding register registered registrar registration
registry regular regulated relationship remaining reminder renew renewal renewals renewed rent
rental repair repairs repay repayment repayments repeat replacement report reports request requested
required residence resident respect response responsibility result results retail retailer return
returned review revenue right rights role room

safe safety salary sale same saving savings schedule scheme school science score scores second
section secure secured security see send sent separate serial service services session set
settlement sex share sheet shown sign signature signed significant since smart society sort source
special species specified spend staff standard standing start started starting starts state
statement statements status stay student students subject subjects submit subscription subtotal
successful such summary supplier supply support surgery surname surrender switch

table tablet tablets take taken tariff tax taxable teacher telephone temporary tenancy tenant term
terms test tested text texts than thank thanks that the their them then there these they this those
through time times title to today total totals transaction transactions transfer transfers travel
traveller travellers treatment trip trust trustee type types

under unit units unless until up update updated upon usage use used user using

vaccination vaccinations vaccine valid validity value variable vat vehicle vet veterinary view visit
visits

wage wages want warranty was water we website week weekly welcome were what when where whether which
while who whole with withdrawal withdrawals within without witness work worldwide would write
written

year yearly years you your yours
`;

/** The words a paper's shape may keep: lower case, two letters or more. */
export const SHAPE_WORDS: ReadonlySet<string> = new Set(
  LIST.split(/\s+/).filter((w) => w.length >= 2),
);
