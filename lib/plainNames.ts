/**
 * Keeps the office's own ids out of what an agent writes. An agent has to be
 * given ids, because it names a room, a person or a system by id when it asks
 * for something. Now and then one turns up in its prose as well, where it
 * means nothing to a reader. Before the text is kept, each id is replaced by
 * the name people know the thing by.
 */

/** Something with an id and the name it goes by. */
export type Named = readonly [id: string, name: string];

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Only what cannot be mistaken for a word is treated as an id: it has a digit, a hyphen or an underscore in it. */
const looksLikeAnId = (id: string): boolean => id.length >= 4 && /[\d_-]/.test(id);

export function plainNames(text: string, known: readonly Named[]): string {
  let out = text;
  const ids = known.filter(([id, name]) => looksLikeAnId(id) && name.trim().length > 0 && out.includes(id));
  // Longest first, so that an id which begins like another is not cut short.
  for (const [id, name] of [...ids].sort((a, b) => b[0].length - a[0].length)) {
    const token = `(?<![A-Za-z0-9_-])["'\`]?${escape(id)}["'\`]?(?![A-Za-z0-9_-])`;
    const named = escape(name);
    // "Fulfilment (room-67e7)" and "Fulfilment, in room-67e7": the name is already there.
    out = out.replace(new RegExp(`(${named}[^.;:()]{0,24}?)\\s*\\(\\s*(?:(?:the|in|room|id)\\s+)*${token}\\s*\\)`, "gi"), "$1");
    out = out.replace(new RegExp(`(${named}[^.;:()]{0,24}?),?\\s+(?:in|at|from)\\s+(?:(?:the|room)\\s+)*${token}`, "gi"), "$1");
    out = out.replace(new RegExp(`\\(\\s*(?:(?:the|in|room|id)\\s+)*${token}\\s*\\)`, "g"), `(${name})`);
    out = out.replace(new RegExp(`(?:\\bthe\\s+)?(?:\\broom\\s+)?${token}`, "g"), name);
  }
  return out;
}
