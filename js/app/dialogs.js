// @ts-check
/**
 * The modal shell shared by the distributions popup and every consent card
 * (exact-mode, volume pre-flight, wall recovery, stream consent, clear-all).
 * The cards are real dialogs to assistive tech: focus moves to the primary
 * action on open, Tab cycles inside, Escape/backdrop close, and focus
 * returns to the trigger. Card CONTENT and button behavior stay with the
 * state that owns them (main.js builds each card through confirmCard);
 * this module owns only the mechanics every card must get right.
 */

export const statsPop = document.createElement('div');
statsPop.id = 'stats-pop';
statsPop.hidden = true;
statsPop.setAttribute('role', 'dialog');
statsPop.setAttribute('aria-modal', 'true');
statsPop.tabIndex = -1;
document.body.append(statsPop);
statsPop.addEventListener('click', (e) => {
  if (e.target === statsPop) closeStatsPop();
});

export const confirmPop = document.createElement('div');
confirmPop.id = 'confirm-pop';
confirmPop.hidden = true;
confirmPop.setAttribute('role', 'dialog');
confirmPop.setAttribute('aria-modal', 'true');
confirmPop.tabIndex = -1;
document.body.append(confirmPop);
confirmPop.addEventListener('click', (e) => {
  if (e.target === confirmPop) closeConfirm();
});

/** @type {HTMLElement | null} */
let modalReturnFocus = null;

/** Name the dialog from its heading and move focus in. @param {HTMLElement} pop */
export function enterModal(pop) {
  const prev = document.activeElement;
  modalReturnFocus = prev instanceof HTMLElement ? prev : null;
  const h = pop.querySelector('h3');
  if (h && h.textContent) pop.setAttribute('aria-label', h.textContent);
  const primary = pop.querySelector('.btn.primary') ?? pop.querySelector('button');
  (primary instanceof HTMLElement ? primary : pop).focus();
}

function restoreModalFocus() {
  if (modalReturnFocus) {
    modalReturnFocus.focus();
    modalReturnFocus = null;
  }
}

/** Keep Tab cycling inside an open dialog. @param {HTMLElement} pop */
function trapTab(pop) {
  pop.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const els = /** @type {HTMLElement[]} */ (
      [...pop.querySelectorAll('button, [href], input, select, textarea')].filter(
        (el) => el instanceof HTMLElement && !el.hasAttribute('disabled'),
      )
    );
    if (els.length === 0) return;
    const first = els[0];
    const last = els[els.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      last.focus();
      e.preventDefault();
    } else if (!e.shiftKey && document.activeElement === last) {
      first.focus();
      e.preventDefault();
    }
  });
}
trapTab(statsPop);
trapTab(confirmPop);

/**
 * Dismiss hook for promise-based cards (stream consent): every path that
 * hides confirmPop must also settle that promise, or the load awaiting it
 * leaks forever. Cards that replace another card go through closeConfirm()
 * first for the same reason.
 * @type {(() => void) | null}
 */
let confirmDismiss = null;

/** @param {(() => void) | null} fn called when the card is dismissed */
export function setConfirmDismiss(fn) {
  confirmDismiss = fn;
}

/** Hide the consent card, settling any pending promise-based dismissal. */
export function closeConfirm() {
  const wasOpen = !confirmPop.hidden;
  confirmPop.hidden = true;
  if (wasOpen) restoreModalFocus();
  if (confirmDismiss) {
    const d = confirmDismiss;
    confirmDismiss = null;
    d();
  }
}

export function closeStatsPop() {
  const wasOpen = !statsPop.hidden;
  statsPop.hidden = true;
  if (wasOpen) restoreModalFocus();
}

/**
 * @typedef {Object} CardButton
 * @property {string} id
 * @property {string} label plain text (escaped nowhere — app-authored only)
 * @property {boolean} [primary]
 * @property {() => void} onClick
 */

/**
 * Build and show one consent card — the scaffolding all five cards used to
 * copy by hand: title row with a close ×, a body paragraph, a button row,
 * an optional footnote paragraph. bodyHtml/footHtml are trusted app-authored
 * strings (they interpolate formatted numbers, never remote data).
 * @param {string} title
 * @param {string} bodyHtml
 * @param {CardButton[]} buttons
 * @param {string} [footHtml]
 */
export function confirmCard(title, bodyHtml, buttons, footHtml = '') {
  closeConfirm(); // settle any dialog this card replaces
  confirmPop.innerHTML =
    `<div class="stats-card">` +
    `<div class="stats-head"><h3>${title}</h3>` +
    `<button class="stats-close" aria-label="close">×</button></div>` +
    `<p class="stats-sum">${bodyHtml}</p>` +
    `<div class="confirm-row">` +
    buttons
      .map((b) => `<button id="${b.id}" class="btn${b.primary ? ' primary' : ''}">${b.label}</button>`)
      .join('') +
    `</div>` +
    (footHtml ? `<p class="stats-sum">${footHtml}</p>` : '') +
    `</div>`;
  confirmPop.hidden = false;
  enterModal(confirmPop);
  confirmPop.querySelector('.stats-close')?.addEventListener('click', closeConfirm);
  for (const b of buttons) {
    confirmPop.querySelector(`#${b.id}`)?.addEventListener('click', b.onClick);
  }
}
