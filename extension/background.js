const WS_URL = 'ws://localhost:9223/ws';
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
      console.log('Tab registered via WS:', msg.data);
      break;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('Chrome MCP Controller installed');
  connectWebSocket();
});

chrome.runtime.onStartup.addListener(() => {
  console.log('Chrome starting up');
  connectWebSocket();
});

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
  const { cmd_id, tab_id, data } = msg;
  console.log('Processing command:', cmd_id, data?.type);
  
  const tab = connectedTabs.get(tab_id);
  if (!tab) {
    wsSend({
      type: 'command_failed',
      cmd_id,
      error: `Tab ${tab_id} not found or not connected`
    });
    return;
  }
  
  let params = {};
  try {
    if (data?.params) {
      params = JSON.parse(data.params);
    }
  } catch (e) {
    params = { raw: data?.params };
  }
  
  try {
    let result;
    
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
        cmd_id,
        result: result.result
      });
    } else if (result && result.type === 'error') {
      wsSend({
        type: 'command_failed',
        cmd_id,
        error: result.error
      });
    } else {
      wsSend({
        type: 'command_complete',
        cmd_id,
        result
      });
    }
  } catch (error) {
    wsSend({
      type: 'command_failed',
      cmd_id,
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
