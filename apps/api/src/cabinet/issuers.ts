import { appendAudit, withPrincipal, type Db } from '@fdv/db';
import {
  aliasMap,
  apartPair,
  isIssuerKey,
  issuerGroupsOf,
  issuerRoot,
  leavingKey,
  NOTE_KIND,
  sameAsSuggestions,
  type AliasRow,
  type IssuerChange,
  type IssuerGroup,
  type IssuerGroups,
  type IssuerName,
} from '@fdv/shared';
import { sql } from 'kysely';
import type { Principal, RequestMeta } from '../auth/service.js';
import { ApiError, notFound } from '../errors.js';
import { readDocument } from '../documents/service.js';

/**
 * Who issued it, as one household names it (0.9.0-dev.91): the household's
 * "Same as" list (`issuer_alias`, 0129) and the issuers it groups, each
 * worked out from the papers the reader can read — the rule every list
 * keeps, a caregiver's grant included — so a key, a name, a count or a
 * suggestion never says more than they may see. The list itself is the
 * household's: owners and adults say which issuers are the same, and which
 * are separate, and each join and separation is a line in the household's
 * activity, its issuers named to each reader as their own papers name them.
 */

/** Whether the reader may join and separate issuers: owners and adults. */
export const mayJoinIssuers = (p: Principal): boolean => p.role === 'owner' || p.role === 'adult';

const NOT_YOURS = 'Only owners and adults say which issuers are the same.';
const NO_SUCH = 'That issuer is on no paper you can see, so it';

/**
 * What the reader can read of the household's issuers: each key's most used
 * spelling and how many papers carry it. Every key, or only `keys`.
 */
async function issuerNames(trx: Db, p: Principal, keys?: readonly string[]): Promise<IssuerName[]> {
  if (keys !== undefined && keys.length === 0) return [];
  return (
    await sql<IssuerName>`
      select d.issuer_key as key,
             mode() within group (order by d.issued_by) as name,
             count(*)::int as count
        from document d
       where ${readDocument(p)} and d.deleted_at is null
         and d.issuer_key is not null and d.issued_by is not null
         and d.type_key is distinct from ${NOTE_KIND}
         ${keys !== undefined ? sql`and d.issuer_key = any(${[...keys]}::text[])` : sql``}
       group by d.issuer_key`.execute(trx)
  ).rows;
}

/** The household's "Same as" list, each row with what its joins moved. */
async function aliasRows(trx: Db, p: Principal): Promise<AliasRow[]> {
  const rows = await trx
    .selectFrom('issuer_alias')
    .select(['from_key', 'to_key', 'path'])
    .where('household_id', '=', p.householdId)
    .execute();
  return rows.map((r) => ({ from: r.from_key, to: r.to_key, path: r.path }));
}

/** The household's "Same as" list, from → to. */
export async function aliasesOf(trx: Db, p: Principal): Promise<Map<string, string>> {
  return aliasMap(await aliasRows(trx, p));
}

/** The reader's issuers in groups, the "Same as" list applied. */
async function groupsOf(trx: Db, p: Principal): Promise<IssuerGroup[]> {
  return issuerGroupsOf(await issuerNames(trx, p), await aliasesOf(trx, p));
}

/**
 * Issuer keys as the reader knows their groups, for a drawing or a folder's
 * dividers: for each of `keys`, its group's key as the reader knows it
 * (`rep`: undefined where they can read no paper of the group) and its
 * name. Reads only the groups of `keys`, never the household's whole list.
 */
export interface IssuerFolding {
  rep: (key: string) => string | undefined;
  name: (key: string) => string;
  rootOf: (key: string) => string;
}

export async function issuerFolding(
  trx: Db,
  p: Principal,
  keys: readonly string[],
): Promise<IssuerFolding> {
  const aliases = await aliasesOf(trx, p);
  const roots = new Set(keys.map((k) => issuerRoot(k, aliases)));
  const groupKeys = new Set(roots);
  for (const [from, to] of aliases) if (roots.has(to)) groupKeys.add(from);
  const groups = issuerGroupsOf(await issuerNames(trx, p, [...groupKeys]), aliases);
  const byRoot = new Map(groups.map((g) => [issuerRoot(g.key, aliases), g] as const));
  const group = (k: string) => byRoot.get(issuerRoot(k, aliases));
  return {
    rep: (k) => group(k)?.key,
    name: (k) => group(k)?.name ?? k,
    rootOf: (k) => issuerRoot(k, aliases),
  };
}

