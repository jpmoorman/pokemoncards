// "Trade" tab: compare what you give with what you get.
// PLACEHOLDER — full implementation pending. Public API (used by app.js):
//   initTrade()    once at start-up; listens for 'card:action' trade-give / trade-get
//   renderTrade()  draw #view-trade
import { $, el } from './ui.js';

export function initTrade() {}

export function renderTrade() {
  $('#view-trade').replaceChildren(el('p', { class: 'muted' }, 'Trade evaluator coming soon.'));
}
