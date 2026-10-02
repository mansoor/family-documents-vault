import { effectiveVisibility, visibilityChoices } from '@fdv/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { clearPhotos, photosHeld } from './photos.js';
import { ID_NUMBERS_NOTE } from './screens/Person.js';
import { AISHA, fresh, installFakeApi, ME, PASSPORT, signedIn } from './test-api.js';

/**
 * A person's profile, and their photo (5.17c): a name on Home opens their
 * documents, a name on People their profile (A64); the photo is chosen,
 * cropped here, sent crop first, and fetched with the token into memory.
 */

/** Every object URL let go, as the page lets them go. */
let revoked = vi.fn();

beforeEach(() => {
  // What the last test's page held, as a sign-out would forget it.
  clearPhotos();
  localStorage.clear();
  window.history.replaceState({}, '', '/');
  // jsdom has no object URLs, and draws no pictures: each photo's URL is
  // its number, and every picture is 800 by 600.
  let made = 0;
  revoked = vi.fn();
  Object.assign(URL, {
    createObjectURL: vi.fn(() => `blob:photo-${++made}`),
    revokeObjectURL: revoked,
  });
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 800, height: 600, close: () => undefined })),
  );
});
afterEach(() => vi.unstubAllGlobals());

async function expectAccessible() {
  const results = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false } }, // jsdom has no layout
  });
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
  ).toEqual([]);
}

/** Aisha Khan, a child with no sign-in, one document of her own. */
const AISHA_KHAN = {
  ...AISHA,
  display_name: 'Aisha Khan',
  relationship: 'Daughter',
  document_count: 1,
  photo: null,
  photo_status: null,
  can_change_photo: true,
};
const HER_DOC = { ...PASSPORT, id: 'doc-a', title: 'Aisha’s passport', owner_member_id: 'm-0' };

const at = (path: string) => window.history.replaceState({}, '', path);
const pathname = () => window.location.pathname;
const photo = () => document.querySelector<HTMLImageElement>('img.avatar-photo');

