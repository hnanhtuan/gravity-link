// Gravity Link Mobile Application entry point
import { connectWebSockets } from './js/api.js';
import { initTerminal, initKeypad, term, fitAddon, lightTerminalTheme, darkTerminalTheme } from './js/terminal.js';
import { initWorkspaceSelector, initFileExplorer, initEditor } from './js/explorer.js';
import { initConversationTab, initArtifactViewer, configureMarkdownRenderer, initMarkdownCodeCopy, getLastCopiedText } from './js/chat.js';

// DOM Elements for global Chrome shell
const appChromeToggle = document.getElementById('app-chrome-toggle');
const topBanner = document.getElementById('top-banner');
const projectLinkPanel = document.getElementById('project-link-panel');
const tabButtons = document.querySelectorAll('.tab-btn');
const tabViews = document.querySelectorAll('.tab-view');
const transcriptChatDisplay = document.getElementById('transcript-chat-display');

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    initChromeCollapse();
    initTabs();
    initTerminal();
    
    // Connect WebSockets and bind events
    connectWebSockets(
        // onOpen callback
        () => {
            if (term) {
                term.write('\r\n*** CONNECTED TO WORKSPACE SHELL ***\r\n');
            }
            if (fitAddon) {
                fitAddon.fit();
            }
        },
        // onTerminalMessage callback
        (data) => {
            if (term) term.write(data);
        }
    );
    
    initWorkspaceSelector();
    initFileExplorer();
    initKeypad(getLastCopiedText);
    initEditor();
    
    // Initialize Chat and Markdown components
    configureMarkdownRenderer();
    initConversationTab();
    initArtifactViewer();
    initMarkdownCodeCopy();
});

// Tab Navigation
function initTabs() {
    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.getAttribute('data-target');
            
            tabButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            tabViews.forEach(v => v.classList.remove('active'));
            const activeView = document.getElementById(target);
            if (activeView) activeView.classList.add('active');
            
            if (target === 'terminal-tab' && fitAddon) {
                setTimeout(() => {
                    fitAddon.fit();
                }, 50);
            }
            
            if (target === 'conversation-tab' && transcriptChatDisplay) {
                setTimeout(() => {
                    transcriptChatDisplay.scrollTop = transcriptChatDisplay.scrollHeight;
                }, 50);
            }
        });
    });
}

// Collapsible Top Banner Preference (Chrome Collapse)
function initChromeCollapse() {
    if (!appChromeToggle || !topBanner || !projectLinkPanel) return;

    const savedState = getStoredCollapseState('topControls');
    const phoneFirstDefault = window.matchMedia && window.matchMedia('(max-width: 700px)').matches;
    const shouldCollapse = savedState ? savedState === 'collapsed' : phoneFirstDefault;

    setChromeCollapsed(shouldCollapse, false);

    appChromeToggle.addEventListener('click', () => {
        setChromeCollapsed(!document.body.classList.contains('chrome-collapsed'), true);
    });
}

function setChromeCollapsed(collapsed, persist) {
    document.body.classList.toggle('chrome-collapsed', collapsed);
    if (topBanner) topBanner.hidden = collapsed;
    if (projectLinkPanel) projectLinkPanel.hidden = collapsed;
    if (appChromeToggle) {
        appChromeToggle.textContent = collapsed ? '▼' : '▲';
        appChromeToggle.setAttribute('aria-expanded', String(!collapsed));
        appChromeToggle.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} top controls`);
    }

    if (persist) {
        try {
            localStorage.setItem('collapse:topControls', collapsed ? 'collapsed' : 'expanded');
        } catch (e) {
            console.warn('Unable to save chrome collapse preference:', e);
        }
    }

    if (fitAddon && document.getElementById('terminal-tab').classList.contains('active')) {
        setTimeout(() => {
            fitAddon.fit();
        }, 50);
    }
}

function getStoredCollapseState(key) {
    try {
        return localStorage.getItem(`collapse:${key}`);
    } catch (e) {
        console.warn('Unable to read chrome collapse preference:', e);
        return null;
    }
}

// Global Theme Management
function initTheme() {
    const themeToggleBtn = document.getElementById('theme-toggle-btn');
    if (!themeToggleBtn) return;
    
    const savedTheme = localStorage.getItem('theme');
    const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    const isLight = savedTheme === 'light' || (!savedTheme && prefersLight);
    
    if (isLight) {
        document.body.classList.add('light-theme');
        themeToggleBtn.textContent = 'Dark Mode';
        updateHljsTheme(true);
    } else {
        document.body.classList.remove('light-theme');
        themeToggleBtn.textContent = 'Light Mode';
        updateHljsTheme(false);
    }
    
    themeToggleBtn.addEventListener('click', () => {
        const currentlyLight = document.body.classList.toggle('light-theme');
        localStorage.setItem('theme', currentlyLight ? 'light' : 'dark');
        themeToggleBtn.textContent = currentlyLight ? 'Dark Mode' : 'Light Mode';
        
        updateHljsTheme(currentlyLight);
        
        if (term) {
            term.options.theme = currentlyLight ? lightTerminalTheme : darkTerminalTheme;
        }
    });
}

function updateHljsTheme(isLight) {
    const hljsThemeLink = document.getElementById('hljs-theme-stylesheet');
    if (hljsThemeLink) {
        hljsThemeLink.href = isLight
            ? 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css'
            : 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css';
    }
}
