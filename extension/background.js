const WS_URL = 'ws://localhost:9223/ws/extension';
const connectedTabs = new Map();
const lastFindElementsResult = new Map();
let ws = null;
let wsReconnectTimeout = null;
let pingInterval = null;
const inFlightCommands = new Set();
const recentCommandResponses = new Map();
const debuggerSessions = new Map();

function pruneRecentCommandResponses() {
  const cutoff = Date.now() - 120000;
  for (const [cmdId, entry] of recentCommandResponses) {
    if (!entry || entry.ts < cutoff) {
      recentCommandResponses.delete(cmdId);
    }
  }
}

function sendCommandResponse(msg) {
  if (msg && msg.cmd_id) {
    recentCommandResponses.set(msg.cmd_id, { msg, ts: Date.now() });
    pruneRecentCommandResponses();
  }
  wsSend(msg);
}

async function ensureDebuggerAttached(tabId) {
  if (debuggerSessions.has(tabId)) {
    return true;
  }
  
  try {
    await new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, '1.3', () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          debuggerSessions.set(tabId, true);
          resolve();
        }
      });
    });
    return true;
  } catch (e) {
    console.error('Failed to attach debugger to tab', tabId, ':', e.message);
    return false;
  }
}

const jQueryInjected = new Map();

async function ensureJQueryLoaded(tabId) {
  if (jQueryInjected.get(tabId)) {
    return true;
  }
  
  try {
    const attached = await ensureDebuggerAttached(tabId);
    if (!attached) {
      return false;
    }
    
    const jQueryCDN = `https://code.jquery.com/jquery-3.7.1.min.js`;
    const script = `
      (function() {
        if (typeof window.jQuery !== 'undefined') {
          return { alreadyLoaded: true };
        }
        var script = document.createElement('script');
        script.src = '${jQueryCDN}';
        script.onload = function() { window.jQueryLoaded = true; };
        document.head.appendChild(script);
        return new Promise(function(resolve) {
          var checkCount = 0;
          var checkJQuery = setInterval(function() {
            checkCount++;
            if (window.jQuery) {
              clearInterval(checkJQuery);
              resolve({ loaded: true });
            } else if (checkCount > 100) {
              clearInterval(checkJQuery);
              resolve({ error: 'jQuery load timeout' });
            }
          }, 50);
        });
      })()
    `;
    
    const result = await new Promise((resolve, reject) => {
      chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: script,
        awaitPromise: true,
        returnByValue: true
      }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response.exceptionDetails) {
          resolve({ error: response.exceptionDetails.text });
        } else {
          resolve(response.result.value);
        }
      });
    });
    
    if (!result.error) {
      jQueryInjected.set(tabId, true);
      return true;
    }
    return false;
  } catch (error) {
    console.error('Failed to inject jQuery:', error.message);
    return false;
  }
}

async function executeScriptViaDebugger(tabId, script, awaitPromise = true) {
  try {
    const attached = await ensureDebuggerAttached(tabId);
    if (!attached) {
      return { error: 'Failed to attach debugger' };
    }
    
    const consoleMessages = [];
    const consoleHandler = (debuggee, params) => {
      const args = params.args.map(arg => {
        if (arg.type === 'string') return arg.value;
        if (arg.type === 'number') return arg.value;
        if (arg.type === 'boolean') return arg.value;
        if (arg.type === 'undefined') return undefined;
        if (arg.type === 'object') return arg.description || '[Object]';
        if (arg.type === 'function') return arg.description || '[Function]';
        return arg.value;
      });
      consoleMessages.push({
        type: params.type,
        messages: args
      });
    };
    
    chrome.debugger.onEvent.addListener(consoleHandler);
    
    const expression = awaitPromise
      ? `(async () => { ${script} })()`
      : `(function() { ${script} })()`;
    
    const result = await new Promise((resolve, reject) => {
      chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: expression,
        awaitPromise: awaitPromise,
        returnByValue: true
      }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response.exceptionDetails) {
          resolve({
            error: response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'Script error'
          });
        } else if (response.result.type === 'object' && response.result.subtype === 'error') {
          resolve({
            error: response.result.description || 'Script error'
          });
        } else {
          resolve(response.result.value);
        }
      });
    });
    
    chrome.debugger.onEvent.removeListener(consoleHandler);
    
    let response;
    if (result === undefined) {
      response = { success: true };
    } else if (result.error) {
      response = result;
    } else {
      response = { result };
    }
    
    if (consoleMessages.length > 0) {
      response.consoleOutput = consoleMessages;
    }
    
    return response;
  } catch (error) {
    return { error: error.message };
  }
}

