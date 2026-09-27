import { useEffect, useState } from 'react';
import { useApp } from './app-context.js';
import { photoUrl } from './photos.js';
import { Avatar } from './ui.js';

/**
 * A person's photo for a screen (5.17c): its object URL once fetched with
 * the sign-in's token, or null — no photo, not given, or not fetched yet —
 * while their letters show.
 */
export function usePhoto(
  person: { id: string; photo?: { id: string } | null } | null | undefined,
): string | null {
  const { withToken } = useApp();
  const photoId = person?.photo?.id ?? null;
  const memberId = person?.id ?? null;
  const [got, setGot] = useState<{ id: string; url: string } | null>(null);
  useEffect(() => {
    if (!photoId || !memberId) return;
    let live = true;
    void withToken((t) => photoUrl(t, memberId, photoId))
      .then((url) => {
        if (live && url) setGot({ id: photoId, url });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [photoId, memberId, withToken]);
  return got && got.id === photoId ? got.url : null;
}

/** A person's circle, with their photo when the vault has one for the reader. */
export function PersonAvatar(props: {
  person: {
    id: string;
    display_name: string;
    colour: number;
    photo?: { id: string } | null;
  };
  initials?: string | undefined;
  size?: number;
}) {
  const photo = usePhoto(props.person);
  return (
    <Avatar
      name={props.person.display_name}
      colour={props.person.colour}
      size={props.size ?? 44}
      initials={props.initials}
      photo={photo}
    />
  );
}
