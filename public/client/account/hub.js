// The hub panel (#dwHub): one panel under the top nav whose panes are the
// account features. Phase 1 registers only the Account pane; the nav's other
// entries stay disabled until their panes exist.
import { h, clear, pushLayer, popLayer } from './ui.js';

const hub = document.getElementById('dwHub');
const overlay = document.getElementById('dwHubOverlay');
const titleEl = document.getElementById('dwHubTitle');
const body = document.getElementById('dwHubBody');
const nav = document.getElementById('menuNav');
const chip = document.getElementById('accountChip');

const panes = {};   // name -> { title, render(el, opts), el }
let current = null;

export function register(name, def) {
    def.el = h('section', { class: 'hub-pane', 'data-pane': name });
    body.appendChild(def.el);
    panes[name] = def;
}

export const has = (name) => !!panes[name];
export const isOpen = () => !!current;
export const currentPane = () => current;

export function open(name, opts) {
    const def = panes[name];
    if (!def) return;
    for (const k in panes) panes[k].el.classList.toggle('active', k === name);
    titleEl.textContent = def.title;
    current = name;
    clear(def.el);
    def.render(def.el, opts || {});
    body.scrollTop = 0;
    hub.classList.add('open');
    hub.setAttribute('aria-hidden', 'false');
    overlay.classList.add('visible');
    markActive(name);
    pushLayer(hub, { onEsc: close, allow: [nav, chip], focus: opts && opts.focus });
}

// Re-render the open pane in place (after the user object changed).
export function refresh(name) {
    if (!current || (name && name !== current)) return;
    const def = panes[current];
    const y = body.scrollTop;
    clear(def.el);
    def.render(def.el, {});
    body.scrollTop = y;
}

export function close() {
    if (!current) return;
    const def = panes[current];
    current = null;
    hub.classList.remove('open');
    hub.setAttribute('aria-hidden', 'true');
    overlay.classList.remove('visible');
    markActive(null);
    popLayer(hub);
    if (def && def.onClose) def.onClose();
}

function markActive(name) {
    nav.querySelectorAll('.dw-nav-btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.pane === (name || 'play'));
    });
    chip.classList.toggle('active', name === 'account');
}

overlay.addEventListener('click', close);
document.getElementById('dwHubClose').addEventListener('click', close);