async function clickElementViaDebugger(tabId, selector, index = 0) {
  if (!selector || selector.trim() === '') {
    return { error: 'Selector is required for click_element' };
  }
  
  try {
    const jQueryLoaded = await ensureJQueryLoaded(tabId);
    if (!jQueryLoaded) {
      return { error: 'Failed to load jQuery' };
    }
    
    const escapedSelector = selector.replace(/'/g, "\\'");
    
    const script = `
      (function() {
        try {
          var $ = window.jQuery;
          var elements = $( '${escapedSelector}' );
          if (elements.length === 0) {
            return { error: 'No elements found for selector: ${escapedSelector}' };
          }
          var el = elements[${index}] || elements[0];
          if (!el) {
            return { error: 'No element at index ${index}' };
          }
          $(el).click();
          return { 
            success: true, 
            clicked: { 
              tag: el.tagName, 
              text: (el.innerText || el.textContent || '').trim().substring(0, 50),
              selector: '${escapedSelector}',
              index: ${index},
              matchedCount: elements.length
            } 
          };
        } catch(e) {
          return { error: e.message || 'Selector error' };
        }
      })()
    `;
    
    const result = await new Promise((resolve, reject) => {
      chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: script,
        awaitPromise: false,
        returnByValue: true
      }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response.exceptionDetails) {
          resolve({
            error: response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'Click error'
          });
        } else {
          resolve(response.result.value);
        }
      });
    });
    
    return result;
  } catch (error) {
    return { error: error.message };
  }
}

async function detachDebugger(tabId) {
  if (debuggerSessions.has(tabId)) {
    try {
      await new Promise((resolve) => {
        chrome.debugger.detach({ tabId }, () => resolve());
      });
      debuggerSessions.delete(tabId);
    } catch (e) {
      console.error('Failed to detach debugger:', e.message);
    }
  }
}

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
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  if (wsReconnectTimeout) {
    clearTimeout(wsReconnectTimeout);
    wsReconnectTimeout = null;
  }

  try {
    const socket = new WebSocket(WS_URL);
    ws = socket;
    
    socket.onopen = () => {
      if (ws !== socket) return;
      console.log('WebSocket connected');
      syncTabsFromDaemon();
      if (pingInterval) clearInterval(pingInterval);
      pingInterval = setInterval(() => {
        if (ws === socket && ws.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'ping' }));
        }
      }, 30000);
    };
    
    socket.onmessage = async (event) => {
      if (ws !== socket) return;
      try {
        console.log('WS received:', event.data.substring(0, 200));
        const msg = JSON.parse(event.data);
        await handleWebSocketMessage(msg);
      } catch (e) {
        console.error('Failed to parse WebSocket message:', e);
      }
    };
    
    socket.onclose = () => {
      if (ws !== socket) return;
      console.log('WebSocket disconnected, reconnecting...');
      ws = null;
      if (pingInterval) clearInterval(pingInterval);
      scheduleReconnect();
    };
    
    socket.onerror = (error) => {
      if (ws !== socket) return;
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
      processCommand(msg).catch(e => console.error('Command processing error:', e));
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
    connectedTabs.forEach((tab, key) => {
      if (tab.tabId === tabId) {
        if (changeInfo.url) {
          tab.url = changeInfo.url;
        }
      }
    });
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

async function sendTabMessage(tabId, message, timeoutMs = 30000) {
  console.log('Sending message to tab', tabId, ':', JSON.stringify(message).substring(0, 200));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('sendTabMessage timeout after ' + timeoutMs + 'ms'));
    }, timeoutMs);
    
    chrome.tabs.sendMessage(tabId, message, (response) => {
      clearTimeout(timeout);
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
    const result = await sendTabMessage(tabId, { type: 'ping' }, 5000);
    return result && result.loaded === true;
  } catch (e) {
    console.log('Content script not loaded in tab', tabId, ':', e.message);
    return false;
  }
}

