// Menu chrome that reflects the account: the chip in the top-right, the
// "Playing as" name box that replaces the name input, and the top nav.
import * as store from './state.js';
import { h, icon, clear, avatar, guestAvatar, fmtDust, toast } from './ui.js';

const chip = document.getElementById('accountChip');
const nameBox = document.getElementById('acctNameBox');
const nameText = document.getElementById('acctNameText');
const nav = document.getElementById('menuNav');

let handlers = { onChip() {}, onNameBox() {}, onNav() {} };

export function init(hs) {
    Object.assign(handlers, hs);
    chip.addEventListener('click', () => handlers.onChip());
    nameBox.addEventListener('click', () => handlers.onNameBox());
    nav.querySelectorAll('.dw-nav-btn').forEach((b) => {
        b.addEventListener('click', () => {
            if (b.getAttribute('aria-disabled') === 'true') {
                toast(b.dataset.label + ' is coming soon.');
                return;
            }
            handlers.onNav(b.dataset.pane);
        });
    });
    store.on((s, changed) => {
        if (changed.some((k) => k === 'user' || k === 'mode' || k === 'offline')) render();
    });
}

const cachedName = () => { try { return localStorage.getItem('dwAcctName') || ''; } catch (e) { return ''; } };

export function render() {
    const s = store.get();
    const u = s.user;
    clear(chip);
    if (s.mode === 'user' && (u || cachedName())) {
        const name = u ? u.username : cachedName();
        chip.classList.remove('guest');
        chip.title = 'Account settings';
        chip.setAttribute('aria-label', 'Account settings for ' + name);
        chip.append(
            avatar(name, u && u.discord && u.discord.avatarUrl, 26),
            h('span', { class: 'ac-text' },
                h('span', { class: 'ac-name', text: name }),
                h('span', { class: 'ac-sub', text: (u && u.rank && u.rank.name) || 'Unranked' })),
            h('span', { class: 'ac-dust', title: 'Gemdust' }, icon('dust'), h('span', { text: u ? fmtDust(u.dust) : '–' })));
        nameText.textContent = name;
    } else {
        chip.classList.add('guest');
        chip.title = s.offline ? 'Accounts are offline right now' : 'Create an account';
        chip.setAttribute('aria-label', s.offline ? 'Playing as guest. Accounts are offline.' : 'Playing as guest. Create an account.');
        chip.append(
            guestAvatar(26),
            h('span', { class: 'ac-text' },
                h('span', { class: 'ac-name', text: 'Guest' }),
                s.offline
                    ? h('span', { class: 'ac-sub', text: 'Accounts offline' })
                    : h('span', { class: 'ac-sub ac-link', text: 'Create account' })));
        nameText.textContent = '';
    }
}
