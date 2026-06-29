// Terminal lifecycle, xterm.js integration, keypad interface
import { sendTerminalData } from './api.js';

export let term = null;
export let fitAddon = null;
export let ctrlActive = false;

const ctrlBtn = document.querySelector('[data-key="Ctrl"]');
const terminalContainer = document.getElementById('terminal-container');

export const lightTerminalTheme = {
    background: '#ffffff',
    foreground: '#000000',
    cursor: '#000000',
    black: '#000000',
    red: '#ff3b30',
    green: '#34c759',
    yellow: '#ffcc00',
    blue: '#007aff',
    magenta: '#af52de',
    cyan: '#55bef0',
    white: '#ffffff'
};

export const darkTerminalTheme = {
    background: '#000000',
    foreground: '#ffffff',
    cursor: '#ffffff',
    black: '#000000',
    red: '#ff453a',
    green: '#30d158',
    yellow: '#ffd60a',
    blue: '#0a84ff',
    magenta: '#bf5af2',
    cyan: '#5ac8fa',
    white: '#ffffff'
};

export function initTerminal() {
    if (!terminalContainer) return;
    const isLightTheme = document.body.classList.contains('light-theme');
    
    term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: 'SFMono-Regular, Consolas, Courier, monospace',
        theme: isLightTheme ? lightTerminalTheme : darkTerminalTheme,
        convertEol: true
    });

    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    
    term.open(terminalContainer);
    fitAddon.fit();
    terminalContainer.addEventListener('paste', handleTerminalPaste, true);

    // Monitor resize
    window.addEventListener('resize', () => {
        if (document.getElementById('terminal-tab').classList.contains('active')) {
            fitAddon.fit();
        }
    });

    // Handle terminal keystroke input
    term.onData(data => {
        if (ctrlActive) {
            const charCode = data.charCodeAt(0);
            let ctrlCode = data;
            if (charCode >= 97 && charCode <= 122) { // a-z
                ctrlCode = String.fromCharCode(charCode - 96);
            } else if (charCode >= 65 && charCode <= 90) { // A-Z
                ctrlCode = String.fromCharCode(charCode - 64);
            }
            sendTerminalData(ctrlCode);
            toggleCtrl(false);
        } else {
            sendTerminalData(data);
        }
    });
}

function handleTerminalPaste(e) {
    const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    if (!text) return;

    e.preventDefault();
    e.stopPropagation();
    pasteTextToTerminal(text);
}

export async function pasteClipboardToTerminal(lastCopiedText) {
    try {
        if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
            pasteTextToTerminal(lastCopiedText);
            return;
        }

        const text = await navigator.clipboard.readText();
        pasteTextToTerminal(text || lastCopiedText);
    } catch (e) {
        console.error('Unable to read clipboard for terminal paste:', e);
        pasteTextToTerminal(lastCopiedText);
    }
}

export function pasteTextToTerminal(text) {
    if (!text) return;
    term.focus();
    sendTerminalData(text);
}

export function toggleCtrl(active) {
    ctrlActive = active;
    if (!ctrlBtn) return;
    if (ctrlActive) {
        ctrlBtn.style.backgroundColor = '#ffffff';
        ctrlBtn.style.color = '#000000';
    } else {
        ctrlBtn.style.backgroundColor = '';
        ctrlBtn.style.color = '';
    }
}

export function initKeypad(getLastCopiedText) {
    const keys = document.querySelectorAll('.keypad-btn');
    keys.forEach(btn => {
        btn.addEventListener('click', () => {
            const action = btn.getAttribute('data-key');
            
            if (action === 'Ctrl') {
                toggleCtrl(!ctrlActive);
            } else if (action === 'Esc') {
                sendTerminalData('\x1b');
            } else if (action === 'Tab') {
                sendTerminalData('\t');
            } else if (action === 'ArrowUp') {
                sendTerminalData('\x1b[A');
            } else if (action === 'ArrowDown') {
                sendTerminalData('\x1b[B');
            } else if (action === 'ArrowLeft') {
                sendTerminalData('\x1b[D');
            } else if (action === 'ArrowRight') {
                sendTerminalData('\x1b[C');
            } else if (action === 'Paste') {
                pasteClipboardToTerminal(getLastCopiedText());
            } else if (action === 'Clear') {
                term.clear();
            }
            if (action !== 'Paste') {
                term.focus();
            }
        });
    });
}