async function injectContentScript(tabId) {
  try {
    if (typeof chrome.scripting !== 'undefined' && chrome.scripting.executeScript) {
      await Promise.race([
        chrome.scripting.executeScript({
          target: { tabId },
          files: ['content.js']
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('injection timeout')), 10000))
      ]);
      console.log('Content script injected into tab', tabId);
      await new Promise(r => setTimeout(r, 500));
      return await checkContentScriptLoaded(tabId);
    }
  } catch (e) {
    console.error('Failed to inject content script:', e.message);
  }
  return false;
}

async function verifyAndCleanupTab(tabId, tabKey) {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch (e) {
    console.log('Tab no longer exists in Chrome:', tabId, 'removing from connectedTabs and daemon');
    connectedTabs.delete(tabKey);
    apiRequest('/unregister', 'POST', { id: tabKey }).catch(() => {});
    updateBadge();
    return false;
  }
}

function isUnsupportedTabURL(url = '') {
  return /^(chrome|chrome-extension|devtools|edge|about):\/\//i.test(url);
}

function isValidSelector(selector) {
  if (!selector || typeof selector !== 'string' || selector.trim() === '') {
    return false;
  }
  
  const trimmed = selector.trim();
  
  if (trimmed.length > 500) {
    return false;
  }
  
  if (/[<>{}\\]/.test(trimmed)) {
    return false;
  }
  
  return true;
}

function toBool(value, defaultValue) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  if (typeof value === 'number') return value !== 0;
  return defaultValue;
}

function toPositiveInt(value, defaultValue, maxValue = 1000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.max(0, Math.min(maxValue, Math.floor(parsed)));
}

async function executeScriptWithDebugger(tabId, script, awaitPromise = true) {
  const target = { tabId };
  let attached = false;

  try {
    await chrome.debugger.attach(target, '1.3');
    attached = true;
  } catch (err) {
    // Another debugger session may already be attached.
    if (!String(err?.message || '').includes('Another debugger is already attached')) {
      throw err;
    }
  }

  try {
    await chrome.debugger.sendCommand(target, 'Runtime.enable');
    const response = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: script,
      awaitPromise: !!awaitPromise,
      returnByValue: true,
      userGesture: true,
      allowUnsafeEvalBlocked: true
    });

    if (response?.exceptionDetails) {
      const desc = response.exceptionDetails?.text || response.result?.description || 'Script execution failed';
      throw new Error(desc);
    }

    return {
      value: response?.result?.value,
      type: response?.result?.type || null,
      description: response?.result?.description || null
    };
  } finally {
    if (attached) {
      try {
        await chrome.debugger.detach(target);
      } catch (_) {
      }
    }
  }
}

