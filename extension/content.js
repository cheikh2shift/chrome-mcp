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
            return extractContent(message.selector, message.options || {});

          case 'get_page_source':
            return getPageSource(message.offset || 0, message.limit || 500);

          case 'find_elements':
            return findElements(message.selector, message.selector_type, message.offset, message.limit);

          case 'get_element_details':
            return getElementDetails(message.selector);

          case 'wait_for_element':
            return waitForElement(message.selector, message.timeout_ms);

          case 'capture_viewport':
            return captureViewport();

          case 'ping':
            return { type: 'pong', loaded: true, url: window.location.href };

          case 'search_text':
            return searchText(message.pattern, message.options);

          case 'get_visible_elements':
            return getVisibleElements(message.options);

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

  function extractContent(selector, options = {}) {
    const {
      offset = 0,
      limit = 500,
      headingsLimit = 20,
      linksLimit = 50,
      formsLimit = 10,
      buttonsLimit = 30,
      imagesLimit = 20
    } = options;

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

    const allHeadings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6')).map(h => ({
      level: parseInt(h.tagName[1]),
      text: h.innerText.trim().substring(0, 200)
    }));

    const allLinks = Array.from(root.querySelectorAll('a[href]')).map(a => ({
      text: a.innerText.trim().substring(0, 100),
      href: a.href
    }));

    const allForms = Array.from(document.querySelectorAll('form')).map(f => ({
      action: f.action,
      method: f.method.toUpperCase(),
      inputs: Array.from(f.querySelectorAll('input, textarea, select')).slice(0, 30).map(i => ({
        type: i.type || i.tagName.toLowerCase(),
        name: i.name || null,
        placeholder: i.placeholder || null,
        required: i.required || false
      }))
    }));

    const allButtons = Array.from(root.querySelectorAll('button')).map(b => ({
      text: b.innerText.trim().substring(0, 100),
      type: b.type || 'submit',
      disabled: b.disabled
    }));

    const allImages = Array.from(root.querySelectorAll('img[src]')).map(img => ({
      alt: img.alt || '',
      src: img.src,
      width: img.naturalWidth,
      height: img.naturalHeight
    }));

    const fullText = getText(root);
    const textWindow = fullText.substring(offset, offset + limit);
    const textTruncated = (offset + limit) < fullText.length;

    const result = {
      title: document.title,
      url: window.location.href,
      text: textWindow,
      textOffset: offset,
      textLimit: limit,
      textTotal: fullText.length,
      textTruncated: textTruncated,
      headings: {
        total: allHeadings.length,
        offset: 0,
        limit: headingsLimit,
        items: allHeadings.slice(0, headingsLimit)
      },
      links: {
        total: allLinks.length,
        offset: 0,
        limit: linksLimit,
        items: allLinks.slice(0, linksLimit)
      },
      forms: {
        total: allForms.length,
        offset: 0,
        limit: formsLimit,
        items: allForms.slice(0, formsLimit)
      },
      buttons: {
        total: allButtons.length,
        offset: 0,
        limit: buttonsLimit,
        items: allButtons.slice(0, buttonsLimit)
      },
      images: {
        total: allImages.length,
        offset: 0,
        limit: imagesLimit,
        items: allImages.slice(0, imagesLimit)
      }
    };

    return result;
  }

  function getPageSource(offset = 0, limit = 50000) {
    let html = document.documentElement.outerHTML;
    const totalLength = html.length;
    if (offset >= totalLength) {
      return {
        html: '',
        offset: offset,
        limit: limit,
        total: totalLength,
        truncated: false
      };
    }
    let result = html.substring(offset, offset + limit);
    const truncated = (offset + limit) < totalLength;
    if (truncated) {
      result += '\n\n[Truncated - use offset=' + (offset + limit) + ' to continue]';
    }
    return {
      html: result,
      offset: offset,
      limit: limit,
      total: totalLength,
      truncated: truncated
    };
  }

  function findElements(selector, selectorType = 'css', offset = 0, limit = 20) {
    if (!selector || selector.trim() === '') {
      return { error: 'Selector is required' };
    }
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

    const total = elements.length;
    const startIndex = Math.min(offset, total);
    const endIndex = Math.min(startIndex + limit, total);
    const slicedElements = elements.slice(startIndex, endIndex);
    const results = [];

    for (let i = 0; i < slicedElements.length; i++) {
      const el = slicedElements[i];
      const globalIndex = startIndex + i;
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
        index: globalIndex,
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
      total: total,
      offset: offset,
      limit: limit,
      count: results.length,
      elements: results
    };
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
    if (!selector || selector.trim() === '') {
      return { error: 'Selector is required' };
    }
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

  function searchText(pattern, options = {}) {
    const {
      caseSensitive = false,
      wholeWord = false,
      regex = false,
      maxResults = 20,
      offset = 0,
      limit = 20
    } = options;

    let searchPattern;
    if (regex) {
      try {
        searchPattern = new RegExp(pattern, caseSensitive ? 'g' : 'gi');
      } catch (e) {
        return { error: `Invalid regex: ${e.message}` };
      }
    } else {
      let escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (wholeWord) {
        escaped = `\\b${escaped}\\b`;
      }
      searchPattern = new RegExp(escaped, caseSensitive ? 'g' : 'gi');
    }

    function isVisible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0'
      );
    }

    const safeMaxResults = Math.max(1, Math.min(200, maxResults));
    const snippetPad = 30;
    const nodeScanLimit = Math.max(1000, safeMaxResults * 200);
    const allResults = [];
    const treeWalker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          if (node.parentElement) {
            const tag = node.parentElement.tagName.toLowerCase();
            if (['script', 'style', 'noscript', 'iframe', 'textarea'].includes(tag)) {
              return NodeFilter.FILTER_REJECT;
            }
            if (!isVisible(node.parentElement)) {
              return NodeFilter.FILTER_REJECT;
            }
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let node;
    let totalMatches = 0;
    let nodesVisited = 0;
    let truncated = false;
    while ((node = treeWalker.nextNode())) {
      nodesVisited++;
      if (nodesVisited >= nodeScanLimit) {
        truncated = true;
        break;
      }
      const text = node.textContent || '';
      let match;
      searchPattern.lastIndex = 0;
      while ((match = searchPattern.exec(text)) !== null) {
        totalMatches++;
        if (allResults.length < safeMaxResults) {
          const snippetStart = Math.max(0, match.index - snippetPad);
          const snippetEnd = Math.min(text.length, match.index + match[0].length + snippetPad);
          const snippet = text.substring(snippetStart, snippetEnd);
          allResults.push({
            index: allResults.length,
            snippet,
            match: match[0],
            position: match.index,
            parentTag: node.parentElement?.tagName.toLowerCase() || 'unknown',
            parentId: node.parentElement?.id || null
          });
        }
      }
      if (allResults.length >= safeMaxResults && totalMatches >= safeMaxResults) {
        break;
      }
    }

    const paginatedResults = allResults.slice(offset, offset + limit);

    return {
      count: paginatedResults.length,
      totalMatches: totalMatches,
      offset: offset,
      limit: limit,
      pattern: pattern,
      truncated: truncated || totalMatches > paginatedResults.length,
      results: paginatedResults
    };
  }

  function getVisibleElements(options = {}) {
    const {
      maxElements = 40,
      offset = 0,
      limit = maxElements,
      minTextLength = 1,
      includeHeadings = true,
      includeLinks = true,
      includeButtons = true,
      includeInputs = true,
      includeImages = true
    } = options;

    const results = [];
    const seen = new Set();
    const safeOffset = Math.max(0, Number(offset) || 0);
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || maxElements || 40));
    const scanCap = Math.max(safeOffset + safeLimit, safeLimit);

    function isVisible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0'
      );
    }

    function getPath(el) {
      const path = [];
      while (el && el.nodeType === Node.ELEMENT_NODE) {
        let selector = el.tagName.toLowerCase();
        if (el.id) {
          selector += `#${el.id}`;
        } else if (el.className && typeof el.className === 'string') {
          const classes = el.className.trim().split(/\s+/).slice(0, 2);
          if (classes.length > 0 && classes[0]) {
            selector += `.${classes.join('.')}`;
          }
        }
        path.unshift(selector);
        el = el.parentElement;
      }
      return path.join(' > ');
    }

    if (includeHeadings) {
      ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].forEach((tag) => {
        if (results.length >= scanCap) return;
        document.querySelectorAll(tag).forEach((el) => {
          if (results.length >= scanCap) return;
          if (isVisible(el) && !seen.has(el)) {
            const text = el.innerText?.trim();
            if (text && text.length >= minTextLength) {
              seen.add(el);
              results.push({
                type: 'heading',
                level: parseInt(tag[1]),
                text: text.substring(0, 500),
                selector: tag,
                path: getPath(el),
                rect: boundingRect(el)
              });
            }
          }
        });
      });
    }

    if (includeLinks) {
      document.querySelectorAll('a[href]').forEach((el) => {
        if (results.length >= scanCap) return;
        if (isVisible(el) && !seen.has(el)) {
          const text = el.innerText?.trim();
          if (text && text.length >= minTextLength) {
            seen.add(el);
            results.push({
              type: 'link',
              text: text.substring(0, 200),
              href: el.href,
              selector: getSelector(el),
              path: getPath(el),
              rect: boundingRect(el)
            });
          }
        }
      });
    }

    if (includeButtons) {
      document.querySelectorAll('button, [role="button"]').forEach((el) => {
        if (results.length >= scanCap) return;
        if (isVisible(el) && !seen.has(el)) {
          const text = el.innerText?.trim() || el.value?.trim() || el.ariaLabel?.trim();
          if (text && text.length >= minTextLength) {
            seen.add(el);
            results.push({
              type: 'button',
              text: text.substring(0, 200),
              disabled: el.disabled,
              selector: getSelector(el),
              path: getPath(el),
              rect: boundingRect(el)
            });
          }
        }
      });
    }

    if (includeInputs) {
      document.querySelectorAll('input, textarea, select').forEach((el) => {
        if (results.length >= scanCap) return;
        if (isVisible(el) && !seen.has(el)) {
          const label = getInputLabel(el);
          const value = el.value || '';
          if (label || el.type !== 'hidden') {
            seen.add(el);
            results.push({
              type: el.tagName.toLowerCase(),
              inputType: el.type,
              label: label.substring(0, 200),
              value: value.substring(0, 100),
              placeholder: el.placeholder || null,
              selector: getSelector(el),
              path: getPath(el),
              rect: boundingRect(el)
            });
          }
        }
      });
    }

    if (includeImages) {
      document.querySelectorAll('img').forEach((el) => {
        if (results.length >= scanCap) return;
        if (isVisible(el) && !seen.has(el) && el.src) {
          seen.add(el);
          results.push({
            type: 'image',
            alt: el.alt || '',
            src: el.src,
            selector: getSelector(el),
            path: getPath(el),
            rect: boundingRect(el)
          });
        }
      });
    }

    const textElements = document.querySelectorAll('p, span, div, li, td, th, label, article, section');
    textElements.forEach((el) => {
      if (results.length >= scanCap) return;
      if (isVisible(el) && !seen.has(el)) {
        const text = el.innerText?.trim();
        if (text && text.length >= minTextLength && text.length < 1000) {
          const style = window.getComputedStyle(el);
          const fontSize = parseFloat(style.fontSize);
          if (fontSize >= 12) {
            seen.add(el);
            results.push({
              type: 'text',
              text: text.substring(0, 500),
              tag: el.tagName.toLowerCase(),
              selector: getSelector(el),
              path: getPath(el),
              rect: boundingRect(el)
            });
          }
        }
      }
    });

    const pagedElements = results.slice(safeOffset, safeOffset + safeLimit);

    return {
      count: pagedElements.length,
      total: results.length,
      offset: safeOffset,
      limit: safeLimit,
      truncated: results.length > (safeOffset + safeLimit),
      elements: pagedElements,
      url: window.location.href,
      title: document.title
    };
  }

  function getSelector(el) {
    if (el.id) return `#${el.id}`;
    let selector = el.tagName.toLowerCase();
    if (el.className && typeof el.className === 'string') {
      const cls = el.className.trim().split(/\s+/)[0];
      if (cls) selector += `.${cls}`;
    }
    return selector;
  }

  function boundingRect(el) {
    const rect = el.getBoundingClientRect();
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  }

  function getInputLabel(el) {
    if (el.id) {
      const label = document.querySelector(`label[for="${el.id}"]`);
      if (label) return label.innerText?.trim() || '';
    }
    const parent = el.closest('label');
    if (parent) return parent.innerText?.trim() || '';
    if (el.name) {
      const label = document.querySelector(`label[for="${el.name}"]`);
      if (label) return label.innerText?.trim() || '';
    }
    return el.ariaLabel || el.placeholder || '';
  }
})();
