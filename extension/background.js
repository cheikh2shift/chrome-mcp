const WS_URL = 'ws://localhost:9223/ws/extension';
const connectedTabs = new Map();
let ws = null;
let wsReconnectTimeout = null;
let pingInterval = null;

async function apiRequest(endpoint, method = 'GET', body = null) {
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  
  if (body) {
    options.body = JSON.stringify(body);
  }

  try {
    const response = await fetch(`http://localhost:9223${endpoint}`, options);
    return await response.json();
  } catch (error) {
    console.error('API request failed:', error);
    throw error;
  }
}

function connectWebSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    return;
  }

  try {
    ws = new WebSocket(WS_URL);
    
    ws.onopen = () => {
      console.log('WebSocket connected');
      syncTabsFromDaemon();
      if (pingInterval) clearInterval(pingInterval);
      pingInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 30000);
    };
    
    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        await handleWebSocketMessage(msg);
      } catch (e) {
        console.error('Failed to parse WebSocket message:', e);
      }
    };
    
    ws.onclose = () => {
      console.log('WebSocket disconnected, reconnecting...');
      if (pingInterval) clearInterval(pingInterval);
      scheduleReconnect();
    };
    
    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  } catch (error) {
    console.error('Failed to create WebSocket:', error);
    scheduleReconnect();
  }
}

async function syncTabsFromDaemon() {
  try {
    const response = await apiRequest('/tabs');
    if (response.type === 'success' && Array.isArray(response.result)) {
      const newConnectedTabs = new Map();
      const toRemove = [];
      
      for (const tab of response.result) {
        const chromeTabId = tab.chrome_tab_id || tab.tabId;
        
        if (chromeTabId && typeof chromeTabId === 'number') {
          try {
            await chrome.tabs.get(chromeTabId);
            newConnectedTabs.set(tab.id, {
              id: tab.id,
              tabId: chromeTabId,
              title: tab.title || '',
              url: tab.url || '',
              windowId: tab.windowId || 0
            });
          } catch (e) {
            console.log('Tab no longer exists in Chrome:', chromeTabId, 'removing from daemon');
            toRemove.push(tab.id);
          }
        }
      }
      
      connectedTabs.clear();
      newConnectedTabs.forEach((v, k) => connectedTabs.set(k, v));
      
      for (const id of toRemove) {
        apiRequest('/unregister', 'POST', { id }).catch(() => {});
      }
      
      updateBadge();
      console.log('Synced tabs from daemon:', connectedTabs.size, 'removed:', toRemove.length);
    }
  } catch (e) {
    console.warn('Failed to sync tabs:', e.message);
  }
}

function scheduleReconnect() {
  if (wsReconnectTimeout) clearTimeout(wsReconnectTimeout);
  wsReconnectTimeout = setTimeout(connectWebSocket, 2000);
}

async function handleWebSocketMessage(msg) {
  switch (msg.type) {
    case 'command':
      await processCommand(msg);
      break;
      
    case 'tab_registered':
      const regData = msg.data || msg;
      const tabId = regData.chrome_tab_id || regData.tabId;
      if (regData.id && tabId) {
        connectedTabs.set(regData.id, {
          id: regData.id,
          tabId: tabId,
          title: regData.title || '',
          url: regData.url || '',
          windowId: regData.windowId || 0
        });
        updateBadge();
      }
      break;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('Chrome MCP Controller installed');
  connectWebSocket();
  startTabSync();
});

chrome.runtime.onStartup.addListener(() => {
  console.log('Chrome starting up');
  connectWebSocket();
  startTabSync();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  let removed = false;
  connectedTabs.forEach((tab, key) => {
    if (tab.tabId === tabId) {
      connectedTabs.delete(key);
      apiRequest('/unregister', 'POST', { id: key }).catch(() => {});
      removed = true;
      console.log('Tab removed:', key);
    }
  });
  if (removed) updateBadge();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' || changeInfo.url) {
    let unregistered = false;
    connectedTabs.forEach((tab, key) => {
      if (tab.tabId === tabId) {
        connectedTabs.delete(key);
        apiRequest('/unregister', 'POST', { id: key }).catch(() => {});
        unregistered = true;
        console.log('Tab unregistered due to navigation/refresh:', key);
      }
    });
    if (unregistered) updateBadge();
  }
});

let tabSyncInterval = null;

