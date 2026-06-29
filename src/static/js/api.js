// API, WebSockets and common utilities
import { handleStateUpdate } from './explorer.js';

export let termWs = null;
export let stateWs = null;

// Escape HTML utility
export function escapeHtml(str) {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Escape quotes utility
export function escapeQuotes(str) {
    if (!str) return '';
    return str.replace(/'/g, "\\'");
}

// Format bytes utility
export function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Toast notification system
export function showToast(message, type = 'info', duration = 3000) {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }
    
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    const textSpan = document.createElement('span');
    textSpan.textContent = message;
    toast.appendChild(textSpan);
    
    const closeBtn = document.createElement('button');
    closeBtn.className = 'toast-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.onclick = () => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    };
    toast.appendChild(closeBtn);
    
    container.appendChild(toast);
    
    setTimeout(() => {
        toast.classList.add('show');
    }, 10);
    
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => {
            toast.remove();
        }, 300);
    }, duration);
}

// Send terminal keystroke data
export function sendTerminalData(data) {
    if (termWs && termWs.readyState === WebSocket.OPEN) {
        termWs.send(data);
    }
}

// Initialize WebSockets
export function connectWebSockets(onOpenCallback, onTerminalMessage) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    
    // Terminal WebSocket
    termWs = new WebSocket(`${protocol}//${host}/ws/terminal`);
    
    termWs.onopen = () => {
        updateConnectionStatus(true);
        if (onOpenCallback) onOpenCallback();
    };
    
    termWs.onmessage = (event) => {
        if (onTerminalMessage) onTerminalMessage(event.data);
    };
    
    termWs.onclose = () => {
        updateConnectionStatus(false);
        if (onTerminalMessage) onTerminalMessage('\r\n*** SHELL DISCONNECTED ***\r\n');
        setTimeout(() => connectWebSockets(onOpenCallback, onTerminalMessage), 3000);
    };
    
    termWs.onerror = () => {
        termWs.close();
    };

    // State WebSocket
    stateWs = new WebSocket(`${protocol}//${host}/ws/state`);
    
    stateWs.onmessage = (event) => {
        try {
            const payload = JSON.parse(event.data);
            handleStateUpdate(payload);
        } catch (e) {
            console.error('Failed to parse state WS message:', e);
        }
    };
}

function updateConnectionStatus(connected) {
    const wsStatusDot = document.getElementById('ws-status-dot');
    const wsStatusText = document.getElementById('ws-status-text');
    if (!wsStatusDot || !wsStatusText) return;
    
    if (connected) {
        wsStatusDot.className = 'status-dot connected';
        wsStatusText.textContent = 'Connected';
    } else {
        wsStatusDot.className = 'status-dot';
        wsStatusText.textContent = 'Disconnected';
    }
}
