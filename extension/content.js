(function() {
  const pendingCallbacks = new Map();
  let callbackId = 0;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message.type) return;

    const handleAsync = async () => {
      try {
        switch (message.type) {
          case 'get_page_structure':
            return getPageStructure(message.max_depth);

          case 'extract_content':
            return extractContent(message.selector);

          case 'get_page_source':
            return getPageSource(message.max_length);

          case 'find_elements':
            return findElements(message.selector, message.selector_type);

          case 'execute_script':
            return executeScript(message.script, message.await_promise);

          case 'get_element_details':
            return getElementDetails(message.selector);

          case 'wait_for_element':
            return waitForElement(message.selector, message.timeout_ms);

          case 'capture_viewport':
            return captureViewport();

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

  function getPageStructure(maxDepth = 3) {
    maxDepth = Math.min(Math.max(1, maxDepth), 10);

    function getElementInfo(el, depth) {
      if (depth > maxDepth) return null;

      const info = {
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        class: el.className ? Array.from(el.classList).filter(c => c) : [],
        attrs: {}
      };

      const importantAttrs = ['type', 'name', 'href', 'src', 'placeholder', 'value', 'action', 'method', 'role', 'aria-label', 'data-testid'];
      for (const attr of importantAttrs) {
        if (el[attr] && typeof el[attr] === 'string' && el[attr]) {
          info.attrs[attr] = el[attr];
        }
      }

      const innerText = el.innerText || '';
      if (innerText && innerText.trim()) {
        info.textPreview = innerText.trim().substring(0, 100);
      }

      if (depth < maxDepth) {
        const childElements = el.children;
        const children = [];
        for (let i = 0; i < Math.min(childElements.length, 20); i++) {
          const childInfo = getElementInfo(childElements[i], depth + 1);
          if (childInfo) {
            children.push(childInfo);
          }
        }
        if (childElements.length > 20) {
          children.push({ _more: `${childElements.length - 20} more children` });
        }
        info.children = children;
      }

      return info;
    }

    return getElementInfo(document.body, 0);
  }

  function extractContent(selector) {
    function getText(element) {
      const text = [];
      function walk(node) {
        if (node.nodeType === Node.TEXT_NODE) {
          const t = node.textContent.trim();
          if (t) text.push(t);
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          const tag = node.tagName.toLowerCase();
          if (!['script', 'style', 'noscript', 'iframe', 'object', 'embed'].includes(tag)) {
            Array.from(node.childNodes).forEach(walk);
            if (['p', 'div', 'li', 'td', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br'].includes(tag)) {
              text.push('\n');
            }
          }
        }
      }
      walk(element);
      return text.join(' ').replace(/\s+/g, ' ').trim();
    }

    const root = selector ? document.querySelector(selector) : document.body;

    if (!root) {
      return { error: `Element not found: ${selector}` };
    }

    const result = {
      title: document.title,
      url: window.location.href,
      text: getText(root),
      headings: Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6')).slice(0, 20).map(h => ({
        level: parseInt(h.tagName[1]),
        text: h.innerText.trim().substring(0, 200)
      })),
      links: Array.from(root.querySelectorAll('a[href]')).slice(0, 50).map(a => ({
        text: a.innerText.trim().substring(0, 100),
        href: a.href
      })),
      forms: Array.from(root.querySelectorAll('form')).slice(0, 10).map(f => ({
        action: f.action,
        method: f.method.toUpperCase(),
        inputs: Array.from(f.querySelectorAll('input, textarea, select')).slice(0, 30).map(i => ({
          type: i.type || i.tagName.toLowerCase(),
          name: i.name || null,
          placeholder: i.placeholder || null,
          required: i.required || false
        }))
      })),
      buttons: Array.from(root.querySelectorAll('button')).slice(0, 30).map(b => ({
        text: b.innerText.trim().substring(0, 100),
        type: b.type || 'submit',
        disabled: b.disabled
      })),
      images: Array.from(root.querySelectorAll('img[src]')).slice(0, 20).map(img => ({
        alt: img.alt || '',
        src: img.src,
        width: img.naturalWidth,
        height: img.naturalHeight
      }))
    };

    return result;
  }

  function getPageSource(maxLength = 50000) {
    let html = document.documentElement.outerHTML;
    if (html.length > maxLength) {
      html = html.substring(0, maxLength) + '\n\n[Truncated - page too large]';
    }
    return html;
  }

  function findElements(selector, selectorType = 'css') {
    let elements;

    if (selectorType === 'xpath') {
      const result = document.evaluate(selector, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      elements = [];
      for (let i = 0; i < result.snapshotLength; i++) {
        elements.push(result.snapshotItem(i));
      }
    } else {
      elements = Array.from(document.querySelectorAll(selector));
    }

    const results = [];
    const maxResults = 50;

    for (let i = 0; i < Math.min(elements.length, maxResults); i++) {
      const el = elements[i];
      const attrs = {};

      if (el.type) attrs.type = el.type;
      if (el.name) attrs.name = el.name;
      if (el.value && typeof el.value === 'string') attrs.value = el.value.substring(0, 100);
      if (el.placeholder) attrs.placeholder = el.placeholder;
      if (el.href && el.href !== window.location.href) attrs.href = el.href;
      if (el.src && !el.src.startsWith('chrome')) attrs.src = el.src;
      if (el.alt) attrs.alt = el.alt;
      if (el.action) attrs.action = el.action;
      if (el.method) attrs.method = el.method;

      const rect = el.getBoundingClientRect();

      results.push({
        index: i,
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        class: el.className || null,
        text: el.innerText ? el.innerText.trim().substring(0, 150) : null,
        attrs: attrs,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          visible: rect.width > 0 && rect.height > 0
        },
        isClickable: el.onclick !== null || el.tagName === 'BUTTON' || el.tagName === 'A' || getComputedStyle(el).cursor === 'pointer'
      });
    }

    return {
      count: elements.length,
      elements: results
    };
  }

  async function executeScript(script, awaitPromise = true) {
    try {
      const wrappedScript = `
        (function() {
          ${script}
        })();
      `;

      let result;
      if (awaitPromise) {
        const asyncScript = `
          (async function() {
            ${script}
          })();
        `;
        result = await eval(asyncScript);
      } else {
        result = eval(wrappedScript);
      }

      if (result instanceof Element || result instanceof HTMLElement) {
        return serializeElement(result);
      }

      if (result instanceof NodeList || result instanceof HTMLCollection || Array.isArray(result)) {
        return Array.from(result).map(el => {
          if (el instanceof Element) {
            return serializeElement(el);
          }
          return el;
        });
      }

      if (typeof result === 'object' && result !== null) {
        try {
          return JSON.parse(JSON.stringify(result, (key, value) => {
            if (typeof value === 'function') return value.toString();
            if (value instanceof Element) return serializeElement(value);
            return value;
          }));
        } catch {
          return String(result);
        }
      }

      return result;
    } catch (error) {
      return { error: error.message, stack: error.stack };
    }
  }

  function serializeElement(el) {
    const rect = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      class: el.className || null,
      text: el.innerText ? el.innerText.trim().substring(0, 200) : null,
      html: el.innerHTML ? el.innerHTML.substring(0, 500) : null,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      attrs: Object.fromEntries(
        Array.from(el.attributes)
          .filter(a => !['class', 'id', 'style'].includes(a.name))
          .map(a => [a.name, a.value])
      )
    };
  }

  function getElementDetails(selector) {
    const el = document.querySelector(selector);

    if (!el) {
      return { error: `Element not found: ${selector}` };
    }

    const computed = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const attributes = {};

    for (const attr of el.attributes) {
      if (!['class', 'id', 'style'].includes(attr.name)) {
        attributes[attr.name] = attr.value;
      }
    }

    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      class: el.className || null,
      attributes: attributes,
      computedStyles: {
        display: computed.display,
        visibility: computed.visibility,
        opacity: computed.opacity,
        width: computed.width,
        height: computed.height,
        position: computed.position,
        zIndex: computed.zIndex,
        backgroundColor: computed.backgroundColor,
        color: computed.color,
        fontSize: computed.fontSize,
        fontWeight: computed.fontWeight
      },
      boundingRect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        top: Math.round(rect.top),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom),
        left: Math.round(rect.left)
      },
      text: el.innerText || null,
      value: el.value !== undefined ? el.value : null,
      innerHTML: el.innerHTML ? el.innerHTML.substring(0, 1000) : null,
      outerHTML: el.outerHTML ? el.outerHTML.substring(0, 1000) : null,
      isVisible: rect.width > 0 && rect.height > 0 && computed.visibility !== 'hidden' && computed.opacity !== '0',
      isClickable: el.onclick !== null || el.tagName === 'BUTTON' || el.tagName === 'A' || computed.cursor === 'pointer',
      children: Array.from(el.children).slice(0, 10).map(child => ({
        tag: child.tagName.toLowerCase(),
        id: child.id || null,
        text: child.innerText ? child.innerText.trim().substring(0, 50) : null
      }))
    };
  }

  async function waitForElement(selector, timeoutMs = 10000) {
    const startTime = Date.now();

    const checkElement = () => {
      return document.querySelector(selector);
    };

    let el = checkElement();
    if (el) {
      return { found: true, element: el.tagName.toLowerCase(), time: Date.now() - startTime };
    }

    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        const el = checkElement();
        if (el) {
          observer.disconnect();
          resolve({ found: true, element: el.tagName.toLowerCase(), time: Date.now() - startTime });
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => {
        observer.disconnect();
        const el = checkElement();
        if (el) {
          resolve({ found: true, element: el.tagName.toLowerCase(), time: Date.now() - startTime });
        } else {
          resolve({ found: false, timeout: true, elapsed: Date.now() - startTime });
        }
      }, timeoutMs);
    });
  }

  function captureViewport() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'captureViewport' }, (response) => {
        resolve(response);
      });
    });
  }
})();