/** Each key's name on the reader's own papers: none for a key they can read no paper of. */
export async function issuerNamesOf(
  trx: Db,
  p: Principal,
  keys: readonly string[],
): Promise<Map<string, string>> {
  return new Map((await issuerNames(trx, p, keys)).map((n) => [n.key, n.name] as const));
}

/** Issuers that look like one, for a reader who may say so: none for anybody else. */
export async function issuerSuggestions(trx: Db, p: Principal): Promise<IssuerGroups['same_as']> {
  if (!mayJoinIssuers(p)) return [];
  const aliases = await aliasesOf(trx, p);
  return suggestionsFor(trx, p, issuerGroupsOf(await issuerNames(trx, p), aliases), aliases);
}

async function suggestionsFor(
  trx: Db,
  p: Principal,
  groups: readonly IssuerGroup[],
  aliases: ReadonlyMap<string, string>,
) {
  const apart = await trx
    .selectFrom('issuer_apart')
    .select(['a_key', 'b_key'])
    .where('household_id', '=', p.householdId)
    .execute();
  return sameAsSuggestions(
    groups,
    apart.map((r) => [r.a_key, r.b_key] as const),
    aliases,
  );
}

async function answer(trx: Db, p: Principal): Promise<IssuerGroups> {
  const aliases = await aliasesOf(trx, p);
  const items = issuerGroupsOf(await issuerNames(trx, p), aliases);
  const may = mayJoinIssuers(p);
  return {
    items,
    same_as: may ? await suggestionsFor(trx, p, items, aliases) : [],
    may_change: may,
  };
}

/** GET /issuers/groups: the household's issuers as the reader can read them, and what looks like one. */
export async function issuerGroups(db: Db, p: Principal): Promise<IssuerGroups> {
  return withPrincipal(db, p, (trx) => answer(trx, p));
}

/** A change's two keys, checked: keys as the vault keeps them, and two of them. */
function checked(change: IssuerChange): IssuerChange {
  const { from, to } = change;
  if (!isIssuerKey(from) || !isIssuerKey(to)) {
    throw new ApiError(422, 'validation_failed', 'That is not who issued a document.', {
      detail: !isIssuerKey(from) ? 'from' : 'to',
    });
  }
  if (from === to) {
    throw new ApiError(422, 'validation_failed', 'Choose two different issuers.', {
      detail: 'to',
    });
  }
  return { from, to };
}

/** One change of the list at a time, in each household (0129's rule takes the same lock). */
const holdList = (trx: Db, p: Principal) =>
  sql`select pg_advisory_xact_lock(hashtextextended(${`issuer-alias:${p.householdId}`}, 0))`.execute(
    trx,
  );

/** The group a key is in, among the reader's. */
const groupWith = (groups: readonly IssuerGroup[], key: string) =>
  groups.find((g) => g.key === key || g.members.some((m) => m.key === key));

/**
 * POST /issuers/same: `from`'s issuer is the same as `to`'s — its whole
 * group (its own key and every key said to be the same as it) joins `to`'s,
 * whose own key it now points at: one level only, each row that moved
 * remembering the key it followed (`path`), for a separation to put back.
 * Both must be keys of papers the reader can read (else 404). Already one:
 * nothing changes. Owners and adults (else 403). Said in the household's
 * activity by the two keys, which each reader is told by their own names.
 */
