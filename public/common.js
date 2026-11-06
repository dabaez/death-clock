// Shared by the server (name validation) and the pages (validation and
// formatting), so the two can't drift apart.

export const MAX_NAME_LENGTH = 30;

// Returns { name } or { error }.
export function cleanName(raw) {
  if (typeof raw !== 'string') return { error: 'Please enter your name.' };
  const name = raw
    // Control characters: whitespace ones (tabs, newlines) become spaces,
    // the rest are dropped.
    .replace(/\p{Cc}/gu, (c) => (/\s/u.test(c) ? ' ' : ''))
    .replace(/\s+/gu, ' ')
    .trim();
  const length = [...name].length;
  if (length === 0) return { error: 'Please enter your name.' };
  if (length > MAX_NAME_LENGTH) {
    return { error: `Your name must be ${MAX_NAME_LENGTH} characters or fewer.` };
  }
  return { name };
}

export function formatDeath(ms) {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}

// A tombstone element. Every user-supplied string goes in via textContent.
export function tombstone(name, deathAt, tag = 'div') {
  const stone = document.createElement(tag);
  stone.className = 'tombstone';
  const rip = document.createElement('p');
  rip.className = 'rip';
  rip.textContent = 'R.I.P.';
  const who = document.createElement('p');
  who.className = 'stone-name';
  who.textContent = name;
  const when = document.createElement('p');
  when.className = 'stone-date';
  when.textContent = formatDeath(deathAt);
  stone.append(rip, who, when);
  return stone;
}
