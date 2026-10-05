import type { Profile } from './api.js';
import { Field, Pills } from './ui.js';

/**
 * The household's few questions (decision 6): whether it owns or rents its
 * home, its vehicles, what else is in it, and where it lives. What the
 * missing-document suggestions are worked out from. Asked by the first-run
 * wizard, and on their own — the answers there already — from Reminders
 * (the 5.35 review, W535-10).
 */

export type AlsoInHousehold = 'children' | 'pets' | 'business' | 'rental';

export interface HouseholdAnswers {
  home: 'own' | 'rent' | null;
  vehicles: '0' | '1' | '2' | '3' | null;
  also: ReadonlySet<AlsoInHousehold>;
  country: string;
}

/** The answers as the vault holds them; none yet, the wizard's starting point. */
export function answersFrom(p: Partial<Profile> | null | undefined): HouseholdAnswers {
  const count = p?.vehicle_count;
  const also = new Set<AlsoInHousehold>();
  if (p?.has_pets) also.add('pets');
  if (p?.has_business) also.add('business');
  return {
    home: p?.owns_home ? 'own' : p?.rents_home ? 'rent' : null,
    vehicles:
      count === null || count === undefined
        ? null
        : (String(Math.min(count, 3)) as HouseholdAnswers['vehicles']),
    also,
    country: p?.country ?? 'US',
  };
}

/** The answers as PUT /profile takes them: what the vault keeps of them. */
export function answersBody(a: HouseholdAnswers): Partial<Profile> {
  const body: Partial<Profile> = { country: a.country };
  if (a.home) {
    body.owns_home = a.home === 'own';
    body.rents_home = a.home === 'rent';
  }
  if (a.vehicles) body.vehicle_count = Number(a.vehicles);
  body.has_pets = a.also.has('pets');
  body.has_business = a.also.has('business');
  return body;
}

const ALSO: ReadonlyArray<readonly [AlsoInHousehold, string]> = [
  ['children', 'Children'],
  ['pets', 'Pets'],
  ['business', 'A business'],
  ['rental', 'Rental property'],
];

/**
 * The questions, as pills and a field. `keptOnly`: only what the vault
 * keeps — pets and a business. Children (worked out from people's dates of
 * birth) and rental property are the wizard's alone, and kept nowhere.
 */
export function HouseholdAnswerFields(props: {
  value: HouseholdAnswers;
  onChange: (a: HouseholdAnswers) => void;
  keptOnly?: boolean;
}) {
  const { value, onChange } = props;
  const toggle = (k: AlsoInHousehold) => {
    const also = new Set(value.also);
    if (also.has(k)) also.delete(k);
    else also.add(k);
    onChange({ ...value, also });
  };
  const offered = props.keptOnly ? ALSO.filter(([k]) => k === 'pets' || k === 'business') : ALSO;
  return (
    <>
      <Pills
        label="Your home"
        value={value.home}
        onChange={(home) => onChange({ ...value, home })}
        options={[
          { value: 'own', label: 'We own it' },
          { value: 'rent', label: 'We rent' },
        ]}
      />
      <Pills
        label="Vehicles"
        value={value.vehicles}
        onChange={(vehicles) => onChange({ ...value, vehicles })}
        options={[
          { value: '0', label: 'None' },
          { value: '1', label: '1' },
          { value: '2', label: '2' },
          { value: '3', label: '3+' },
        ]}
      />
      <div className="field" role="group" aria-label="Also in the household">
        <span className="field-label">Also in the household</span>
        <div className="pills">
          {offered.map(([k, label]) => (
            <button
              key={k}
              type="button"
              className={`pill${value.also.has(k) ? ' pill-on' : ''}`}
              aria-pressed={value.also.has(k)}
              onClick={() => toggle(k)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <Field
        id="country"
        label="Where you live (country code)"
        value={value.country}
        onChange={(v) => onChange({ ...value, country: v.toUpperCase().slice(0, 2) })}
        hint="Sets which document types we suggest. US, GB, IN…"
      />
    </>
  );
}