export async function sameIssuer(
  db: Db,
  p: Principal,
  change: IssuerChange,
  meta: RequestMeta,
): Promise<IssuerGroups> {
  if (!mayJoinIssuers(p)) throw new ApiError(403, 'forbidden', NOT_YOURS);
  const { from, to } = checked(change);
  return withPrincipal(db, p, async (trx) => {
    await holdList(trx, p);
    const before = await groupsOf(trx, p);
    if (!groupWith(before, from) || !groupWith(before, to)) throw notFound(NO_SUCH);
    const aliases = await aliasesOf(trx, p);
    const fromRoot = issuerRoot(from, aliases);
    const toRoot = issuerRoot(to, aliases);
    if (fromRoot === toRoot) return answer(trx, p);
    const keysOf = (root: string) => [
      root,
      ...[...aliases].filter(([, t]) => t === root).map(([f]) => f),
    ];
    const moving = keysOf(fromRoot);
    const joining = keysOf(toRoot);
    // Every key said to be the same as `from`'s own now says `to`'s, having
    // followed `from`'s own; then `from`'s own does too. One level, always.
    await sql`
      update issuer_alias
         set to_key = ${toRoot}, path = array_prepend(${fromRoot}::text, path),
             created_by = ${p.accountId}::uuid, created_at = now()
       where household_id = ${p.householdId}::uuid and to_key = ${fromRoot}`.execute(trx);
    await trx
      .insertInto('issuer_alias')
      .values({
        household_id: p.householdId,
        from_key: fromRoot,
        to_key: toRoot,
        created_by: p.accountId,
      })
      .execute();
    // One now: no key that moved is kept apart from any of the group it joined.
    await sql`
      delete from issuer_apart
       where household_id = ${p.householdId}::uuid
         and ((a_key = any(${moving}::text[]) and b_key = any(${joining}::text[]))
           or (a_key = any(${joining}::text[]) and b_key = any(${moving}::text[])))`.execute(trx);
    await appendAudit(trx, {
      householdId: p.householdId,
      actorAccountId: p.accountId,
      action: 'issuer.joined',
      objectType: 'household',
      objectId: p.householdId,
      // The two keys, never a name: each reader is told them by their own papers.
      detail: { from_key: from, to_key: to },
      ip: meta.ip,
    });
    return answer(trx, p);
  });
}

/**
 * POST /issuers/separate: `from` is not the same issuer as `to`. Joined,
 * the one of them said to be the same as the other's group — `from` where
 * both are — leaves it, bringing back with it every key its own join moved,
 * said in the household's activity. Never joined, they are kept apart: never
 * suggested as one again. Either way they are remembered as separate. Both
 * must be keys of papers the reader can read (else 404). Owners and adults
 * (else 403).
 */
export async function separateIssuer(
  db: Db,
  p: Principal,
  change: IssuerChange,
  meta: RequestMeta,
): Promise<IssuerGroups> {
  if (!mayJoinIssuers(p)) throw new ApiError(403, 'forbidden', NOT_YOURS);
  const { from, to } = checked(change);
  return withPrincipal(db, p, async (trx) => {
    await holdList(trx, p);
    const before = await groupsOf(trx, p);
    if (!groupWith(before, from) || !groupWith(before, to)) throw notFound(NO_SUCH);
    const aliases = await aliasesOf(trx, p);
    const leaving = leavingKey(aliases, from, to);
    let pair = apartPair(from, to);
    if (leaving !== null) {
      const root = issuerRoot(leaving, aliases);
      await trx
        .deleteFrom('issuer_alias')
        .where('household_id', '=', p.householdId)
        .where('from_key', '=', leaving)
        .execute();
      // What its own join brought with it follows it again.
      await sql`
        update issuer_alias
           set to_key = ${leaving},
               path = path[array_position(path, ${leaving}::text) + 1:],
               created_at = now()
         where household_id = ${p.householdId}::uuid and ${leaving}::text = any(path)`.execute(trx);
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'issuer.separated',
        objectType: 'household',
        objectId: p.householdId,
        detail: { from_key: leaving, to_key: leaving === from ? to : from },
        ip: meta.ip,
      });
      pair = apartPair(leaving, root);
    }
    await trx
      .insertInto('issuer_apart')
      .values({
        household_id: p.householdId,
        a_key: pair[0],
        b_key: pair[1],
        created_by: p.accountId,
      })
      .onConflict((oc) =>
        oc
          .columns(['household_id', 'a_key', 'b_key'])
          .doUpdateSet({ created_by: p.accountId, created_at: sql<Date>`now()` }),
      )
      .execute();
    return answer(trx, p);
  });
}
