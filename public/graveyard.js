import { tombstone } from './common.js';

const list = document.getElementById('graves');
const status = document.getElementById('status');
const dig = document.getElementById('dig');
let cursor = null;

async function load() {
  dig.disabled = true;
  try {
    const url = cursor ? `/api/graveyard?cursor=${encodeURIComponent(cursor)}` : '/api/graveyard';
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { graves, nextCursor } = await res.json();

    list.append(...graves.map((g) => tombstone(g.name, g.deathAt, 'li')));
    cursor = nextCursor;
    dig.hidden = !nextCursor;

    if (list.children.length === 0) {
      status.textContent = 'No one has died yet.';
    } else {
      status.hidden = true;
    }
  } catch {
    status.hidden = false;
    status.textContent = 'The graveyard is closed right now. Try again later.';
  } finally {
    dig.disabled = false;
  }
}

dig.addEventListener('click', load);
load();
