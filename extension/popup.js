const SERVER_URL = 'http://localhost:9223';

let connectedTabIds = new Set();
let currentTabs = [];

document.addEventListener('DOMContentLoaded', async () => {
  await testConnection();
  await loadCurrentTabs();
  await loadConnectedTabs();
});

async function testConnection() {
  const statusIndicator = document.getElementById('statusIndicator');
  const statusText = document.getElementById('statusText');
  const serverBtn = document.getElementById('serverBtn');

  try {
    const response = await fetch(`${SERVER_URL}/tabs`);
    const data = await response.json();
    
    if (data.type === 'success') {
      statusIndicator.className = 'status-indicator running';
      statusText.textContent = 'Server connected';
      serverBtn.textContent = 'Connected';
      serverBtn.className = 'server-btn';
      serverBtn.disabled = true;
    } else {
      throw new Error(data.error || 'Connection failed');
    }
  } catch (error) {
    statusIndicator.className = 'status-indicator stopped';
    statusText.textContent = 'Server not running';
    serverBtn.textContent = 'Retry';
    serverBtn.className = 'server-btn start';
    serverBtn.disabled = false;
  }
}

async function loadCurrentTabs() {
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    currentTabs = tabs.filter(t => !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://'));
    renderTabsList();
  } catch (error) {
    console.error('Error loading tabs:', error);
    document.getElementById('tabsList').innerHTML = '<div class="no-tabs">Error loading tabs</div>';
  }
}

async function loadConnectedTabs() {
  try {
    const response = await fetch(`${SERVER_URL}/tabs`);
    const data = await response.json();
    
    if (data.type === 'success' && Array.isArray(data.result)) {
      connectedTabIds = new Set(data.result.map(t => t.id));
      renderTabsList();
    }
  } catch (error) {
    console.error('Error loading connected tabs:', error);
  }
}

function renderTabsList() {
  const tabsList = document.getElementById('tabsList');

  if (currentTabs.length === 0) {
    tabsList.innerHTML = '<div class="no-tabs">No tabs available</div>';
    return;
  }

  tabsList.innerHTML = currentTabs.map(tab => {
    const tabId = `tab_${tab.id}`;
    const isConnected = connectedTabIds.has(tabId);

    return `
      <div class="tab-item">
        <div class="tab-header">
          <div class="tab-title">${escapeHtml(tab.title || 'Untitled')}</div>
          ${isConnected ? `<span class="tab-badge">Connected</span>` : ''}
        </div>
        <div class="tab-url">${escapeHtml(tab.url || '')}</div>
        <div class="tab-actions">
          <button class="tab-btn ${isConnected ? 'connected' : 'connect'}" 
                  data-tab-id="${tab.id}" data-title="${escapeHtml(tab.title || '')}" data-url="${escapeHtml(tab.url || '')}" data-connect="${!isConnected}">
            ${isConnected ? 'Connected' : 'Connect'}
          </button>
          ${isConnected ? `
            <button class="tab-btn disconnect" data-tab-id="${tabId}">
              Disconnect
            </button>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');
  
  document.querySelectorAll('.tab-btn.connect, .tab-btn.connected').forEach(btn => {
    btn.addEventListener('click', () => {
      const chromeTabId = parseInt(btn.dataset.tabId);
      const title = btn.dataset.title;
      const url = btn.dataset.url;
      const shouldConnect = btn.dataset.connect === 'true';
      window.handleTabAction(chromeTabId, title, url, shouldConnect);
    });
  });
  
  document.querySelectorAll('.tab-btn.disconnect').forEach(btn => {
    btn.addEventListener('click', () => {
      window.disconnectTab(btn.dataset.tabId);
    });
  });
}

window.handleTabAction = async function(chromeTabId, title, url, shouldConnect) {
  console.log('handleTabAction:', { chromeTabId, title, url, shouldConnect });
  if (shouldConnect) {
    const result = await connectTab(chromeTabId, title, url);
    console.log('connectTab result:', result);
  }
  await loadConnectedTabs();
  renderTabsList();
};

async function connectTab(chromeTabId, title, url) {
  console.log('Connecting tab:', { chromeTabId, title, url });
  try {
    const response = await fetch(`${SERVER_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tab_id: chromeTabId, title, url })
    });
    const data = await response.json();
    console.log('Register response:', data);
    
    if (data.type === 'success' && data.result && data.result.id) {
      connectedTabIds.add(data.result.id);
      return data.result.id;
    }
  } catch (error) {
    console.error('Error connecting tab:', error);
  }
  return null;
}

window.disconnectTab = async function(tabId) {
  try {
    await fetch(`${SERVER_URL}/unregister`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: tabId })
    });
    connectedTabIds.delete(tabId);
    renderTabsList();
  } catch (error) {
    console.error('Error disconnecting tab:', error);
  }
};

document.getElementById('serverBtn').addEventListener('click', async () => {
  await testConnection();
  await loadConnectedTabs();
});

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