function updateBadge() {
  const count = connectedTabs.size;
  chrome.action.setBadgeText({ text: count > 0 ? count.toString() : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
}

async function processCommand(msg) {
  const { tab_id, cmd_id, cmd_type, data } = msg;
  const cmdType = cmd_type || data?._type;
  const actualCmdId = data?._cmd_id || cmd_id;
  console.log('Processing command:', actualCmdId, 'type:', cmdType, 'tab_id:', tab_id);
  if (!actualCmdId) {
    wsSend({
      type: 'command_failed',
      cmd_id: cmd_id || '',
      error: 'Missing command ID'
    });
    return;
  }
  const cached = recentCommandResponses.get(actualCmdId);
  if (cached && cached.msg) {
    wsSend(cached.msg);
    return;
  }
  if (inFlightCommands.has(actualCmdId)) {
    console.log('Ignoring duplicate in-flight command:', actualCmdId);
    return;
  }
  inFlightCommands.add(actualCmdId);
  let tab = null;
  
  try {
    tab = connectedTabs.get(tab_id);
    if (!tab) {
      console.error('Tab not found in connectedTabs:', tab_id, 'Available:', [...connectedTabs.keys()]);
      sendCommandResponse({
        type: 'command_failed',
        cmd_id: actualCmdId,
        error: `Tab ${tab_id} not found or not connected`
      });
      return;
    }
    
    if (!tab.tabId || typeof tab.tabId !== 'number') {
      console.error('Invalid tab.tabId:', tab.tabId, 'Tab data:', tab);
      sendCommandResponse({
        type: 'command_failed',
        cmd_id: actualCmdId,
        error: `Invalid tab ID for ${tab_id}: tab.tabId=${tab.tabId}`
      });
      return;
    }
    
    const tabExists = await verifyAndCleanupTab(tab.tabId, tab_id);
    if (!tabExists) {
      sendCommandResponse({
        type: 'command_failed',
        cmd_id: actualCmdId,
        error: `Tab ${tab_id} no longer exists in Chrome. It has been removed.`
      });
      return;
    }

    const liveTab = await chrome.tabs.get(tab.tabId);
    const currentURL = liveTab?.url || tab.url || '';
    if (isUnsupportedTabURL(currentURL) && cmdType !== 'execute_script') {
      sendCommandResponse({
        type: 'command_failed',
        cmd_id: actualCmdId,
        error: `Unsupported tab URL for automation: ${currentURL}`
      });
      return;
    }

    const commandNeedsContentScript = cmdType !== 'execute_script' && cmdType !== 'click_element';
    let contentScriptLoaded = false;
    if (commandNeedsContentScript) {
      contentScriptLoaded = await checkContentScriptLoaded(tab.tabId);
      if (!contentScriptLoaded) {
        console.log('Content script not loaded, attempting injection...');
        contentScriptLoaded = await injectContentScript(tab.tabId);
      }
      if (!contentScriptLoaded) {
        const tabStillExists = await verifyAndCleanupTab(tab.tabId, tab_id);
        if (!tabStillExists) {
          sendCommandResponse({
            type: 'command_failed',
            cmd_id: actualCmdId,
            error: `Tab ${tab_id} no longer exists in Chrome. It has been removed.`
          });
        } else {
          console.error('Content script still not loaded in tab:', tab.tabId);
          sendCommandResponse({
            type: 'command_failed',
            cmd_id: actualCmdId,
            error: `Content script not loaded in tab ${tab_id}. Try reloading the tab.`
          });
        }
        return;
      }
    }

    let result;
    
    switch (cmdType) {
      case 'execute_script':
        result = await executeScriptViaDebugger(
          tab.tabId,
          data?.raw || data?.script || '',
          true
        );
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
          selector: data?.selector || null,
          options: {
            offset: toPositiveInt(data?.offset, 0, 50000),
            limit: toPositiveInt(data?.limit, 500, 50000),
            headingsLimit: data?.headings_limit || 20,
            linksLimit: data?.links_limit || 50,
            formsLimit: data?.forms_limit || 10,
            buttonsLimit: data?.buttons_limit || 30,
            imagesLimit: data?.images_limit || 20
          }
        });
        break;
        
      case 'get_page_source':
        result = await sendTabMessage(tab.tabId, {
          type: 'get_page_source',
          offset: data?.offset || 0,
          limit: data?.limit || 500
        });
        break;
        
      case 'find_elements':
        console.log('find_elements data:', JSON.stringify(data));
        result = await sendTabMessage(tab.tabId, {
          type: 'find_elements',
          selector: data?.selector,
          selector_type: data?.selector_type || 'css',
          offset: data?.offset || 0,
          limit: Math.min(data?.limit || 20, 50)
        });
        if (result && result.elements && !result.error) {
          lastFindElementsResult.set(tab_id, result.elements);
        }
        break;
        
      case 'click_element':
        let selectorToClick = data?.selector;
        let indexToClick = data?.index || 0;
        
        if (!selectorToClick && lastFindElementsResult.has(tab_id)) {
          const cachedElements = lastFindElementsResult.get(tab_id);
          if (cachedElements && cachedElements.length > 0) {
            const el = cachedElements[indexToClick];
            if (el) {
              const tag = el.tag || 'button';
              const id = el.id ? `#${el.id}` : '';
              const cls = el.class ? `.${el.class.replace(/\s+/g, '.').split('.')[0]}` : '';
              selectorToClick = `${tag}${id}${cls}`;
              console.log('click_element using cached selector:', selectorToClick, 'from index:', indexToClick);
            }
          }
        }
        
        if (!selectorToClick) {
          sendCommandResponse({
            type: 'command_failed',
            cmd_id: actualCmdId,
            error: 'selector is required for click_element (or run find_elements first to enable index-based clicking)'
          });
          return;
        }
        
        if (!isValidSelector(selectorToClick)) {
          sendCommandResponse({
            type: 'command_failed',
            cmd_id: actualCmdId,
            error: `Invalid selector: ${selectorToClick}`
          });
          return;
        }
        
        console.log('click_element processing selector:', selectorToClick, 'index:', indexToClick);
        result = await clickElementViaDebugger(tab.tabId, selectorToClick, 0);
        break;
        
      case 'get_visible_elements':
        const visibleLimit = Math.max(1, toPositiveInt(data?.limit, toPositiveInt(data?.max_elements, 25, 200), 200));
        const visibleOffset = toPositiveInt(data?.offset, 0, 10000);
        result = await sendTabMessage(tab.tabId, {
          type: 'get_visible_elements',
          options: {
            maxElements: visibleLimit,
            offset: visibleOffset,
            limit: visibleLimit,
            minTextLength: Math.max(1, toPositiveInt(data?.min_text_length, 1, 200)),
            includeHeadings: toBool(data?.include_headings, true),
            includeLinks: toBool(data?.include_links, true),
            includeButtons: toBool(data?.include_buttons, true),
            includeInputs: toBool(data?.include_inputs, true),
            includeImages: toBool(data?.include_images, true)
          }
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
        try {
          const windowId = tab.windowId && tab.windowId > 0 ? tab.windowId : null;
          const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
          result = { success: true, dataUrl };
        } catch (e) {
          result = { error: e.message };
        }
        break;
        
      case 'search_text':
        result = await sendTabMessage(tab.tabId, {
          type: 'search_text',
          pattern: data?.pattern || '',
          options: {
            caseSensitive: data?.case_sensitive || false,
            wholeWord: data?.whole_word || false,
            regex: data?.regex || false,
            maxResults: data?.max_results || 20,
            offset: data?.offset || 0,
            limit: data?.limit || 20
          }
        });
        break;
        
      default:
        sendCommandResponse({
          type: 'command_failed',
          cmd_id: actualCmdId,
          error: `Unknown command: ${cmdType}`
        });
        return;
    }
    
    if (result && result.error) {
      sendCommandResponse({
        type: 'command_failed',
        cmd_id: actualCmdId,
        error: result.error
      });
    } else {
      sendCommandResponse({
        type: 'command_complete',
        cmd_id: actualCmdId,
        result
      });
    }
  } catch (error) {
    console.error('Command failed:', actualCmdId, error);
    
    const errorMsg = error.message || '';
    if (errorMsg.includes('Receiving end does not exist') || 
        errorMsg.includes('No tab with id') ||
        errorMsg.includes('Tab not found')) {
      if (tab && typeof tab.tabId === 'number') {
        await verifyAndCleanupTab(tab.tabId, tab_id);
      }
      sendCommandResponse({
        type: 'command_failed',
        cmd_id: actualCmdId,
        error: `Tab ${tab_id} no longer exists in Chrome. It has been removed.`
      });
    } else {
      sendCommandResponse({
        type: 'command_failed',
        cmd_id: actualCmdId,
        error: error.message
      });
    }
  } finally {
    inFlightCommands.delete(actualCmdId);
  }
}

function wsSend(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

connectWebSocket();
