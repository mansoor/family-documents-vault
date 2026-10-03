import { shareEndWords, whenWords, zonedParts, zonedTime, type MemberAccount } from '@fdv/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { clearPhotos, photosHeld } from './photos.js';
import { requestState } from './screens/Sharing.js';
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

  it("the Identity card takes the place of the owners' note about ID numbers (5.27)", async () => {
    // Until identity records (A69), owners were told ID numbers lived in
    // documents; now each person's are on their profile, where the reader
    // is given them, and the note is gone for everybody.
    for (const role of ['owner', 'adult', 'teen', 'viewer'] as const) {
      const state = fresh({
        members: [{ ...ME, role }, AISHA_KHAN],
        identities: { 'm-0': { shared: { fields: { given_name: 'Aisha' }, version: 1 } } },
      });
      installFakeApi(state);
      signedIn(role);
      at('/people/m-0');
      const r = render(<App />);
      await screen.findByRole('heading', { name: 'Aisha Khan' });
      if (role === 'owner') {
        expect(await screen.findByRole('region', { name: 'Identity details' })).toBeInTheDocument();
      } else {
        // Not given Aisha's record (the narrowest audience): no card at all.
        await waitFor(() =>
          expect(state.calls.some((c) => c.url === '/api/v1/members/m-0/identity')).toBe(true),
        );
        expect(screen.queryByRole('region', { name: 'Identity details' })).not.toBeInTheDocument();
      }
      expect(screen.queryByText(/SSN and other ID numbers/), role).not.toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'ID numbers' })).not.toBeInTheDocument();
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
    await waitFor(() => expect(within(form).getByLabelText('Name')).toHaveFocus());
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
    await waitFor(() =>
      expect(within(about).getByRole('button', { name: 'Edit details' })).toHaveFocus(),
    );

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
    // The dialog moves focus once it has opened, a moment after it is in the page.
    await waitFor(() => expect(codeField).toHaveFocus());
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
    // Nothing on it to press but Lock sign-in (5.28).
    expect(
      within(card)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Lock sign-in']);
    await expectAccessible();
  });

  it('the Account card says who is told of each look: a viewer reads no log, so is not said to be', async () => {
    const vee = { ...TESS, id: 'm-5', display_name: 'Vee', role: 'viewer' };
    const said = async (id: string) => {
      installFakeApi(fresh({ members: [ME, TESS, vee] }));
      signedIn();
      at(`/people/${id}`);
      const { unmount } = render(<App />);
      const card = await screen.findByRole('region', { name: 'Account' });
      const text = (await within(card).findByText(/Each look is noted/)).textContent;
      unmount();
      return text;
    };
    expect(await said('m-5')).toMatch(/Each look is noted in the activity log, for the owners\.$/);
    expect(await said('m-1')).toMatch(
      /Each look is noted in the activity log, for the owners and Tess\.$/,
    );
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

describe('locking a sign-in (5.28)', () => {
  /** Tess, a teen with a sign-in; Sam, another owner. */
  const TESS = { ...AISHA, id: 'm-1', display_name: 'Tess', has_account: true, role: 'teen' };
  const SAM = { ...AISHA, id: 'm-3', display_name: 'Sam Seikh', has_account: true, role: 'owner' };
  /** Tess's card, as the vault gives it since 5.28: phones keep offline copies 30 days here. */
  const card = (over: Partial<MemberAccount> = {}): MemberAccount => ({
    member_id: 'm-1',
    role: 'teen',
    email: 'tess@example.test',
    two_step: false,
    passkeys: 0,
    last_signed_in_at: new Date().toISOString(),
    devices: [
      {
        label: 'Safari on a Mac',
        client: 'browser',
        last_used_at: new Date().toISOString(),
        offline: false,
      },
    ],
    suspension: null,
    max_offline_days: 30,
    ...over,
  });
  const since = new Date(Date.now() - 2 * 3600e3).toISOString();

  /** The owner opens somebody's Account card, already confirmed it is them. */
  async function showCard(over: Parameters<typeof fresh>[0] = {}, id = 'm-1') {
    const state = fresh({ members: [ME, TESS, SAM], ...over });
    installFakeApi(state);
    signedIn();
    at(`/people/${id}`);
    render(<App />);
    const region = await screen.findByRole('region', { name: 'Account' });
    fireEvent.click(within(region).getByRole('button', { name: 'Show their account' }));
    await within(region).findByText('Signs in as');
    return { state, region };
  }

  /** Lock sign-in, pressed as a browser presses it: focused, then clicked. */
  async function openLock(region: HTMLElement, name = 'Tess') {
    const open = within(region).getByRole('button', { name: 'Lock sign-in' });
    open.focus();
    fireEvent.click(open);
    const dialog = await screen.findByRole('dialog', { name: `Lock ${name}’s sign-in` });
    return { open, dialog };
  }

  /** The card's facts, by name. */
  const factsOf = (region: HTMLElement) =>
    Object.fromEntries(
      within(region)
        .getAllByRole('term')
        .map((t) => [t.textContent, t.nextElementSibling?.textContent]),
    );

  /** "Confirm it is you", answered with a code: never a password, for a sign-in. */
  async function confirmWithCode() {
    const ask = await screen.findByRole('dialog', { name: 'Just checking it is you' });
    expect(within(ask).queryByLabelText(/password/i)).not.toBeInTheDocument();
    fireEvent.change(within(ask).getByLabelText('Code from your authenticator app'), {
      target: { value: '123456' },
    });
    fireEvent.click(within(ask).getByRole('button', { name: 'Confirm' }));
  }

  it("the lock dialog says what a lock does, phones' offline days from the card, and Escape does nothing", async () => {
    const { state, region } = await showCard({ accounts: { 'm-1': card() } });
    expect(
      within(region).getByRole('button', { name: 'Lock sign-in' }),
    ).toHaveAccessibleDescription(
      'Locking signs Tess out everywhere at once, and keeps them out until it is unlocked.',
    );
    const { open, dialog } = await openLock(region);
    // Read from its top: the heading has focus, not the first field.
    await waitFor(() =>
      expect(within(dialog).getByRole('heading', { name: 'Lock Tess’s sign-in' })).toHaveFocus(),
    );
    const effects = () =>
      within(within(dialog).getByRole('list', { name: 'What locking does' }))
        .getAllByRole('listitem')
        .map((li) => li.textContent);
    expect(effects()).toEqual([
      'Tess can’t sign in until an owner unlocks it.',
      'Every device Tess is signed in on is signed out now.',
      'A phone that never reconnects keeps its offline copies up to 30 days.',
      'Any links and requests to send documents Tess made pause, and work again when the lock ends.',
      'Any invitations Tess sent are cancelled, and any exports they made stop working.',
      'Files sent for Tess alone to look at go to the owners.',
      'Tess is emailed to say so, and the other owners are told.',
    ]);
    expect(within(dialog).getByLabelText('A note for the other owners (optional)')).toHaveAttribute(
      'maxlength',
      '500',
    );
    await expectAccessible();

    // Each line follows the choices under it.
    fireEvent.click(within(dialog).getByLabelText('End their links and requests for good'));
    expect(effects()[3]).toBe('Any links and requests to send documents Tess made end for good.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Until a date' }));
    expect(within(dialog).getByRole('button', { name: 'Until a date' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(effects()[0]).toMatch(
      /^Tess can’t sign in until \w+day \d+ \w+ at \d\d:00( \(UTC time\))?, unless an owner unlocks it sooner\.$/,
    );
    await expectAccessible();

    // Escape: nothing locked, and back on the button that opened it.
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(open).toHaveFocus());
    expect(state.calls.some((c) => c.url.endsWith('/lock'))).toBe(false);
  });

  it('with no other owner, nobody else is said to be told', async () => {
    const { region } = await showCard({ members: [ME, TESS], accounts: { 'm-1': card() } });
    const { dialog } = await openLock(region);
    expect(within(dialog).getByText('Tess is emailed to say so.')).toBeInTheDocument();
    expect(within(dialog).queryByText(/other owners/)).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText('A note (optional)')).toBeInTheDocument();
  });

  it('locking sends the end, the links and the note chosen, after a passkey or a code, and the card says it is locked', async () => {
    const { state, region } = await showCard({
      accounts: { 'm-1': card() },
      timezone: 'Asia/Tokyo',
    });
    // Five minutes on: the next power over a sign-in asks again.
    state.accountStepUp = true;
    const { dialog } = await openLock(region);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Until a date' }));
    // On the household's clock, Tokyo's, whatever this browser's.
    const day = zonedParts(new Date(Date.now() + 3 * 864e5), 'Asia/Tokyo').date;
    fireEvent.change(within(dialog).getByLabelText('Date'), { target: { value: day } });
    fireEvent.change(within(dialog).getByLabelText('Time'), { target: { value: '07:00' } });
    const until = zonedTime(day, '07:00', 'Asia/Tokyo') as Date;
    const words = shareEndWords(until, 'Asia/Tokyo');
    expect(
      within(dialog).getByText(
        new RegExp(`^Unlocks by itself on ${words}( \\(Asia/Tokyo time\\))?\\.$`),
      ),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByLabelText('End their links and requests for good'));
    fireEvent.change(within(dialog).getByLabelText('A note for the other owners (optional)'), {
      target: { value: '  Lost her phone at school.  ' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lock sign-in' }));
    await confirmWithCode();

    const said = await within(region).findByText('Tess’s sign-in is locked.');
    await waitFor(() => expect(said).toHaveFocus());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // Asked, refused until it was confirmed, then made: the same each time.
    const sent = {
      until: until.toISOString(),
      end_links: true,
      note: 'Lost her phone at school.',
    };
    expect(
      state.calls
        .filter((c) => c.method === 'POST' && c.url === '/api/v1/members/m-1/lock')
        .map((c) => c.body),
    ).toEqual([sent, sent]);
    // Locked until then, since now, by whom, and the note; signed out everywhere.
    expect(
      within(region).getByText(
        new RegExp(
          `^Tess’s sign-in is locked until ${words}( \\(Asia/Tokyo time\\))?, unless an owner unlocks it sooner\\.$`,
        ),
      ),
    ).toBeInTheDocument();
    const facts = factsOf(region);
    expect(facts.Locked).toMatch(/^today, \d+:\d\d[ap]m, by Mansoor Seikh$/);
    expect(facts.Note).toBe('Lost her phone at school.');
    expect(within(region).getByText('No device at the moment.')).toBeInTheDocument();
    expect(within(region).queryByRole('button', { name: 'Lock sign-in' })).not.toBeInTheDocument();
    expect(within(region).getByRole('button', { name: 'Unlock' })).toBeInTheDocument();
    await expectAccessible();
  });

  it('an end that has gone by, or is more than a year away, is said, and nothing is sent', async () => {
    const { state, region } = await showCard({ accounts: { 'm-1': card() } });
    const { dialog } = await openLock(region);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Until a date' }));
    const lock = within(dialog).getByRole('button', { name: 'Lock sign-in' });
    expect(lock).toHaveAttribute('aria-disabled', 'false');
    const date = within(dialog).getByLabelText('Date');
    fireEvent.change(date, {
      target: { value: zonedParts(new Date(Date.now() - 864e5), 'UTC').date },
    });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Choose a time in the future to unlock.',
    );
    expect(lock).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(lock);
    fireEvent.change(date, {
      target: { value: zonedParts(new Date(Date.now() + 400 * 864e5), 'UTC').date },
    });
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'A lock can end by itself within a year at most. Choose “Until I unlock it” to keep it longer.',
    );
    fireEvent.click(lock);
    // Until I unlock it: nothing to put right.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Until I unlock it' }));
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
    expect(lock).toHaveAttribute('aria-disabled', 'false');
    expect(state.calls.some((c) => c.url.endsWith('/lock'))).toBe(false);
  });

  it('a locked sign-in says since when, until when, by whom and the note; Unlock asks, and the card is read again', async () => {
    const { state, region } = await showCard({
      accounts: {
        'm-1': card({
          devices: [],
          suspension: {
            reason: 'locked',
            since,
            until: null,
            note: 'Lost her phone.\nAsk Sam before unlocking.',
            by: 'Sam Seikh',
          },
        }),
      },
    });
    const line = within(region).getByText('Tess’s sign-in is locked until an owner unlocks it.');
    // The first thing heard once the card opens.
    await waitFor(() => expect(line).toHaveFocus());
    const facts = factsOf(region);
    expect(facts.Locked).toBe(`${whenWords(since)}, by Sam Seikh`);
    expect(facts.Note).toBe('Lost her phone.\nAsk Sam before unlocking.');
    expect(within(region).queryByRole('button', { name: 'Lock sign-in' })).not.toBeInTheDocument();
    await expectAccessible();

    state.accountStepUp = true;
    const reads = state.calls.filter((c) => c.url === '/api/v1/members/m-1/account').length;
    fireEvent.click(within(region).getByRole('button', { name: 'Unlock' }));
    await confirmWithCode();
    const said = await within(region).findByText('Tess can sign in again.');
    await waitFor(() => expect(said).toHaveFocus());
    expect(
      state.calls.filter((c) => c.method === 'DELETE' && c.url === '/api/v1/members/m-1/lock'),
    ).toHaveLength(2);
    // Read again, as the vault has it now.
    expect(state.calls.filter((c) => c.url === '/api/v1/members/m-1/account')).toHaveLength(
      reads + 1,
    );
    expect(within(region).queryByText(/is locked/)).not.toBeInTheDocument();
    expect(within(region).queryByRole('button', { name: 'Unlock' })).not.toBeInTheDocument();
    expect(within(region).getByRole('button', { name: 'Lock sign-in' })).toBeInTheDocument();
    await expectAccessible();
  });

  it('a lock that ends by itself says when, on the household’s clock', async () => {
    const until = new Date(Date.now() + 5 * 864e5).toISOString();
    const { region } = await showCard({
      timezone: 'Asia/Tokyo',
      accounts: {
        'm-1': card({
          suspension: { reason: 'locked', since, until, note: null, by: 'Sam Seikh' },
        }),
      },
    });
    const words = shareEndWords(new Date(until), 'Asia/Tokyo');
    expect(
      await within(region).findByText(
        new RegExp(
          `^Tess’s sign-in is locked until ${words}( \\(Asia/Tokyo time\\))?, unless an owner unlocks it sooner\\.$`,
        ),
      ),
    ).toBeInTheDocument();
    // No note, no line for one.
    expect(factsOf(region)).not.toHaveProperty('Note');
  });

  it('a sign-in paused after a restore offers Turn back on, with their role to check', async () => {
    const { state, region } = await showCard({
      accounts: {
        'm-1': card({
          devices: [],
          suspension: { reason: 'restored', since, until: null, note: null, by: null },
        }),
      },
    });
    expect(
      within(region).getByText(
        'Tess’s sign-in is paused after the restore, until an owner turns it back on.',
      ),
    ).toBeInTheDocument();
    expect(
      within(region).getByText(/Their role is as the backup had it, Teen: check it is still right/),
    ).toBeInTheDocument();
    expect(factsOf(region).Paused).toBe(whenWords(since));
    expect(within(region).queryByRole('button', { name: 'Unlock' })).not.toBeInTheDocument();
    expect(within(region).queryByRole('button', { name: 'Lock sign-in' })).not.toBeInTheDocument();
    await expectAccessible();

    state.accountStepUp = true;
    fireEvent.click(within(region).getByRole('button', { name: 'Turn back on' }));
    await confirmWithCode();
    const said = await within(region).findByText('Tess can sign in again.');
    await waitFor(() => expect(said).toHaveFocus());
    expect(
      state.calls.filter((c) => c.method === 'POST' && c.url === '/api/v1/members/m-1/resume'),
    ).toHaveLength(2);
    expect(state.calls.some((c) => c.url.endsWith('/lock'))).toBe(false);
    expect(within(region).queryByText(/paused after the restore/)).not.toBeInTheDocument();
  });

  it('a refusal is said: in the dialog, which stays open, or on the card', async () => {
    // Sam is an owner: one owner's sign-in is never locked by another.
    const sam = card({ member_id: 'm-3', role: 'owner', email: 'sam@example.test' });
    const first = await showCard({ accounts: { 'm-3': sam } }, 'm-3');
    const { dialog } = await openLock(first.region, 'Sam');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lock sign-in' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      "Sam Seikh is an owner, and one owner's sign-in is never locked by another. Ask for their role to be changed first — that takes seven days, and they are told about it.",
    );
    expect(screen.getByRole('dialog', { name: 'Lock Sam’s sign-in' })).toBeInTheDocument();
    // Nothing chosen: no end, no note, their links paused.
    expect(
      first.state.calls.find((c) => c.method === 'POST' && c.url.endsWith('/m-3/lock'))?.body,
    ).toEqual({});
    cleanup();

    // Unlocked meanwhile, by another owner.
    const tess = card({
      suspension: { reason: 'locked', since, until: null, note: null, by: 'Sam Seikh' },
    });
    const { region } = await showCard({ accounts: { 'm-1': tess } });
    tess.suspension = null;
    fireEvent.click(within(region).getByRole('button', { name: 'Unlock' }));
    expect(await within(region).findByRole('alert')).toHaveTextContent(
      "Tess's sign-in is not locked.",
    );
  });

  it('a vault from before 5.28 is offered no lock', async () => {
    const { region } = await showCard({ memberAdmin: false, accounts: { 'm-1': card() } });
    expect(within(region).queryByRole('button', { name: 'Lock sign-in' })).not.toBeInTheDocument();
    expect(within(region).queryByText(/Locking signs/)).not.toBeInTheDocument();
  });

  describe('Settings → After a restore: the sign-ins waiting', () => {
    const VIC = { ...AISHA, id: 'm-4', display_name: 'Vic', has_account: true, role: 'viewer' };
    const paused = (id: string, role: MemberAccount['role']) =>
      card({
        member_id: id,
        role,
        devices: [],
        suspension: { reason: 'restored', since, until: null, note: null, by: null },
      });

    it('lists each with its role, and an owner turns each back on, one tap each, after a code', async () => {
      const state = fresh({
        members: [ME, TESS, SAM, VIC],
        accounts: { 'm-1': paused('m-1', 'teen'), 'm-4': paused('m-4', 'viewer') },
      });
      installFakeApi(state);
      signedIn();
      at('/settings');
      render(<App />);
      fireEvent.click(
        await screen.findByRole('link', {
          name: /After a restore.*2 sign-ins are paused until you turn them back on/,
        }),
      );
      const list = await screen.findByRole('list', { name: 'Paused sign-ins' });
      const rows = () =>
        within(list)
          .getAllByRole('listitem')
          .map((li) => li.textContent);
      // Each with the role the backup had, to check before it is turned on.
      expect(rows()).toEqual(['TessRole: TeenTurn back on', 'VicRole: ViewerTurn back on']);
      expect(screen.getByText(/Each role is as the backup had it/)).toBeInTheDocument();
      await expectAccessible();

      // Asked to confirm it is them with a passkey or a code, as for an unlock.
      state.accountStepUp = true;
      fireEvent.click(within(list).getByRole('button', { name: 'Turn back on Tess’s sign-in' }));
      await confirmWithCode();
      const said = await screen.findByText('Tess can sign in again.');
      await waitFor(() => expect(said).toHaveFocus());
      expect(
        state.calls.filter((c) => c.method === 'POST' && c.url === '/api/v1/members/m-1/resume'),
      ).toHaveLength(2);
      // One tap: Tess's row goes, Vic's waits.
      await waitFor(() => expect(rows()).toEqual(['VicRole: ViewerTurn back on']));
      expect(state.calls.some((c) => c.url === '/api/v1/members/m-4/resume')).toBe(false);
      await expectAccessible();
    });

    it('nobody but an owner is shown one', async () => {
      installFakeApi(
        fresh({ members: [ME, TESS, VIC], accounts: { 'm-1': paused('m-1', 'teen') } }),
      );
      signedIn('adult');
      at('/settings/after-restore');
      render(<App />);
      await screen.findByRole('heading', { name: /paused links/i });
      expect(screen.queryByRole('list', { name: 'Paused sign-ins' })).not.toBeInTheDocument();
      expect(screen.queryByText('Tess')).not.toBeInTheDocument();
    });
  });

  it('a request paused by its requester’s lock says so, and no owner is offered to turn it on', () => {
    const request = {
      state: 'paused',
      paused_reason: 'locked',
      requested_by_name: 'Sara',
      expires_at: new Date(Date.now() + 864e5).toISOString(),
    } as unknown as Parameters<typeof requestState>[0];
    expect(requestState(request, true)).toEqual({
      words: 'Paused while the sign-in of Sara is locked. It works again once they are unlocked.',
      tone: 'warn',
    });
    // A restore's pause is still an owner's to turn back on.
    expect(requestState({ ...request, paused_reason: 'restored' }, true).words).toBe(
      'Paused after a restore',
    );
  });
});
