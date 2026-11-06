// interceptor.js - Injected into MAIN world to intercept page RPC traffic & capture auth tokens
(function() {
  if (window.__ADSPY_INTERCEPTOR_INITIALIZED__) return;
  window.__ADSPY_INTERCEPTOR_INITIALIZED__ = true;
  window.__ADSPY_CREATIVES__ = window.__ADSPY_CREATIVES__ || {};
  window.__ADSPY_SEARCH_RESULTS__ = null;
  window.__ADSPY_XSRF_TOKEN__ = null;

  function setXsrfToken(token) {
    if (token && typeof token === 'string' && token.length > 5) {
      window.__ADSPY_XSRF_TOKEN__ = token;
      try {
        document.documentElement.setAttribute('data-adspy-xsrf', token);
      } catch (e) {}
      window.postMessage({ type: 'ADSPY_XSRF_TOKEN', token }, '*');
    }
  }

  function findXsrfTokenInWindow() {
    if (window.WIZ_global_data && window.WIZ_global_data.FdrFJe) {
      return window.WIZ_global_data.FdrFJe;
    }
    if (window._FdrFJe) {
      return window._FdrFJe;
    }
    if (window.WIZ_global_data) {
      for (const k of Object.keys(window.WIZ_global_data)) {
        const val = window.WIZ_global_data[k];
        if (typeof val === 'string' && val.length > 15 && val.length < 80 && /^[A-Za-z0-9_-]+$/.test(val)) {
          if (k.toLowerCase().includes('xsrf') || k === 'FdrFJe' || k === 'cfb2h') {
            return val;
          }
        }
      }
    }
    const scripts = document.querySelectorAll('script');
    for (const s of scripts) {
      if (s.textContent && s.textContent.includes('FdrFJe')) {
        const m = s.textContent.match(/["']FdrFJe["']\s*:\s*["']([^"']+)["']/);
        if (m) return m[1];
      }
    }
    return null;
  }

  // Periodic and event checks for token
  const initial = findXsrfTokenInWindow();
  if (initial) setXsrfToken(initial);

  document.addEventListener('DOMContentLoaded', () => {
    const dToken = findXsrfTokenInWindow();
    if (dToken) setXsrfToken(dToken);
  });

  let checkCount = 0;
  const tokenTimer = setInterval(() => {
    checkCount++;
    const t = findXsrfTokenInWindow();
    if (t) {
      setXsrfToken(t);
      clearInterval(tokenTimer);
    } else if (checkCount > 30) {
      clearInterval(tokenTimer);
    }
  }, 200);

  // Listen for request for token from content.js
  window.addEventListener('message', (ev) => {
    if (ev.data && ev.data.type === 'ADSPY_GET_XSRF_TOKEN') {
      const cur = window.__ADSPY_XSRF_TOKEN__ || findXsrfTokenInWindow();
      if (cur) setXsrfToken(cur);
    }
  });

  function processText(url, text) {
    if (!text || typeof text !== 'string') return;

    let cleanText = text;
    if (cleanText.startsWith(")]}'")) {
      cleanText = cleanText.substring(4);
    }

    // 1. Intercept SearchCreatives (Search & Catalog pages)
    if (url.includes('SearchCreatives')) {
      try {
        const data = JSON.parse(cleanText);
        window.__ADSPY_SEARCH_RESULTS__ = data;
        window.postMessage({
          type: 'ADSPY_INTERCEPTED_SEARCH',
          url,
          payload: data
        }, '*');
      } catch (e) {}
    }

    // 2. Intercept GetCreativeById (Creative detail pages)
    if (url.includes('GetCreativeById') || text.includes('displayads-formats.googleusercontent.com')) {
      try {
        const data = JSON.parse(cleanText);
        const crId = data?.['1']?.['2'];
        if (crId) {
          window.__ADSPY_CREATIVES__[crId] = data;
        }
        window.postMessage({
          type: 'ADSPY_INTERCEPTED_DATA',
          url,
          payload: data
        }, '*');
      } catch (e) {}
    }
  }

  // Intercept fetch
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    try {
      const init = args[1];
      if (init && init.headers) {
        let t = null;
        if (init.headers instanceof Headers) {
          t = init.headers.get('x-framework-xsrf-token') || init.headers.get('X-Framework-Xsrf-Token');
        } else if (Array.isArray(init.headers)) {
          const entry = init.headers.find(([k]) => k.toLowerCase() === 'x-framework-xsrf-token');
          if (entry) t = entry[1];
        } else if (typeof init.headers === 'object') {
          for (const key of Object.keys(init.headers)) {
            if (key.toLowerCase() === 'x-framework-xsrf-token') {
              t = init.headers[key];
              break;
            }
          }
        }
        if (t) setXsrfToken(t);
      }
    } catch (e) {}

    const response = await originalFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
      if (url.includes('GetCreativeById') || url.includes('SearchCreatives')) {
        const clone = response.clone();
        clone.text().then(txt => processText(url, txt)).catch(() => {});
      }
    } catch (e) {}
    return response;
  };

  // Intercept XMLHttpRequest
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._adspy_req_url = String(url);
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
    if (header && header.toLowerCase() === 'x-framework-xsrf-token' && value) {
      setXsrfToken(value);
    }
    return originalSetHeader.call(this, header, value);
  };

  XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener('load', function() {
      if (this._adspy_req_url && (this._adspy_req_url.includes('GetCreativeById') || this._adspy_req_url.includes('SearchCreatives'))) {
        processText(this._adspy_req_url, this.responseText);
      }
    });
    return originalSend.apply(this, args);
  };
})();