function startTabSync() {
  if (tabSyncInterval) clearInterval(tabSyncInterval);
  syncTabsFromDaemon();
  tabSyncInterval = setInterval(syncTabsFromDaemon, 20000);
  console.log('Tab sync started (every 20s)');
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handleAsync = async () => {
    try {
      switch (message.type) {
        case 'register_tab': {
          const tabData = {
            id: `tab_${message.tabId}`,
            tabId: message.tabId,
            title: message.title || 'Unknown',
            url: message.url || '',
            windowId: sender.tab?.windowId || 0,
            isActive: false
          };
          
          connectedTabs.set(tabData.id, tabData);
          console.log('Tab registered:', tabData.id, 'url:', message.url);
          
          try {
            const registered = await apiRequest('/register', 'POST', {
              tab_id: message.tabId,
              title: message.title || 'Unknown',
              url: message.url || ''
            });
            console.log('Tab registered with daemon:', registered);
          } catch (e) {
            console.warn('Could not register tab with server:', e.message);
          }
          
          let contentScriptLoaded = await checkContentScriptLoaded(message.tabId);
          if (!contentScriptLoaded) {
            console.log('Content script not loaded, attempting injection...');
            contentScriptLoaded = await injectContentScript(message.tabId);
          }
          console.log('Content script loaded:', contentScriptLoaded, 'for tab:', message.tabId);
          
          updateBadge();
          return { success: true, id: tabData.id, contentScriptLoaded };
        }

        case 'tab_registered': {
          const tabData = {
            id: message.id,
            tabId: message.tabId,
            title: message.title || 'Unknown',
            url: message.url || '',
            isActive: false
          };
          connectedTabs.set(tabData.id, tabData);
          updateBadge();
          return { success: true };
        }

        case 'unregister_tab': {
          try {
            await apiRequest('/unregister', 'POST', { id: message.id });
          } catch (e) {
            console.warn('Could not unregister tab from server:', e.message);
          }
          connectedTabs.delete(message.id);
          updateBadge();
          return { success: true };
        }

        case 'list_tabs': {
          try {
            const response = await apiRequest('/tabs');
            if (response.type === 'success') {
              connectedTabs.clear();
              response.result.forEach(tab => {
                connectedTabs.set(tab.id, { ...tab });
              });
              return response.result;
            }
          } catch (e) {
            console.warn('Could not fetch tabs from server:', e.message);
          }
          
          const tabs = [];
          connectedTabs.forEach((t, id) => {
            tabs.push({ id, title: t.title, url: t.url });
          });
          return tabs;
        }

        case 'ping':
          return { pong: true };

        case 'test_connection':
          if (ws && ws.readyState === WebSocket.OPEN) {
            return { success: true, connected: true };
          }
          try {
            const response = await apiRequest('/health');
            return { success: true, connected: response.status === 'ok' };
          } catch (e) {
            return { success: false, error: e.message };
          }

        case 'captureViewport':
          try {
            const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
            return { dataUrl };
          } catch (e) {
            return { error: e.message };
          }

        case 'inject_content_script':
          try {
            const injected = await injectContentScript(message.tabId);
            return { success: injected, tabId: message.tabId };
          } catch (e) {
            return { error: e.message };
          }

        default:
          return { error: `Unknown message type: ${message.type}` };
      }
    } catch (error) {
      return { error: error.message };
    }
  };

  handleAsync().then(sendResponse);
  return true;
});

async function sendTabMessage(tabId, message) {
  console.log('Sending message to tab', tabId, ':', JSON.stringify(message).substring(0, 200));
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        console.error('sendTabMessage error:', chrome.runtime.lastError.message);
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        console.log('Got response from tab', tabId, ':', JSON.stringify(response).substring(0, 200));
        resolve(response);
      }
    });
  });
}

async function checkContentScriptLoaded(tabId) {
  try {
    const result = await sendTabMessage(tabId, { type: 'ping' });
    return result && result.loaded === true;
  } catch (e) {
    console.log('Content script not loaded in tab', tabId, ':', e.message);
    return false;
  }
}

async function injectContentScript(tabId) {
  try {
    if (typeof chrome.scripting !== 'undefined' && chrome.scripting.executeScript) {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js']
      });
      console.log('Content script injected into tab', tabId);
      await new Promise(r => setTimeout(r, 500));
      return await checkContentScriptLoaded(tabId);
    }
  } catch (e) {
    console.error('Failed to inject content script:', e.message);
  }
  return false;
}