describe("a person's profile (5.17c)", () => {
  it("a name on Home opens that person's documents; a name on People opens their profile", async () => {
    installFakeApi(fresh({ members: [ME, AISHA_KHAN], documents: [PASSPORT, HER_DOC] }));
    signedIn();
    render(<App />);
    // Home's chip says whose documents it opens, and shows her first name.
    const chip = await screen.findByRole('link', { name: 'Aisha Khan’s documents' });
    expect(chip).toHaveTextContent('Aisha');
    fireEvent.click(chip);
    await screen.findByRole('heading', { name: 'Aisha’s documents' });
    expect(pathname()).toBe('/people/m-0/documents');
    expect(await screen.findByText('Aisha’s passport')).toBeInTheDocument();
    expect(screen.queryByText("Mansoor's passport")).not.toBeInTheDocument();

    // People's row opens her profile.
    fireEvent.click(screen.getByRole('link', { name: 'People' }));
    fireEvent.click(await screen.findByRole('button', { name: /Aisha Khan/ }));
    await screen.findByRole('heading', { name: 'Aisha Khan' });
    expect(pathname()).toBe('/people/m-0');
    expect(screen.getByText('No sign-in')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Aisha’s documents' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See all 1 document' })).toBeInTheDocument();
    // And back from the profile goes to People.
    expect(screen.getByRole('link', { name: 'Back' })).toHaveAttribute('href', '/people');
    await expectAccessible();
  });

  it('the documents screen goes back to where it came from, and About Aisha opens the profile', async () => {
    installFakeApi(fresh({ members: [ME, AISHA_KHAN], documents: [PASSPORT, HER_DOC] }));
    signedIn();
    render(<App />);
    // From Home: back to Home.
    fireEvent.click(await screen.findByRole('link', { name: 'Aisha Khan’s documents' }));
    await screen.findByRole('heading', { name: 'Aisha’s documents' });
    expect(screen.getByRole('link', { name: 'Back' })).toHaveAttribute('href', '/');
    // About Aisha: her profile.
    fireEvent.click(screen.getByRole('link', { name: 'About Aisha' }));
    await screen.findByRole('heading', { name: 'Aisha Khan' });
    // From her profile: back to her profile.
    fireEvent.click(screen.getByRole('link', { name: 'See all 1 document' }));
    await screen.findByRole('heading', { name: 'Aisha’s documents' });
    expect(screen.getByRole('link', { name: 'Back' })).toHaveAttribute('href', '/people/m-0');
    fireEvent.click(screen.getByRole('link', { name: 'Back' }));
    await screen.findByRole('heading', { name: 'Aisha Khan' });
  });

  it('an old bookmark of a person lands on the profile; their documents from anywhere go back to it', async () => {
    installFakeApi(fresh({ members: [ME, AISHA_KHAN], documents: [PASSPORT, HER_DOC] }));
    signedIn();
    at('/people/m-0/documents');
    render(<App />);
    await screen.findByRole('heading', { name: 'Aisha’s documents' });
    expect(screen.getByRole('link', { name: 'Back' })).toHaveAttribute('href', '/people/m-0');
  });

  it('your own are "Your documents"; somebody unknown is not there', async () => {
    installFakeApi(fresh({ members: [ME, AISHA_KHAN] }));
    signedIn();
    at('/people/me/documents');
    const { unmount } = render(<App />);
    await screen.findByRole('heading', { name: 'Your documents' });
    unmount();
    at('/people/nobody');
    render(<App />);
    expect(await screen.findByText('We can’t find that person.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to People' })).toHaveAttribute('href', '/people');
  });

  it('the role controls are on the profile', async () => {
    const teen = { ...AISHA, id: 'm-1', display_name: 'Tess', has_account: true, role: 'teen' };
    installFakeApi(fresh({ members: [ME, teen] }));
    signedIn();
    at('/people/m-1');
    const { unmount } = render(<App />);
    await screen.findByRole('heading', { name: 'What Tess can do' });
    expect(screen.getByText('Teen', { selector: 'p' })).toBeInTheDocument();
    unmount();
    // Not on her documents.
    at('/people/m-1/documents');
    render(<App />);
    await screen.findByRole('heading', { name: 'Tess’s documents' });
    expect(screen.queryByRole('heading', { name: 'What Tess can do' })).not.toBeInTheDocument();
  });

  it('Add someone takes a relationship, and the profile shows it', async () => {
    const state = fresh({ members: [ME] });
    installFakeApi(state);
    signedIn();
    at('/people');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add someone' }));
    fireEvent.change(screen.getByLabelText('Name of another family member'), {
      target: { value: 'Aisha' },
    });
    fireEvent.change(screen.getByLabelText('Date of birth'), { target: { value: '2016-04-02' } });
    const relationship = screen.getByLabelText('Relationship (optional)');
    expect(screen.getByText('For example: Mum, Son, Grandad')).toBeInTheDocument();
    fireEvent.change(relationship, { target: { value: 'Daughter' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(
        state.calls.find((c) => c.method === 'POST' && c.url === '/api/v1/members')?.body,
      ).toEqual({
        display_name: 'Aisha',
        date_of_birth: '2016-04-02',
        relationship: 'Daughter',
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: /Aisha/ }));
    const about = await screen.findByRole('region', { name: 'About' });
    expect(within(about).getByText('Relationship')).toBeInTheDocument();
    expect(within(about).getByText('Daughter')).toBeInTheDocument();
    const age =
      new Date().getFullYear() -
      2016 -
      (new Date() < new Date(new Date().getFullYear(), 3, 2) ? 1 : 0);
    expect(within(about).getByText(`2 April 2016 · ${age}`)).toBeInTheDocument();
  });

  it('two people with the same first name are named in full on their screens', async () => {
    // Home tells Sam Khan and Sam Malik apart; their screens did not (the
    // 5.17c review): both were "Sam's documents", with "About Sam".
    const samKhan = { ...AISHA_KHAN, id: 'm-1', display_name: 'Sam Khan', photo: { id: 'p-sam' } };
    const samMalik = { ...AISHA_KHAN, id: 'm-2', display_name: 'Sam Malik' };
    installFakeApi(fresh({ members: [ME, AISHA_KHAN, samKhan, samMalik] }));
    signedIn();
    at('/people/m-1/documents');
    const { unmount } = render(<App />);
    await screen.findByRole('heading', { name: 'Sam Khan’s documents', level: 1 });
    fireEvent.click(screen.getByRole('link', { name: 'About Sam Khan' }));
    await screen.findByRole('heading', { name: 'Sam Khan', level: 1 });
    expect(screen.getByRole('heading', { name: 'Sam Khan’s documents' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove photo' }));
    expect(
      await screen.findByRole('alertdialog', { name: 'Remove Sam Khan’s photo?' }),
    ).toBeInTheDocument();
    unmount();
    // A first name nobody else has is still just that.
    at('/people/m-0/documents');
    render(<App />);
    await screen.findByRole('heading', { name: 'Aisha’s documents', level: 1 });
    expect(screen.getByRole('link', { name: 'About Aisha' })).toBeInTheDocument();
  });

  it("a viewer sees no one else's birthday, relationship or photo", async () => {
    // As the vault answers a viewer: nobody's details but their own.
    const me = { ...ME, role: 'viewer', relationship: 'Our accountant', can_change_photo: false };
    const aisha = {
      ...AISHA_KHAN,
      date_of_birth: null,
      relationship: null,
      photo: null,
      can_change_photo: false,
    };
    const state = fresh({ members: [me, aisha] });
    installFakeApi(state);
    signedIn('viewer');
    at('/people/m-0');
    const { unmount } = render(<App />);
    await screen.findByRole('heading', { name: 'Aisha Khan' });
    expect(screen.queryByRole('region', { name: 'About' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /photo/i })).not.toBeInTheDocument();
    expect(photo()).toBeNull();
    expect(state.calls.some((c) => c.url.includes('/photo'))).toBe(false);
    unmount();
    // Their own, they are told.
    at('/people/me');
    render(<App />);
    expect(await screen.findByText('Our accountant')).toBeInTheDocument();
    expect(screen.getByText('You · Viewer')).toBeInTheDocument();
  });

  it('every sentence of the ID-numbers note is what the vault does', () => {
    // The 5.17c review: it said teens and viewers could not open these, and
    // a teen's was for Everyone, viewers included. A teen's own is now their
    // Only me (the owner's decision), and the note says so.
    const nationalId = { default_visibility: 'adults' as const };
    expect(ID_NUMBERS_NOTE).toContain('One an owner or adult files is Adults only by default');
    expect(effectiveVisibility({}, nationalId, 'owner')).toBe('adults');
    expect(effectiveVisibility({}, nationalId, 'adult')).toBe('adults');
    expect(ID_NUMBERS_NOTE).toContain('One a teen files is their Only me by default');
    expect(effectiveVisibility({}, nationalId, 'teen')).toBe('private');
    // Only they can open it, or make it Everyone (A72): nobody else may
    // change a document of somebody else's that is Only me.
    expect(ID_NUMBERS_NOTE).toContain('only they can open it, or make it Everyone');
    const who = (role: 'owner' | 'adult' | 'teen' | 'viewer', mine: boolean, filedByMe = mine) => ({
      role,
      mine,
      filedByMe,
    });
    expect(visibilityChoices(who('teen', true), 'private')).toEqual(['household', 'private']);
    for (const role of ['owner', 'adult', 'viewer'] as const) {
      expect(visibilityChoices(who(role, false), 'private'), role).toEqual([]);
    }
    expect(ID_NUMBERS_NOTE).toContain(
      'Owners and adults can change who sees the documents they can open, and make their own Only me',
    );
    expect(visibilityChoices(who('adult', false), 'household')).toEqual(['household', 'adults']);
    expect(visibilityChoices(who('adult', true), 'adults')).toEqual([
      'household',
      'adults',
      'private',
    ]);
    expect(ID_NUMBERS_NOTE).toContain(
      'teens can switch their own documents that they filed between Only me and Everyone',
    );
    expect(visibilityChoices(who('teen', true), 'household')).toEqual(['household', 'private']);
    // One an owner filed for them is not theirs to hide (the 5.17c review).
    expect(visibilityChoices(who('teen', true, false), 'household')).toEqual([]);
    expect(visibilityChoices(who('teen', false), 'household')).toEqual([]);
    expect(visibilityChoices(who('viewer', true), 'household')).toEqual([]);
    expect(ID_NUMBERS_NOTE).not.toMatch(/Whoever a document belongs to/);
  });

  it('only owners see the ID-numbers note', async () => {
    installFakeApi(fresh({ members: [ME, AISHA_KHAN] }));
    signedIn();
    at('/people/m-0');
    const { unmount } = render(<App />);
    expect(await screen.findByText(ID_NUMBERS_NOTE)).toBeInTheDocument();
    expect(ID_NUMBERS_NOTE).toBe(
      "SSN and other ID numbers get their own sealed place here in a later release. Until then they are kept in 'Social security / national ID' documents. One an owner or adult files is Adults only by default: owners and adults can open it, teens and viewers can't. One a teen files is their Only me by default: only they can open it, or make it Everyone. Owners and adults can change who sees the documents they can open, and make their own Only me; teens can switch their own documents that they filed between Only me and Everyone. In Kinds of document an owner can make Only me the default for the ones people file for themselves.",
    );
    unmount();
    for (const role of ['adult', 'teen', 'viewer'] as const) {
      installFakeApi(fresh({ members: [{ ...ME, role }, AISHA_KHAN] }));
      signedIn(role);
      at('/people/m-0');
      const r = render(<App />);
      await screen.findByRole('heading', { name: 'Aisha Khan' });
      expect(screen.queryByText(ID_NUMBERS_NOTE), role).not.toBeInTheDocument();
      r.unmount();
    }
  });
});

describe("a person's photo (5.17c)", () => {
  /** A picture, as a phone's file picker hands one over. */
  const picture = (bytes = 1000, name = 'IMG_2041.jpg') => {
    const file = new File([new Uint8Array(Math.min(bytes, 1000))], name, { type: 'image/jpeg' });
    if (bytes > 1000) Object.defineProperty(file, 'size', { value: bytes });
    return file;
  };
  const choose = async (file: File) => {
    const button = await screen.findByRole('button', { name: /Add a photo|Change photo/ });
    button.focus();
    fireEvent.change(screen.getByLabelText('Choose a photo'), { target: { files: [file] } });
    return button;
  };

  it('the crop sheet takes focus, arrow keys move the photo, Escape cancels and focus returns', async () => {
    const state = fresh({ members: [ME, AISHA_KHAN] });
    installFakeApi(state);
    signedIn();
    at('/people/m-0');
    render(<App />);
    expect(
      await screen.findByText(/Everyone in the family can see this photo/),
    ).toBeInTheDocument();
    const button = await choose(picture());
    const sheet = await screen.findByRole('dialog', { name: 'Choose the part to show' });
    const frame = within(sheet).getByRole('group');
    expect(document.activeElement).toBe(frame);
    const img = await waitFor(() => {
      const found = sheet.querySelector<HTMLImageElement>('img.crop-photo');
      expect(found).not.toBeNull();
      return found as HTMLImageElement;
    });
    // 800 by 600 in a 280 frame: its middle, to begin with.
    const before = img.style.transform;
    fireEvent.keyDown(frame, { key: 'ArrowRight' });
    expect(img.style.transform).not.toBe(before);
    fireEvent.keyDown(frame, { key: 'ArrowLeft' });
    expect(img.style.transform).toBe(before);
    expect(within(sheet).getByLabelText('Zoom')).toBeInTheDocument();
    await expectAccessible();
    // Escape: nothing sent, and focus back on the button that began it.
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(button);
    expect(state.calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('a photo chosen is sent crop first, and the profile says when it is ready', async () => {
    const state = fresh({ members: [ME, AISHA_KHAN] });
    installFakeApi(state);
    signedIn();
    at('/people/m-0');
    render(<App />);
    await choose(picture());
    const sheet = await screen.findByRole('dialog', { name: 'Choose the part to show' });
    const frame = within(sheet).getByRole('group');
    await waitFor(() => expect(sheet.querySelector('img.crop-photo')).not.toBeNull());
    // As far left as it goes: the picture's left edge.
    for (let i = 0; i < 20; i++) fireEvent.keyDown(frame, { key: 'ArrowRight', shiftKey: true });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Use this photo' }));
    await screen.findByText('Getting the photo ready…');
    expect(state.photoUploads).toEqual([
      { member: 'm-0', fields: ['crop', 'file'], crop: { x: 0, y: 0, w: 0.75, h: 1 } },
    ]);
    // Focus is back on the button that began it, which waits, focusable,
    // while the photo is made: not on the page (the 5.17c review).
    const add = screen.getByRole('button', { name: 'Add a photo' });
    expect(document.activeElement).toBe(add);
    expect(add).toHaveAttribute('aria-disabled', 'true');
    expect(await screen.findByText('Photo updated.', {}, { timeout: 6000 })).toBeInTheDocument();
    await waitFor(() => expect(photo()?.getAttribute('src')).toMatch(/^blob:photo-/));
    expect(screen.getByRole('button', { name: 'Change photo' })).toBeInTheDocument();
  }, 15_000);

  it('a photo the vault could not use says so', async () => {
    installFakeApi(fresh({ members: [ME, AISHA_KHAN], photoRefused: true }));
    signedIn();
    at('/people/m-0');
    render(<App />);
    await choose(picture());
    const sheet = await screen.findByRole('dialog', { name: 'Choose the part to show' });
    await waitFor(() => expect(sheet.querySelector('img.crop-photo')).not.toBeNull());
    fireEvent.click(within(sheet).getByRole('button', { name: 'Use this photo' }));
    expect(
      await screen.findByText(
        'We couldn’t use that photo. Try another one.',
        {},
        { timeout: 6000 },
      ),
    ).toBeInTheDocument();
  }, 15_000);

  it('a photo this browser cannot draw goes as it is, to use its middle', async () => {
    const state = fresh({ members: [ME, AISHA_KHAN] });
    installFakeApi(state);
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => {
        throw new Error('HEIC');
      }),
    );
    signedIn();
    at('/people/m-0');
    render(<App />);
    await choose(picture(1000, 'IMG_2041.heic'));
    const sheet = await screen.findByRole('dialog', { name: 'Choose the part to show' });
    expect(await within(sheet).findByText(/so we’ll use the middle of it\.$/)).toBeInTheDocument();
    const use = within(sheet).getByRole('button', { name: 'Use this photo' });
    await waitFor(() => expect(document.activeElement).toBe(use));
    fireEvent.click(use);
    await screen.findByText('Getting the photo ready…');
    expect(state.photoUploads?.[0]).toMatchObject({ fields: ['file'], crop: null });
  });

  it('a photo over 20 MB is refused before sending', async () => {
    const state = fresh({ members: [ME, AISHA_KHAN] });
    installFakeApi(state);
    signedIn();
    at('/people/m-0');
    render(<App />);
    await choose(picture(21 * 1024 * 1024));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That photo is over 20 MB. Choose a smaller one.',
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(state.calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('Remove photo asks first and says the backups keep it', async () => {
    const state = fresh({ members: [ME, { ...AISHA_KHAN, photo: { id: 'p-1' } }] });
    installFakeApi(state);
    signedIn();
    at('/people/m-0');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove photo' }));
    const asked = await screen.findByRole('alertdialog', { name: 'Remove Aisha’s photo?' });
    expect(asked).toHaveTextContent(
      'Their initials will show instead. The vault’s nightly backups keep it until they expire, 30 days by default.',
    );
    await expectAccessible();
    fireEvent.click(within(asked).getByRole('button', { name: 'Cancel' }));
    expect(state.calls.some((c) => c.method === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Remove photo' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove photo' }),
    );
    await screen.findByText('Photo removed.');
    expect(state.calls.find((c) => c.method === 'DELETE')?.url).toBe('/api/v1/members/m-0/photo');
    expect(state.members.find((m) => m.id === 'm-0')?.photo).toBeNull();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Remove photo' })).not.toBeInTheDocument(),
    );
    // Its button went with the photo: focus is on Add a photo, not the page.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add a photo' }));
  });

  it('when removing fails, the dialog closes and the reason is on the page', async () => {
    const state = fresh({ members: [ME, { ...AISHA_KHAN, photo: { id: 'p-1' } }] });
    installFakeApi(state);
    const fake = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (init?.method === 'DELETE' && url.endsWith('/photo')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                code: 'internal_error',
                message: 'Something went wrong on the server. It has been logged.',
                retriable: true,
                request_id: 'r',
              },
            }),
            { status: 500, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      return fake(input, init);
    });
    signedIn();
    at('/people/m-0');
    render(<App />);
    const button = await screen.findByRole('button', { name: 'Remove photo' });
    button.focus();
    fireEvent.click(button);
    const asked = await screen.findByRole('alertdialog', { name: 'Remove Aisha’s photo?' });
    fireEvent.click(within(asked).getByRole('button', { name: 'Remove photo' }));
    // Not behind a dialog left open: closed, and said on the page.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong on the server. It has been logged.',
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove photo' })),
    );
  });

  it('a viewer may remove their own photo, and set none', async () => {
    const me = { ...ME, role: 'viewer', photo: { id: 'p-me' }, can_change_photo: false };
    installFakeApi(fresh({ members: [me, { ...AISHA_KHAN, can_change_photo: false }] }));
    signedIn('viewer');
    at('/people/me');
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Remove photo' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Add a photo|Change photo/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove photo' }));
    const asked = await screen.findByRole('alertdialog', { name: 'Remove your photo?' });
    expect(asked).toHaveTextContent('Your initials will show instead.');
    fireEvent.click(within(asked).getByRole('button', { name: 'Remove photo' }));
    const said = await screen.findByText('Photo removed.');
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Remove photo' })).not.toBeInTheDocument(),
    );
    // No button is left: focus is on what was said, not the page.
    expect(document.activeElement).toBe(said);
    expect(said).toHaveAttribute('role', 'status');
  });

  it("a crop pushed to the picture's edge after zooming is inside it, as the vault counts", async () => {
    // 800 by 600 at zoom 1.6, as far right as it goes: rounded each on its
    // own, x and w came to 1.0001, and the vault refused it (the 5.17c review).
    // A copy of her: the fake changes the people it is given.
    const state = fresh({ members: [ME, { ...AISHA_KHAN }] });
    installFakeApi(state);
    signedIn();
    at('/people/m-0');
    render(<App />);
    await choose(picture());
    const sheet = await screen.findByRole('dialog', { name: 'Choose the part to show' });
    await waitFor(() => expect(sheet.querySelector('img.crop-photo')).not.toBeNull());
    fireEvent.change(within(sheet).getByLabelText('Zoom'), { target: { value: '1.6' } });
    const frame = within(sheet).getByRole('group');
    for (let i = 0; i < 20; i++) fireEvent.keyDown(frame, { key: 'ArrowLeft', shiftKey: true });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Use this photo' }));
    await screen.findByText('Getting the photo ready…');
    const crop = state.photoUploads?.[0]?.crop as { x: number; y: number; w: number; h: number };
    expect(crop).toEqual({ x: 0.5312, y: 0.1875, w: 0.4688, h: 0.625 });
    // The vault's rule (parseCrop): fractions, inside the picture, 0.05 a side at least.
    for (const v of Object.values(crop)) expect(v >= 0 && v <= 1).toBe(true);
    expect(crop.x + crop.w).toBeLessThanOrEqual(1 + 1e-9);
    expect(crop.y + crop.h).toBeLessThanOrEqual(1 + 1e-9);
    expect(Math.min(crop.w, crop.h)).toBeGreaterThanOrEqual(0.05);
  });

  it('when sending fails, the reason is said in the sheet, and focus stays in it', async () => {
    // A copy of her: the fake changes the people it is given.
    const state = fresh({ members: [ME, { ...AISHA_KHAN }] });
    installFakeApi(state);
    // The vault refuses the picture as what its bytes are.
    const fake = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (init?.method === 'PUT' && url.endsWith('/photo')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                code: 'unsupported_type',
                message: 'Choose a photo: JPEG, PNG, WebP or HEIC.',
                retriable: false,
                request_id: 'r',
              },
            }),
            { status: 415, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      return fake(input, init);
    });
    signedIn();
    at('/people/m-0');
    render(<App />);
    await choose(picture());
    const sheet = await screen.findByRole('dialog', { name: 'Choose the part to show' });
    await waitFor(() => expect(sheet.querySelector('img.crop-photo')).not.toBeNull());
    const use = within(sheet).getByRole('button', { name: 'Use this photo' });
    use.focus();
    fireEvent.click(use);
    // Inside the sheet, which is still open, not behind it.
    expect(await within(sheet).findByRole('alert')).toHaveTextContent(
      'Choose a photo: JPEG, PNG, WebP or HEIC.',
    );
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    await waitFor(() => expect(use).toHaveTextContent('Use this photo'));
    expect(sheet.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(use);
    await expectAccessible();
    // Cancelled, the reason goes with the sheet.
    fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('on a narrow screen the frame is as wide as the sheet has room for, and as tall', async () => {
    // At 320 pixels the sheet has 254 for it: the frame was 254 wide and
    // 280 tall, its guide an oval, and what was sent a square it never
    // showed (the 5.17c review).
    const room = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (
      this: Element,
    ) {
      return this.classList.contains('crop-room') ? 254 : 0;
    });
    try {
      // A copy of her: the fake changes the people it is given.
      const state = fresh({ members: [ME, { ...AISHA_KHAN }] });
      installFakeApi(state);
      signedIn();
      at('/people/m-0');
      render(<App />);
      await choose(picture());
      const sheet = await screen.findByRole('dialog', { name: 'Choose the part to show' });
      const img = await waitFor(() => {
        const found = sheet.querySelector<HTMLImageElement>('img.crop-photo');
        expect(found).not.toBeNull();
        return found as HTMLImageElement;
      });
      const frame = within(sheet).getByRole('group');
      expect(frame.style.width).toBe('254px');
      expect(frame.style.height).toBe('254px');
      // The picture covers that square: 600 tall is 254, 800 wide in proportion.
      expect(parseFloat(img.style.height)).toBeCloseTo(254, 5);
      expect(parseFloat(img.style.width)).toBeCloseTo((800 * 254) / 600, 5);
      // As far left as it goes, the square shown is the one sent.
      for (let i = 0; i < 20; i++) fireEvent.keyDown(frame, { key: 'ArrowLeft', shiftKey: true });
      fireEvent.click(within(sheet).getByRole('button', { name: 'Use this photo' }));
      await screen.findByText('Getting the photo ready…');
      expect(state.photoUploads?.[0]?.crop).toEqual({ x: 0.25, y: 0, w: 0.75, h: 1 });
    } finally {
      room.mockRestore();
    }
  });

  it('photos are fetched with the token, kept in memory and forgotten at sign-out', async () => {
    const state = fresh({
      members: [ME, { ...AISHA_KHAN, photo: { id: 'p-1' } }],
    });
    installFakeApi(state);
    signedIn();
    render(<App />);
    await screen.findByRole('link', { name: 'Aisha Khan’s documents' });
    await waitFor(() => expect(photo()?.getAttribute('src')).toBe('blob:photo-1'));
    const fetched = state.calls.filter((c) => c.url === '/api/v1/members/m-0/photo/p-1');
    expect(fetched).toHaveLength(1);
    expect(fetched[0]?.headers?.authorization).toBe('Bearer a.b.c');
    expect(photosHeld()).toBe(1);
    // Her profile shows the same one, from memory: not fetched again.
    fireEvent.click(screen.getByRole('link', { name: 'People' }));
    fireEvent.click(await screen.findByRole('button', { name: /Aisha Khan/ }));
    await screen.findByRole('heading', { name: 'Aisha Khan' });
    await waitFor(() => expect(photo()?.getAttribute('src')).toBe('blob:photo-1'));
    expect(state.calls.filter((c) => c.url.endsWith('/photo/p-1'))).toHaveLength(1);
    // Signing out lets every one go.
    fireEvent.click(screen.getByRole('link', { name: 'Home' }));
    fireEvent.click(await screen.findByRole('link', { name: 'Settings' }));
    const signOut = await screen.findAllByRole('button', { name: 'Sign out' });
    await act(async () => {
      fireEvent.click(signOut[signOut.length - 1] as HTMLElement);
    });
    await waitFor(() => expect(photosHeld()).toBe(0));
    expect(revoked).toHaveBeenCalledWith('blob:photo-1');
  });
});

