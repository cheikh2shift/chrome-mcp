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
      connectedTabs.clear();
      response.result.forEach(tab => {
        connectedTabs.set(tab.id, {
          id: tab.id,
          tabId: tab.chrome_tab_id || tab.tabId,
          title: tab.title || '',
          url: tab.url || '',
          windowId: tab.windowId || 0
        });
      });
      updateBadge();
      console.log('Synced tabs from daemon:', connectedTabs.size);
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
          
          try {
            await apiRequest('/register', 'POST', {
              tab_id: message.tabId,
              title: message.title || 'Unknown',
              url: message.url || ''
            });
          } catch (e) {
            console.warn('Could not register tab with server:', e.message);
          }
          
          updateBadge();
          return { success: true, id: tabData.id };
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
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

function updateBadge() {
  const count = connectedTabs.size;
  chrome.action.setBadgeText({ text: count > 0 ? count.toString() : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
}

async function processCommand(msg) {
  const { tab_id, cmd_id, data } = msg;
  console.log('Processing command:', cmd_id, 'type:', data?._type, 'tab_id:', tab_id);
  
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
  
  const cmdType = data?._type || data?.type;
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
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
          format: 'png'
        });
        result = { type: 'result', result: { dataUrl } };
        break;
        
      default:
        wsSend({
          type: 'command_failed',
          cmd_id: actualCmdId,
          error: `Unknown command type: ${cmdType}`
        });
        return;
    }
    
    switch (data?.type) {
      case 'execute_script':
        result = await sendTabMessage(tab.tabId, {
          type: 'execute_script',
          script: data.params,
          await_promise: true
        });
        break;
        
      case 'get_page_structure':
        result = await sendTabMessage(tab.tabId, {
          type: 'get_page_structure',
          max_depth: params.max_depth || 3
        });
        break;
        
      case 'extract_page_content':
        result = await sendTabMessage(tab.tabId, {
          type: 'extract_content',
          selector: params.selector || null
        });
        break;
        
      case 'get_page_source':
        result = await sendTabMessage(tab.tabId, {
          type: 'get_page_source',
          max_length: params.max_length || 50000
        });
        break;
        
      case 'find_elements':
        result = await sendTabMessage(tab.tabId, {
          type: 'find_elements',
          selector: params.selector,
          selector_type: params.selector_type || 'css'
        });
        break;
        
      case 'get_element_details':
        result = await sendTabMessage(tab.tabId, {
          type: 'get_element_details',
          selector: params.selector
        });
        break;
        
      case 'wait_for_element':
        result = await sendTabMessage(tab.tabId, {
          type: 'wait_for_element',
          selector: params.selector,
          timeout_ms: params.timeout_ms || 10000
        });
        break;
        
      case 'take_screenshot':
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
          format: 'png'
        });
        result = { type: 'result', result: { dataUrl } };
        break;
        
      default:
        wsSend({
          type: 'command_failed',
          cmd_id,
          error: `Unknown command type: ${data?.type}`
        });
        return;
    }
    
    if (result && result.type === 'result') {
      wsSend({
        type: 'command_complete',
        cmd_id: actualCmdId,
        result: result.result
      });
    } else if (result && result.type === 'error') {
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