function updateBadge() {
  const count = connectedTabs.size;
  chrome.action.setBadgeText({ text: count > 0 ? count.toString() : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
}

async function processCommand(msg) {
  const { tab_id, cmd_id, cmd_type, data } = msg;
  console.log('Processing command:', cmd_id, 'type:', cmd_type || data?._type, 'tab_id:', tab_id);
  
  const tab = connectedTabs.get(tab_id);
  if (!tab) {
    console.error('Tab not found in connectedTabs:', tab_id, 'Available:', [...connectedTabs.keys()]);
    wsSend({
      type: 'command_failed',
      cmd_id,
      error: `Tab ${tab_id} not found or not connected`
    });
    return;
  }
  
  if (!tab.tabId || typeof tab.tabId !== 'number') {
    console.error('Invalid tab.tabId:', tab.tabId, 'Tab data:', tab);
    wsSend({
      type: 'command_failed',
      cmd_id,
      error: `Invalid tab ID for ${tab_id}: tab.tabId=${tab.tabId}`
    });
    return;
  }
  
  let contentScriptLoaded = await checkContentScriptLoaded(tab.tabId);
  if (!contentScriptLoaded) {
    console.log('Content script not loaded, attempting injection...');
    contentScriptLoaded = await injectContentScript(tab.tabId);
  }
  if (!contentScriptLoaded) {
    console.error('Content script still not loaded in tab:', tab.tabId);
    wsSend({
      type: 'command_failed',
      cmd_id,
      error: `Content script not loaded in tab ${tab_id}. Try reloading the tab.`
    });
    return;
  }
  
  const cmdType = cmd_type || data?._type;
  const actualCmdId = data?._cmd_id || cmd_id;
  
  try {
    let result;
    
    switch (cmdType) {
      case 'execute_script':
        result = await sendTabMessage(tab.tabId, {
          type: 'execute_script',
          script: data?.raw || data?.script || '',
          await_promise: true
        });
        break;
        
      case 'get_page_structure':
        result = await sendTabMessage(tab.tabId, {
          type: 'get_page_structure',
          max_depth: data?.max_depth || 3
        });
        break;
        
      case 'extract_page_content':
        result = await sendTabMessage(tab.tabId, {
          type: 'extract_content',
          selector: data?.selector || null
        });
        break;
        
      case 'get_page_source':
        result = await sendTabMessage(tab.tabId, {
          type: 'get_page_source',
          max_length: data?.max_length || 50000
        });
        break;
        
      case 'find_elements':
        result = await sendTabMessage(tab.tabId, {
          type: 'find_elements',
          selector: data?.selector,
          selector_type: data?.selector_type || 'css'
        });
        break;
        
      case 'get_element_details':
        result = await sendTabMessage(tab.tabId, {
          type: 'get_element_details',
          selector: data?.selector
        });
        break;
        
      case 'wait_for_element':
        result = await sendTabMessage(tab.tabId, {
          type: 'wait_for_element',
          selector: data?.selector,
          timeout_ms: data?.timeout_ms || 10000
        });
        break;
        
      case 'take_screenshot':
        const windowId = tab.windowId && tab.windowId > 0 ? tab.windowId : null;
        const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
          format: 'png'
        });
        result = { success: true, dataUrl };
        break;
        
      case 'search_text':
        result = await sendTabMessage(tab.tabId, {
          type: 'search_text',
          pattern: data?.pattern || '',
          options: {
            caseSensitive: data?.case_sensitive || false,
            wholeWord: data?.whole_word || false,
            regex: data?.regex || false,
            maxResults: data?.max_results || 100
          }
        });
        break;
        
      default:
        wsSend({
          type: 'command_failed',
          cmd_id: actualCmdId,
          error: `Unknown command type: ${cmdType}`
        });
        return;
    }
    
    if (result && result.error) {
      wsSend({
        type: 'command_failed',
        cmd_id: actualCmdId,
        error: result.error
      });
    } else {
      wsSend({
        type: 'command_complete',
        cmd_id: actualCmdId,
        result
      });
    }
  } catch (error) {
    console.error('Command failed:', actualCmdId, error);
    wsSend({
      type: 'command_failed',
      cmd_id: actualCmdId,
      error: error.message
    });
  }
}

function wsSend(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

connectWebSocket();
