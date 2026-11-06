// content.js - Engine Ekstraksi Materi Iklan & YouTube di Google Ads Transparency Center

(function() {
  if (window.__ADSPY_CONTENT_SCRIPT_INITIALIZED__) return;
  window.__ADSPY_CONTENT_SCRIPT_INITIALIZED__ = true;

  var cachedXsrfToken = '';
  var interceptedCreatives = new Map();
  var interceptedSearchCards = [];

  function unescapeJsCode(code) {
    if (!code) return '';
    return code
      .replace(/\\x27/g, "'")
      .replace(/\\x22/g, '"')
      .replace(/\\x3a/g, ':')
      .replace(/\\x2f/g, '/')
      .replace(/\\x3d/g, '=')
      .replace(/\\x26/g, '&')
      .replace(/\\u0026/g, '&')
      .replace(/\\u003d/g, '=')
      .replace(/\\u003c/g, '<')
      .replace(/\\u003e/g, '>');
  }

  // 1. Tangkap pesan dari interceptor.js (MAIN world)
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return;

    if (event.data.type === 'ADSPY_XSRF_TOKEN' && event.data.token) {
      cachedXsrfToken = event.data.token;
    }

    if (event.data.type === 'ADSPY_INTERCEPTED_SEARCH') {
      const payload = event.data.payload;
      const items = payload?.['1'] || [];
      const newCards = [];
      if (Array.isArray(items)) {
        for (const it of items) {
          const advId = it?.['1'];
          const crId = it?.['2'];
          if (crId && crId.startsWith('CR')) {
            newCards.push({ advertiserId: advId || '', creativeId: crId });
          }
        }
      }
      if (newCards.length > 0) {
        interceptedSearchCards = newCards;
      }
    }

    if (event.data.type === 'ADSPY_INTERCEPTED_DATA') {
      const payload = event.data.payload;
      const cid = payload?.['1']?.['2'];
      if (cid) {
        interceptedCreatives.set(cid, payload);
      }
    }
  });

  function getAdvertiserIdFromUrl() {
    const m = location.pathname.match(/\/advertiser\/([^/]+)/);
    return m ? m[1] : '';
  }

  function getCreativeIdFromUrl() {
    const m = location.pathname.match(/\/advertiser\/([^/]+)\/creative\/([^/]+)/);
    if (m) return m[2];
    const m2 = location.pathname.match(/\/creative\/([^/]+)/);
    return m2 ? m2[1] : null;
  }

  function getXsrfTokenFromDom() {
    // 1. Dari atribut HTML yang diset interceptor
    const attrToken = document.documentElement.getAttribute('data-adspy-xsrf');
    if (attrToken) return attrToken;

    // 2. Dari cache event interceptor
    if (cachedXsrfToken) return cachedXsrfToken;

    // 3. Dari tag script FdrFJe
    const scripts = document.querySelectorAll('script');
    for (const s of scripts) {
      if (s.textContent && s.textContent.includes('FdrFJe')) {
        const m = s.textContent.match(/["']FdrFJe["']\s*:\s*["']([^"']+)["']/);
        if (m) return m[1];
      }
    }

    // 4. Broad regex di DOM
    try {
      const html = document.documentElement.innerHTML;
      const broadMatch = html.match(/FdrFJe["']?\s*[:=]\s*["']([^"'\s]+)["']/);
      if (broadMatch) return broadMatch[1];
    } catch (e) {}

    return '';
  }

  /**
   * Scan kartu iklan yang tampil di halaman
   */
  function scanCreativesOnPage() {
    const cards = [];
    const seenCids = new Set();
    const pageAdvId = getAdvertiserIdFromUrl();

    // 1. Dari RPC SearchCreatives yang di-intercept
    for (const sc of interceptedSearchCards) {
      if (!seenCids.has(sc.creativeId)) {
        seenCids.add(sc.creativeId);
        cards.push(sc);
      }
    }

    // 2. Dari link <a>
    document.querySelectorAll('a').forEach(a => {
      const href = a.href || a.getAttribute('href') || '';
      const fullMatch = href.match(/\/advertiser\/([^/]+)\/creative\/(CR[0-9]+)/);
      if (fullMatch) {
        const advId = fullMatch[1];
        const crId = fullMatch[2];
        if (!seenCids.has(crId)) {
          seenCids.add(crId);
          cards.push({ advertiserId: advId, creativeId: crId });
        }
      } else {
        const crMatch = href.match(/\/creative\/(CR[0-9]+)/);
        if (crMatch) {
          const crId = crMatch[1];
          if (!seenCids.has(crId)) {
            seenCids.add(crId);
            cards.push({ advertiserId: pageAdvId || '', creativeId: crId });
          }
        }
      }
    });

    // 3. Dari atribut elemen
    document.querySelectorAll('[data-creative-id], [creative-id], [id*="creative"], creative-preview').forEach(el => {
      const crId = el.getAttribute('data-creative-id') || el.getAttribute('creative-id');
      const advId = el.getAttribute('data-advertiser-id') || pageAdvId || '';
      if (crId && crId.startsWith('CR') && !seenCids.has(crId)) {
        seenCids.add(crId);
        cards.push({ advertiserId: advId, creativeId: crId });
      }
    });

    // 4. Dari Shadow DOM elemen (Web Components Google Ads)
    function scanShadowRoots(root) {
      if (!root) return;
      root.querySelectorAll('*').forEach(el => {
        if (el.shadowRoot) {
          el.shadowRoot.querySelectorAll('a, [data-creative-id], [creative-id], creative-preview').forEach(child => {
            const href = child.href || child.getAttribute('href') || '';
            const m = href.match(/CR[0-9]{15,25}/);
            if (m && !seenCids.has(m[0])) {
              seenCids.add(m[0]);
              cards.push({ advertiserId: pageAdvId || '', creativeId: m[0] });
            }
            const cid = child.getAttribute('data-creative-id') || child.getAttribute('creative-id');
            if (cid && cid.startsWith('CR') && !seenCids.has(cid)) {
              seenCids.add(cid);
              cards.push({ advertiserId: pageAdvId || '', creativeId: cid });
            }
          });
          scanShadowRoots(el.shadowRoot);
        }
      });
    }
    scanShadowRoots(document);

    // 5. Fallback search di DOM HTML untuk advertiser/AR.../creative/CR...
    if (cards.length === 0) {
      const html = document.body.innerHTML;
      const pairMatches = html.matchAll(/\/advertiser\/([A-Za-z0-9_-]+)\/creative\/(CR[0-9]+)/g);
      for (const m of pairMatches) {
        const advId = m[1];
        const crId = m[2];
        if (!seenCids.has(crId)) {
          seenCids.add(crId);
          cards.push({ advertiserId: advId, creativeId: crId });
        }
      }
    }

    // 6. Fallback search untuk pola CR... apa saja di DOM
    if (cards.length === 0) {
      const html = document.body.innerHTML;
      const crMatches = html.match(/CR[0-9]{15,25}/g);
      const arMatch = html.match(/AR[0-9]{15,25}/);
      const fallbackAdv = arMatch ? arMatch[0] : (pageAdvId || '');
      if (crMatches) {
        crMatches.forEach(crId => {
          if (!seenCids.has(crId)) {
            seenCids.add(crId);
            cards.push({ advertiserId: fallbackAdv, creativeId: crId });
          }
        });
      }
    }

    let pageTitle = '';
    const headerEl = document.querySelector('h1, [class*="advertiser-name"], .header-title');
    if (headerEl && headerEl.textContent) {
      pageTitle = headerEl.textContent.trim().split('\n')[0].trim();
    }

    return {
      pageTitle: pageTitle || 'Pengiklan',
      advertiserId: cards[0]?.advertiserId || pageAdvId || '',
      cards: cards,
      creatives: cards.map(c => c.creativeId),
      totalCount: cards.length
    };
  }

  /**
   * Fetch creative via same-origin RPC di halaman
   */
  async function fetchCreativeSameOrigin(advertiserId, creativeId) {
    let xsrfToken = getXsrfTokenFromDom();

    if (!xsrfToken) {
      window.postMessage({ type: 'ADSPY_GET_XSRF_TOKEN' }, '*');
      await new Promise(r => setTimeout(r, 100));
      xsrfToken = getXsrfTokenFromDom();
    }

    const payload = { '1': advertiserId || '', '2': creativeId, '5': { '1': 1 } };
    const body = 'f.req=' + encodeURIComponent(JSON.stringify(payload));

    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
    };
    if (xsrfToken) {
      headers['X-Framework-Xsrf-Token'] = xsrfToken;
    }

    const endpoint = window.location.origin + '/anji/_/rpc/LookupService/GetCreativeById?authuser=0';
    let res = await fetch(endpoint, {
      method: 'POST',
      headers: headers,
      body: body,
      credentials: 'include'
    });

    if (!res.ok) {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'include'
      });
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    let text = await res.text();
    if (text.startsWith(")]}'")) text = text.substring(4);
    return JSON.parse(text);
  }

  /**
   * Parse preview JS dan payload creative
   */
  async function processCreativePayload(payload, creativeId) {
    const root = payload?.['1'] || {};
    const advertiserId = root?.['1'] || getAdvertiserIdFromUrl() || '';
    const crId = root?.['2'] || creativeId || '';
    const advertiserName = root?.['22']?.['1'] || 'Pengiklan';
    const variationItems = root?.['5'] || [];

    const previewUrls = [];
    for (const item of variationItems) {
      const pUrl = item?.['1']?.['4'];
      if (pUrl && !previewUrls.includes(pUrl)) {
        previewUrls.push(pUrl);
      }
    }

    const videosMap = new Map();
    const destinationUrls = new Set();
    const headlines = new Set();

    // 1. Scan payload string
    try {
      const payloadStr = JSON.stringify(root);
      const ytMatches = payloadStr.matchAll(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/|ytimg\.com\/vi\/)([a-zA-Z0-9_-]{11})/g);
      for (const m of ytMatches) {
        const vid = m[1];
        if (vid && !videosMap.has(vid)) {
          videosMap.set(vid, {
            videoId: vid,
            youtubeUrl: `https://www.youtube.com/watch?v=${vid}`,
            shortUrl: `https://youtu.be/${vid}`,
            thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
            destinationUrl: '',
            headline: '',
            creativeId: crId
          });
        }
      }
      const destMatches = payloadStr.matchAll(/destination_url['":\s]+(https?:\/\/[^'"\s\\]+)/g);
      for (const dm of destMatches) {
        destinationUrls.add(dm[1]);
      }
    } catch (e) {}

    // 2. Fetch preview JS
    if (previewUrls.length > 0) {
      await Promise.all(previewUrls.map(async (pUrl) => {
        try {
          const fullUrl = pUrl.startsWith('//') ? 'https:' + pUrl : pUrl;
          const pRes = await fetch(fullUrl);
          if (!pRes.ok) return;
          const rawJs = await pRes.text();
          const cleanCode = unescapeJsCode(rawJs);

          const videoIdMatch = cleanCode.match(/['"]?video_?id['"]\s*:\s*['"]([a-zA-Z0-9_-]{11})['"]/i) ||
                               cleanCode.match(/['"]?video_?videoId['"]\s*:\s*['"]([a-zA-Z0-9_-]{11})['"]/i) ||
                               cleanCode.match(/ytimg\.com\/vi\/([a-zA-Z0-9_-]{11})/) ||
                               cleanCode.match(/youtube\.com\/(?:embed|watch\?v=)([a-zA-Z0-9_-]{11})/) ||
                               cleanCode.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);

          const destMatch = cleanCode.match(/destination_url['":\s]+(https?:\/\/[^'"\s]+)/) ||
                            cleanCode.match(/['"]destination_url['"]\s*:\s*['"]([^'"]+)['"]/);

          const headlineMatch = cleanCode.match(/'headline':\s*'([^']+)'/) || cleanCode.match(/"headline":\s*"([^"]+)"/);

          if (destMatch) destinationUrls.add(destMatch[1]);
          if (headlineMatch) headlines.add(headlineMatch[1]);

          if (videoIdMatch) {
            const vid = videoIdMatch[1];
            const title = headlineMatch ? headlineMatch[1] : '';
            if (!videosMap.has(vid)) {
              videosMap.set(vid, {
                videoId: vid,
                youtubeUrl: `https://www.youtube.com/watch?v=${vid}`,
                shortUrl: `https://youtu.be/${vid}`,
                thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
                destinationUrl: destMatch ? destMatch[1] : '',
                headline: title,
                creativeId: crId
              });
            } else {
              const ex = videosMap.get(vid);
              if (!ex.destinationUrl && destMatch) ex.destinationUrl = destMatch[1];
              if (!ex.headline && title) ex.headline = title;
            }
          }
        } catch (e) {}
      }));
    }

    const firstDest = Array.from(destinationUrls)[0] || '';
    const videosList = Array.from(videosMap.values()).map(v => {
      if (!v.destinationUrl && firstDest) v.destinationUrl = firstDest;
      return v;
    });

    return {
      advertiserId,
      advertiserName,
      creativeId: crId,
      videos: videosList,
      destinationUrls: Array.from(destinationUrls),
      headlines: Array.from(headlines)
    };
  }

  async function handlePopupRequest(advertiserId, creativeId) {
    if (interceptedCreatives.has(creativeId)) {
      const processed = await processCreativePayload(interceptedCreatives.get(creativeId), creativeId);
      if (processed && processed.videos.length > 0) {
        return processed;
      }
    }

    try {
      const rawData = await fetchCreativeSameOrigin(advertiserId, creativeId);
      if (rawData) {
        interceptedCreatives.set(creativeId, rawData);
        const result = await processCreativePayload(rawData, creativeId);
        return result;
      }
    } catch (err) {
      console.warn('Same-origin fetch failed for creative:', creativeId, err);
    }

    throw new Error(`Tidak dapat memuat data materi iklan ${creativeId}`);
  }

  /**
   * Batch extraction untuk banyak kartu iklan
   */
  async function handleBatchExtractInPage(cards) {
    const combinedVideos = [];
    const seenVideoIds = new Set();
    const limit = cards.length;
    const CONCURRENCY = 6;
    let nextIdx = 0;

    async function worker() {
      while (nextIdx < limit) {
        const i = nextIdx++;
        const card = cards[i];
        try {
          let rawData = interceptedCreatives.get(card.creativeId);
          if (!rawData) {
            rawData = await fetchCreativeSameOrigin(card.advertiserId || '', card.creativeId);
            if (rawData) interceptedCreatives.set(card.creativeId, rawData);
          }

          if (rawData) {
            const res = await processCreativePayload(rawData, card.creativeId);
            if (res && res.videos && res.videos.length > 0) {
              res.videos.forEach(v => {
                if (!seenVideoIds.has(v.videoId)) {
                  seenVideoIds.add(v.videoId);
                  v.advertiserName = res.advertiserName;
                  v.advertiserId = res.advertiserId || card.advertiserId;
                  combinedVideos.push(v);
                }
              });
            }
          }
        } catch (err) {
          console.warn('Batch extract error on card:', card.creativeId, err);
        }
      }
    }

    const workers = [];
    for (let w = 0; w < Math.min(CONCURRENCY, limit); w++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    return {
      videos: combinedVideos,
      totalScanned: cards.length
    };
  }

  // 2. Listener pesan dari Sidebar
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'extract_all_page_videos') {
      (async () => {
        try {
          const pageData = scanCreativesOnPage();
          const cards = pageData.cards || [];
          const limit = request.limit || 50;
          const targetCards = cards.slice(0, limit);

          const batchRes = await handleBatchExtractInPage(targetCards);
          sendResponse({
            success: true,
            videos: batchRes.videos || [],
            totalCards: cards.length,
            pageTitle: pageData.pageTitle
          });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    if (request.action === 'get_current_creative_data') {
      handlePopupRequest(request.advertiserId, request.creativeId)
        .then(data => sendResponse({ success: true, data }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    if (request.action === 'batch_extract_in_page') {
      handleBatchExtractInPage(request.cards || [])
        .then(res => sendResponse({ success: true, ...res }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    if (request.action === 'get_creatives_from_page') {
      sendResponse(scanCreativesOnPage());
      return true;
    }

    if (request.action === 'get_xsrf_token') {
      sendResponse({ token: getXsrfTokenFromDom() });
      return true;
    }
  });

})();