describe("a person's details, and the owner's view of a sign-in (5.25)", () => {
  /** Grandad, with no sign-in. */
  const GRANDAD = {
    ...AISHA_KHAN,
    id: 'm-2',
    display_name: 'Grandad',
    relationship: 'Grandad',
    date_of_birth: '1940-01-09',
  };
  /** Tess, a teen with a sign-in. */
  const TESS = { ...AISHA, id: 'm-1', display_name: 'Tess', has_account: true, role: 'teen' };
  const TESS_ACCOUNT = {
    member_id: 'm-1',
    role: 'teen' as const,
    email: 'tess.khan.with.a.very.long.address@example.test',
    two_step: false,
    passkeys: 0,
    last_signed_in_at: new Date().toISOString(),
    devices: [
      {
        label: 'Safari on a Mac',
        client: 'browser' as const,
        last_used_at: new Date().toISOString(),
        offline: false,
      },
      {
        label: 'the app on a Google Pixel 8a',
        client: 'app' as const,
        last_used_at: new Date().toISOString(),
        offline: true,
      },
    ],
  };
  const edits = (state: { memberEdits?: Array<{ body: unknown; ifMatch: string | null }> }) =>
    state.memberEdits ?? [];

  it('Edit details sends only what changed, made to the version it opened, and says so', async () => {
    // A copy: a change is made to the person the vault holds.
    const state = fresh({ members: [ME, { ...AISHA_KHAN }] });
    installFakeApi(state);
    signedIn();
    at('/people/m-0');
    render(<App />);
    const about = await screen.findByRole('region', { name: 'About' });
    fireEvent.click(within(about).getByRole('button', { name: 'Edit details' }));
    const form = within(about).getByRole('form', { name: 'Aisha’s details' });
    // The name first, ready to change.
    expect(within(form).getByLabelText('Name')).toHaveFocus();
    expect(within(form).getByLabelText('Name')).toHaveValue('Aisha Khan');
    expect(within(form).getByLabelText('Relationship (optional)')).toHaveValue('Daughter');
    expect(within(form).getByLabelText('Date of birth (optional)')).toHaveValue('2016-04-02');
    // No child without a sign-in is recorded as passed away by an adult; an owner may.
    expect(within(form).getByLabelText('They have passed away')).not.toBeChecked();
    await expectAccessible();

    fireEvent.change(within(form).getByLabelText('Relationship (optional)'), {
      target: { value: '  Niece ' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(about).findByText('Details saved.')).toBeInTheDocument();
    expect(edits(state)).toEqual([{ id: 'm-0', body: { relationship: 'Niece' }, ifMatch: '"1"' }]);
    expect(within(about).getByText('Niece')).toBeInTheDocument();
    expect(within(about).queryByRole('form')).not.toBeInTheDocument();
    // Back where it began.
    expect(within(about).getByRole('button', { name: 'Edit details' })).toHaveFocus();

    // Nothing changed: nothing sent, and the form goes.
    fireEvent.click(within(about).getByRole('button', { name: 'Edit details' }));
    fireEvent.click(within(about).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(about).queryByRole('form')).not.toBeInTheDocument());
    expect(edits(state)).toHaveLength(1);
  });

  it('a stale version says somebody else changed them, and shows what they saved', async () => {
    const aisha = { ...AISHA_KHAN, version: 1 };
    const state = fresh({ members: [ME, aisha] });
    installFakeApi(state);
    signedIn();
    at('/people/m-0');
    render(<App />);
    const about = await screen.findByRole('region', { name: 'About' });
    fireEvent.click(within(about).getByRole('button', { name: 'Edit details' }));
    // Meanwhile, somebody else saves her relationship.
    Object.assign(aisha, { relationship: 'Sister', version: 2 });
    const form = within(about).getByRole('form', { name: 'Aisha’s details' });
    fireEvent.change(within(form).getByLabelText('Relationship (optional)'), {
      target: { value: 'Niece' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    const said = await within(about).findByRole('alert');
    expect(said).toHaveTextContent(
      'Someone else changed Aisha’s details while you were editing. What they saved is shown now: make your changes again, then save.',
    );
    expect(within(form).getByLabelText('Relationship (optional)')).toHaveValue('Sister');
    expect(aisha.relationship).toBe('Sister');
    await expectAccessible();

    // Made again, to the version they saved.
    fireEvent.change(within(form).getByLabelText('Relationship (optional)'), {
      target: { value: 'Niece' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(about).findByText('Details saved.')).toBeInTheDocument();
    expect(edits(state).map((e) => e.ifMatch)).toEqual(['"1"', '"2"']);
    expect(aisha.relationship).toBe('Niece');
  });

  it('after a conflict, Cancel shows what they saved, and the next save is made to their version', async () => {
    const aisha = { ...AISHA_KHAN, version: 1 };
    const state = fresh({ members: [ME, aisha] });
    installFakeApi(state);
    signedIn();
    at('/people/m-0');
    render(<App />);
    const about = await screen.findByRole('region', { name: 'About' });
    fireEvent.click(within(about).getByRole('button', { name: 'Edit details' }));
    // Meanwhile, somebody else saves her relationship.
    Object.assign(aisha, { relationship: 'Sister', version: 2 });
    const form = within(about).getByRole('form', { name: 'Aisha’s details' });
    fireEvent.change(within(form).getByLabelText('Relationship (optional)'), {
      target: { value: 'Niece' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await within(about).findByRole('alert');
    // Gone without saving: the card says what they saved.
    fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(await within(about).findByText('Sister')).toBeInTheDocument();
    expect(within(about).queryByText('Daughter')).not.toBeInTheDocument();
    // Opened again, it starts from their version, and saves first time.
    fireEvent.click(within(about).getByRole('button', { name: 'Edit details' }));
    const again = within(about).getByRole('form', { name: 'Aisha’s details' });
    expect(within(again).getByLabelText('Relationship (optional)')).toHaveValue('Sister');
    fireEvent.change(within(again).getByLabelText('Relationship (optional)'), {
      target: { value: 'Niece' },
    });
    fireEvent.click(within(again).getByRole('button', { name: 'Save' }));
    expect(await within(about).findByText('Details saved.')).toBeInTheDocument();
    expect(edits(state).map((e) => e.ifMatch)).toEqual(['"1"', '"2"']);
    expect(within(about).getByText('Niece')).toBeInTheDocument();
  });

  it('nobody is offered a sign-in for somebody recorded as passed away', async () => {
    // Bob had a sign-in, taken away; then he passed away. Gran never had one.
    const bob = {
      ...AISHA,
      id: 'm-3',
      display_name: 'Uncle Bob',
      sign_in_removed: true,
      is_deceased: true,
    };
    const gran = { ...AISHA, id: 'm-4', display_name: 'Gran', is_deceased: true };
    installFakeApi(fresh({ members: [ME, bob, gran, { ...AISHA_KHAN }] }));
    signedIn();
    at('/people/m-3');
    const { unmount } = render(<App />);
    expect(await screen.findByText('Passed away')).toBeInTheDocument();
    await screen.findByRole('region', { name: 'About' });
    expect(
      screen.queryByRole('heading', { name: 'Give Uncle Bob their sign-in back' }),
    ).not.toBeInTheDocument();
    unmount();
    // Nor named among those who could be invited.
    at('/people');
    render(<App />);
    const line = await screen.findByText(/no sign-in yet/);
    expect(line).toHaveTextContent('Aisha Khan has no sign-in yet.');
    expect(line).not.toHaveTextContent(/Gran|Uncle Bob/);
  });

  it('who is offered Edit details: an adult, themselves and anybody with no sign-in; a teen themselves; a viewer nobody', async () => {
    const me = { ...ME, relationship: 'Me' };
    const offered = async (role: 'adult' | 'teen' | 'viewer', id: string) => {
      installFakeApi(fresh({ members: [{ ...me, role }, AISHA_KHAN, TESS] }));
      signedIn(role);
      at(`/people/${id}`);
      const { unmount } = render(<App />);
      // Their line under their name: the profile has loaded.
      await waitFor(() => expect(document.querySelector('.profile-line')).not.toBeNull());
      const button = screen.queryByRole('button', { name: 'Edit details' });
      unmount();
      return button !== null;
    };
    expect(await offered('adult', 'me')).toBe(true);
    expect(await offered('adult', 'm-0')).toBe(true);
    expect(await offered('adult', 'm-1')).toBe(false);
    expect(await offered('teen', 'm-0')).toBe(false);
    expect(await offered('viewer', 'me')).toBe(false);
    expect(await offered('viewer', 'm-0')).toBe(false);
  });

  it('an owner records that somebody without a sign-in has passed away, confirming it is them', async () => {
    const grandad = { ...GRANDAD };
    const state = fresh({ members: [ME, grandad, TESS], stepUpNeeded: true });
    installFakeApi(state);
    signedIn();
    at('/people/m-2');
    const { unmount } = render(<App />);
    const about = await screen.findByRole('region', { name: 'About' });
    fireEvent.click(within(about).getByRole('button', { name: 'Edit details' }));
    fireEvent.click(within(about).getByLabelText('They have passed away'));
    fireEvent.click(within(about).getByRole('button', { name: 'Save' }));
    // Who is in the family is asked about, and a password does for it.
    const dialog = await screen.findByRole('dialog', { name: 'Just checking it is you' });
    expect(within(dialog).getByText(/to change who is in the family/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Or your password'), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(await within(about).findByText('Details saved.')).toBeInTheDocument();
    expect(grandad.is_deceased).toBe(true);
    expect(await screen.findByText('Passed away')).toBeInTheDocument();
    // No age once he has died.
    expect(within(about).getByText('9 January 1940')).toBeInTheDocument();
    unmount();

    // Somebody who can still sign in is not offered it.
    at('/people/m-1');
    render(<App />);
    const hers = await screen.findByRole('region', { name: 'About' });
    fireEvent.click(within(hers).getByRole('button', { name: 'Edit details' }));
    expect(within(hers).queryByLabelText('They have passed away')).not.toBeInTheDocument();
  });

  it("the owner's Account card asks for a passkey or a code, never the password, and shows no address", async () => {
    const state = fresh({
      members: [ME, TESS],
      accounts: { 'm-1': TESS_ACCOUNT },
      accountStepUp: true,
    });
    installFakeApi(state);
    signedIn();
    at('/people/m-1');
    render(<App />);
    const card = await screen.findByRole('region', { name: 'Account' });
    expect(within(card).queryByText(TESS_ACCOUNT.email)).not.toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'Show their account' }));

    const dialog = await screen.findByRole('dialog', { name: 'Just checking it is you' });
    expect(
      within(dialog).getByText("Please confirm it is you to manage other people's sign-ins."),
    ).toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/password/i)).not.toBeInTheDocument();
    expect(within(dialog).getByText(/Your password isn’t enough for this/)).toBeInTheDocument();
    const codeField = within(dialog).getByLabelText('Code from your authenticator app');
    expect(codeField).toHaveFocus();
    await expectAccessible();
    fireEvent.change(codeField, { target: { value: '000000' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(
      await within(dialog).findByText("That code didn't match. Try the one your app shows now."),
    ).toBeInTheDocument();
    fireEvent.change(codeField, { target: { value: '123 456' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));

    expect(await within(card).findByText(TESS_ACCOUNT.email)).toBeInTheDocument();
    expect(
      state.calls.filter((c) => c.url === '/api/v1/auth/step-up' && c.method === 'POST').at(-1)
        ?.body,
    ).toEqual({ code: '123456' });
    const facts = Object.fromEntries(
      within(card)
        .getAllByRole('term')
        .map((t) => [t.textContent, t.nextElementSibling?.textContent]),
    );
    expect(facts).toMatchObject({
      Role: 'Teen',
      'Signs in as': TESS_ACCOUNT.email,
      'Two-step sign-in': 'Off',
      Passkeys: 'None',
    });
    expect(facts['Last signed in']).toMatch(/^today, /);
    const devices = within(card).getByRole('list', { name: 'Signed in on' });
    expect(within(devices).getByText('Safari on a Mac')).toBeInTheDocument();
    expect(within(devices).getByText('The app on a Google Pixel 8a')).toBeInTheDocument();
    expect(
      within(devices).getByText(/^App · last used today, .* · Keeps Essentials for offline use$/),
    ).toBeInTheDocument();
    expect(within(devices).getByText(/^Browser · last used today, /)).toBeInTheDocument();
    // Read-only: nothing on it to press.
    expect(within(card).queryByRole('button')).not.toBeInTheDocument();
    await expectAccessible();
  });

  it('an owner without two-step sign-in is told to turn it on, with the way to', async () => {
    const state = fresh({ members: [ME, TESS], twoStep: false, accounts: { 'm-1': TESS_ACCOUNT } });
    installFakeApi(state);
    signedIn();
    at('/people/m-1');
    render(<App />);
    const card = await screen.findByRole('region', { name: 'Account' });
    expect(
      await within(card).findByText('Turn on two-step sign-in to manage other people’s sign-ins.'),
    ).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Set up two-step sign-in' })).toHaveAttribute(
      'href',
      '/settings#two-step',
    );
    expect(
      within(card).queryByRole('button', { name: 'Show their account' }),
    ).not.toBeInTheDocument();
    expect(state.calls.some((c) => c.url.endsWith('/account'))).toBe(false);
    await expectAccessible();
    // The way there: Settings, at two-step sign-in.
    fireEvent.click(within(card).getByRole('link', { name: 'Set up two-step sign-in' }));
    expect(await screen.findByRole('heading', { name: 'Two-step sign-in' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#two-step');
  });

  it('an adult sees no Account card on anybody, and an owner none on themselves or on somebody with no sign-in', async () => {
    const show = async (role: 'owner' | 'adult', id: string) => {
      const state = fresh({ members: [{ ...ME, role }, TESS, AISHA_KHAN] });
      installFakeApi(state);
      signedIn(role);
      at(`/people/${id}`);
      const { unmount } = render(<App />);
      await screen.findByRole('region', { name: 'About' });
      const shown = screen.queryByRole('region', { name: 'Account' }) !== null;
      unmount();
      return shown && !state.calls.some((c) => c.url.endsWith('/account'));
    };
    expect(await show('owner', 'm-1')).toBe(true);
    expect(await show('adult', 'm-1')).toBe(false);
    expect(await show('owner', 'me')).toBe(false);
    expect(await show('owner', 'm-0')).toBe(false);
  });
});
