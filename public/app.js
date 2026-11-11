import { cleanName, tombstone } from './common.js';

const QUESTION_MS = 2000;

const $ = (id) => document.getElementById(id);
const screens = ['landing', 'question', 'reveal', 'dead'];

function show(screen) {
  for (const s of screens) $(`screen-${s}`).hidden = s !== screen;
}

function showState(data, secondsLeft = data.secondsLeft) {
  if (data.state === 'alive') {
    $('reveal-name').textContent = data.name;
    $('reveal-seconds').textContent = `${secondsLeft} ${secondsLeft === 1 ? 'second' : 'seconds'}`;
    show('reveal');
  } else if (data.state === 'dead') {
    $('my-stone').replaceChildren(tombstone(data.name, data.deathAt));
    // Added only now, so the page's HTML never hints at the graveyard.
    const link = document.createElement('a');
    link.href = '/graveyard';
    link.textContent = '⚰️ Visit the graveyard';
    $('yard-link').replaceChildren(link);
    show('dead');
  } else {
    show('landing');
    $('name').focus();
  }
}

async function createGrave(name) {
  let res;
  try {
    res = await fetch('/api/graves', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  } catch {
    return { error: 'Something went wrong. Try again.' };
  }
  const arrivedAt = performance.now();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { error: data.error || 'Something went wrong. Try again.' };
  return { data, arrivedAt };
}

function setNameError(message) {
  $('name-error').textContent = message || '';
  $('name-error').hidden = !message;
}

$('name').addEventListener('input', () => {
  // Only nag about length while typing; emptiness is checked on submit.
  const { error } = cleanName($('name').value);
  setNameError($('name').value.trim() && error ? error : '');
});

$('name-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const { name, error } = cleanName($('name').value);
  if (error) {
    setNameError(error);
    $('name').focus();
    return;
  }
  setNameError('');

  $('question').hidden = false;
  $('question-error').hidden = true;
  show('question');

  const [result] = await Promise.all([
    createGrave(name),
    new Promise((resolve) => setTimeout(resolve, QUESTION_MS)),
  ]);

  if (result.error) {
    $('question-error-text').textContent = result.error;
    $('question').hidden = true;
    $('question-error').hidden = false;
    return;
  }

  const { data, arrivedAt } = result;
  if (data.state === 'alive') {
    const elapsed = Math.floor((performance.now() - arrivedAt) / 1000);
    showState(data, Math.max(1, data.secondsLeft - elapsed));
  } else {
    showState(data);
  }
});

$('try-again').addEventListener('click', () => {
  show('landing');
  $('name').focus();
});

// The gender buttons look clickable and do nothing, on purpose.

async function start() {
  try {
    const res = await fetch('/api/me', { cache: 'no-store' });
    showState(await res.json());
  } catch {
    showState({ state: 'new' });
  }
}

start();
