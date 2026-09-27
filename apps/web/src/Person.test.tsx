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

  it('only owners see the ID-numbers note', async () => {
    installFakeApi(fresh({ members: [ME, AISHA_KHAN] }));
    signedIn();
    at('/people/m-0');
    const { unmount } = render(<App />);
    expect(await screen.findByText(ID_NUMBERS_NOTE)).toBeInTheDocument();
    expect(ID_NUMBERS_NOTE).toBe(
      "SSN and other ID numbers get their own sealed place here in a later release. Until then they are kept in 'Social security / national ID' documents, which are Adults only by default: owners and adults can open them, teens and viewers can't. Whoever a document belongs to can make it Only me, and in Kinds of document an owner can make Only me the default for new ones (one filed for somebody else still starts as Adults only).",
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
    expect(screen.queryByRole('button', { name: 'Remove photo' })).not.toBeInTheDocument();
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
    expect(
      await screen.findByRole('alertdialog', { name: 'Remove your photo?' }),
    ).toHaveTextContent('Your initials will show instead.');
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
