let scrapedUrls = [];

// Helper escape HTML untuk keamanan tampilan
function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

document.addEventListener('DOMContentLoaded', () => {
  const themeSelect = document.getElementById('themeSelect');
  const btnRefreshDate = document.getElementById('btnRefreshDate');
  const btnScrape = document.getElementById('btnScrape');
  const btnStopScrape = document.getElementById('btnStopScrape');
  const btnDashboard = document.getElementById('btnDashboard');
  const btnClear = document.getElementById('btnClear');
  const btnCopyAll = document.getElementById('btnCopyAll');

  // 1. Simpan & Muat Tema Tersimpan
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['selectedTheme'], (res) => {
      if (res && res.selectedTheme && themeSelect) {
        themeSelect.value = res.selectedTheme;
        document.body.className = res.selectedTheme;
        themeSelect.dispatchEvent(new Event('change'));
      }
    });
  }

  if (themeSelect) {
    themeSelect.addEventListener('change', (e) => {
      document.body.className = e.target.value;
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ selectedTheme: e.target.value });
      }
    });
  }

  // 2. Tarik Tanggal Saat Dibuka
  fetchDateFromPage();

  if (btnRefreshDate) {
    btnRefreshDate.addEventListener('click', fetchDateFromPage);
  }

  // 3. Tombol Buka Dashboard
  if (btnDashboard) {
    btnDashboard.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
    });
  }

  // 4. Tombol Bersihkan Semua Data
  if (btnClear) {
    btnClear.addEventListener('click', () => {
      const yakin = confirm("Yakin ingin mengosongkan seluruh database? Data dashboard juga akan tereset.");
      if (!yakin) return;

      scrapedUrls = [];
      chrome.storage.local.remove('adsScannerData', () => {
        const urlListDiv = document.getElementById('urlList');
        if (urlListDiv) {
          urlListDiv.innerHTML = '<div class="status-text" style="color: #10b981;">Database berhasil dikosongkan. Siap untuk sesi baru!</div>';
        }
        if (btnCopyAll) btnCopyAll.style.display = 'none';
        const countBadge = document.getElementById('countBadge');
        if (countBadge) countBadge.style.display = 'none';
        if (btnScrape) btnScrape.innerHTML = '▶ Mulai Scan';

        if (typeof chrome !== 'undefined' && chrome.action && chrome.action.setBadgeText) {
          chrome.action.setBadgeText({ text: '' });
        }
      });
    });
  }

  // 5. Tombol Salin Semua Link
  if (btnCopyAll) {
    btnCopyAll.addEventListener('click', (e) => {
      if (scrapedUrls.length > 0) {
        navigator.clipboard.writeText(scrapedUrls.join('\n'));
        const originalHTML = e.currentTarget.innerHTML;
        e.currentTarget.innerHTML = `✅ Copied!`;
        setTimeout(() => { e.currentTarget.innerHTML = originalHTML; }, 2000);
      }
    });
  }

  // Tombol Stop Auto-scroll
  if (btnStopScrape) {
    btnStopScrape.addEventListener('click', async () => {
      btnStopScrape.innerHTML = 'Menghentikan...';
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs && tabs[0] && tabs[0].id) {
        chrome.scripting.executeScript({
          target: { tabId: tabs[0].id },
          func: () => { window.__stopAutoScroll = true; }
        });
      }
    });
  }

  // 6. Tombol Mulai Scan
  if (btnScrape) {
    btnScrape.addEventListener('click', async () => {
      const urlListDiv = document.getElementById('urlList');
      const autoScrollCheck = document.getElementById('autoScrollCheck');
      const extractYoutubeCheck = document.getElementById('extractYoutubeCheck');
      const inputDate = document.getElementById('inputDate');

      btnScrape.innerHTML = 'Mendeteksi Tanggal...';
      if (urlListDiv) {
        urlListDiv.innerHTML = `<div style="text-align:center; padding: 20px; font-size: 13px;">Sedang mencocokkan tanggal...</div>`;
      }

      await fetchDateFromPage();
      await new Promise(resolve => setTimeout(resolve, 300));

      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs || tabs.length === 0 || !tabs[0].id) {
        btnScrape.innerHTML = '▶ Mulai Scan';
      btnScrape.disabled = false;
        btnScrape.disabled = false;
        if (urlListDiv) urlListDiv.innerHTML = `<div style="color: #ef4444; font-size: 12px; text-align:center;">Tab aktif tidak ditemukan.</div>`;
        return;
      }

      const activeTab = tabs[0];
      
      // Validasi tab aktif: pastikan pengguna berada di Google Ads Transparency
      if (!activeTab.url || !activeTab.url.includes('adstransparency.google.com')) {
        btnScrape.innerHTML = '▶ Mulai Scan';
      btnScrape.disabled = false;
        btnScrape.disabled = false;
        if (urlListDiv) {
          urlListDiv.innerHTML = `
            <div style="color: #ef4444; font-size: 12px; text-align:center; padding: 20px;">
              <div style="font-size: 24px; margin-bottom: 8px;">⚠️</div>
              <div style="font-weight: 700; margin-bottom: 4px;">Bukan Halaman Google Ads Transparency</div>
              <div style="color: var(--muted); font-size: 11px; line-height: 1.5;">Silakan klik/buka tab Google Ads Transparency di browser Anda, lalu klik tombol Mulai Scan kembali.</div>
            </div>
          `;
        }
        return;
      }

      btnScrape.disabled = true;
      const isAutoScroll = autoScrollCheck ? autoScrollCheck.checked : false;
      const isExtractYoutube = extractYoutubeCheck ? extractYoutubeCheck.checked : true;
      const scanDate = (inputDate && inputDate.value) ? inputDate.value.trim() : "Tanpa Tanggal";

      if (btnCopyAll) btnCopyAll.style.display = 'none';
      const countBadge = document.getElementById('countBadge');
      if (countBadge) countBadge.style.display = 'none';
      scrapedUrls = [];

      // Langkah 1: Jalankan Auto-scroll HANYA di frame utama jika diaktifkan
      if (isAutoScroll) {
        btnScrape.style.display = 'none';
        if (btnStopScrape) {
          btnStopScrape.style.display = 'flex';
          btnStopScrape.innerHTML = '⏹ Stop & Ambil Sekarang';
        }

        if (urlListDiv) {
          urlListDiv.innerHTML = `
            <div style="text-align:center; padding: 20px; font-size: 13px;">
              <div style="margin-bottom: 8px;">⏳ Sedang auto-scroll memuat seluruh iklan...</div>
              <div style="font-size: 11px; opacity: 0.7;">Klik tombol "Stop" di atas kapan saja untuk langsung mengambil data saat ini.</div>
            </div>
          `;
        }

        try {
          await chrome.scripting.executeScript({
            target: { tabId: activeTab.id },
            func: performAutoScroll
          });
          await new Promise(r => setTimeout(r, 400));
        } catch (scrollErr) {
          console.warn("Auto-scroll notice:", scrollErr);
        } finally {
          if (btnStopScrape) btnStopScrape.style.display = 'none';
          btnScrape.style.display = 'flex';
        }
      }

      // Langkah 2: Ekstraksi Link ke Semua Frame (Top Window + Seluruh Iframe)
      btnScrape.innerHTML = 'Mengekstrak Landing Page...';
      if (urlListDiv) {
        urlListDiv.innerHTML = `<div style="text-align:center; padding: 20px; font-size: 13px;">Sedang mengekstrak URL landing page dari semua elemen & iframe...</div>`;
      }

      let results = [];
      try {
        results = await chrome.scripting.executeScript({
          target: { tabId: activeTab.id, allFrames: true },
          func: scrapeDeepLinks
        });
      } catch (err) {
        console.warn("Deep link scrape error:", err);
      }

      const urlFrequency = {};
      let detectedAdvertiser = "";
      const directFramePairs = [];

      if (results && results.length > 0) {
        results.forEach(frameResult => {
          if (frameResult && frameResult.result) {
            const res = frameResult.result;
            const urls = Array.isArray(res) ? res : (res.urls || []);
            if (res.advertiser && !detectedAdvertiser) {
              detectedAdvertiser = res.advertiser;
            }
            urls.forEach(url => {
              urlFrequency[url] = (urlFrequency[url] || 0) + 1;
            });
            if (Array.isArray(res.pairs)) {
              res.pairs.forEach(p => directFramePairs.push(p));
            }
          }
        });
      }

      // Daftar landing page unik yang muncul di halaman
      const targetLandingUrls = Object.keys(urlFrequency);

      // Langkah 3: Ekstraksi Video YouTube Langsung di Tab via Same-Origin RPC Engine
      let ytList = [];

      if (isExtractYoutube) {
        btnScrape.innerHTML = 'Memindai Video YouTube...';
        if (urlListDiv) {
          urlListDiv.innerHTML = `
            <div style="text-align:center; padding: 20px; font-size: 13px;">
              <div style="margin-bottom: 6px;">⏳ Sedang membongkar video YouTube untuk ${targetLandingUrls.length} produk unik...</div>
              <div style="font-size: 11px; opacity: 0.7;">Memindai seluruh kartu materi iklan Google Ads tanpa batas...</div>
            </div>
          `;
        }

        try {
          const [tabExec] = await chrome.scripting.executeScript({
            target: { tabId: activeTab.id },
            func: extractAllCreativeVideosInPage,
            args: [targetLandingUrls]
          });

          if (tabExec?.result && Array.isArray(tabExec.result.videos)) {
            ytList = tabExec.result.videos;
            if (tabExec.result.advertiser && !detectedAdvertiser) {
              detectedAdvertiser = tabExec.result.advertiser;
            }
          }
        } catch (ytErr) {
          console.warn("In-page YouTube extraction notice:", ytErr);
        }
      }

      btnScrape.innerHTML = '▶ Mulai Scan';
      btnScrape.disabled = false;

      // Gabungkan pasangan video langsung yang didapat dari dalam iframe
      if (directFramePairs.length > 0) {
        const existingVids = new Set(ytList.map(v => v.videoId));
        directFramePairs.forEach(p => {
          if (p.videoId && !existingVids.has(p.videoId)) {
            existingVids.add(p.videoId);
            ytList.push({
              creativeId: '',
              videoId: p.videoId,
              youtubeUrl: p.youtubeUrl,
              thumbnail: p.thumbnail,
              destinationUrl: p.url,
              headline: '',
              advertiserName: detectedAdvertiser
            });
          }
        });
      }

      // Langkah 4: Penggabungan Cerdas Multi-Level (Landing Page + Video YouTube)
      const finalData = Object.entries(urlFrequency).sort((a, b) => b[1] - a[1]);

      // Buat mapping video bertingkat (Exact, Clean, Normalized, Base Domain + Slug, Slug)
      const ytMapExact = new Map();
      const ytMapClean = new Map();
      const ytMapNorm = new Map();
      const ytMapDomainSlug = new Map();
      const ytMapSlug = new Map();

      function normalizeUrlForMatch(u) {
        if (!u) return '';
        return u
          .split(/[?#]/)[0]
          .replace(/\/+$/, '')
          .toLowerCase()
          .replace(/^https?:\/\//, '')
          .replace(/^www\./, '');
      }

      function getBaseDomain(hostname) {
        if (!hostname) return '';
        const parts = hostname.toLowerCase().split('.');
        if (parts.length <= 2) return parts.join('.');
        if (['co.id', 'com.id', 'or.id', 'web.id', 'my.id'].some(d => hostname.endsWith(d))) {
          return parts.slice(-3).join('.');
        }
        return parts.slice(-2).join('.');
      }

      function getUrlSlug(urlStr) {
        try {
          const u = new URL(urlStr);
          const segs = u.pathname.split('/').filter(Boolean);
          if (segs.length === 0) return '';
          const last = segs[segs.length - 1].toLowerCase().replace(/\.(html|php|aspx)$/, '');
          return last.length >= 3 ? last : '';
        } catch (e) {
          return '';
        }
      }

      ytList.forEach(v => {
        if (v.destinationUrl) {
          ytMapExact.set(v.destinationUrl, v);

          const cleanD = v.destinationUrl.split(/[?#]/)[0].replace(/\/+$/, '').toLowerCase();
          ytMapClean.set(cleanD, v);

          const normD = normalizeUrlForMatch(v.destinationUrl);
          if (normD) ytMapNorm.set(normD, v);

          try {
            const u = new URL(v.destinationUrl);
            const bDom = getBaseDomain(u.hostname);
            const slug = getUrlSlug(v.destinationUrl);
            if (bDom && slug) {
              ytMapDomainSlug.set(`${bDom}:::${slug}`, v);
            }
            if (slug && !ytMapSlug.has(slug)) {
              ytMapSlug.set(slug, v);
            }
          } catch (e) {}
        }
      });

      const pairedVideoIds = new Set();

      chrome.storage.local.get(['adsScannerData'], (storage) => {
        const existingData = storage.adsScannerData || [];
        const dataMap = new Map();

        // 1. Muat data lama ke map
        existingData.forEach(item => {
          if (item && item.url) {
            const key = `${item.date || 'Tanpa Tanggal'}:::${item.url}`;
            dataMap.set(key, { ...item });
          }
        });

        // 2. Masukkan data landing page dari scrapeDeepLinks & pasangkan dengan Video YouTube
        finalData.forEach(([url, count]) => {
          const key = `${scanDate}:::${url}`;
          const cleanUrl = url.split(/[?#]/)[0].replace(/\/+$/, '').toLowerCase();
          const normUrl = normalizeUrlForMatch(url);

          // Cari pasangan video YouTube dengan 5 lapis kecocokan:
          let matchedYt = ytMapExact.get(url) || 
                          ytMapClean.get(cleanUrl) || 
                          ytMapNorm.get(normUrl);

          if (!matchedYt) {
            try {
              const u = new URL(url);
              const bDom = getBaseDomain(u.hostname);
              const slug = getUrlSlug(url);
              if (bDom && slug) {
                matchedYt = ytMapDomainSlug.get(`${bDom}:::${slug}`);
              }
              if (!matchedYt && slug) {
                matchedYt = ytMapSlug.get(slug);
              }
            } catch (e) {}
          }

          if (!matchedYt && ytList.length === 1 && !pairedVideoIds.has(ytList[0].videoId)) {
            matchedYt = ytList[0];
          }

          if (matchedYt) {
            pairedVideoIds.add(matchedYt.videoId);
          }

          const existingVal = dataMap.get(key);

          dataMap.set(key, {
            count: count,
            advertiser: detectedAdvertiser || (matchedYt ? matchedYt.advertiserName : "") || (existingVal?.advertiser || ""),
            youtubeUrl: matchedYt?.youtubeUrl || (existingVal?.youtubeUrl || ""),
            videoId: matchedYt?.videoId || (existingVal?.videoId || ""),
            thumbnail: matchedYt?.thumbnail || (existingVal?.thumbnail || ""),
            headline: matchedYt?.headline || (existingVal?.headline || "")
          });
        });

        // 3. Masukkan SEMUA video YouTube yang belum terpasangkan (JANGAN SAMPAI ADA YANG HILANG!)
        ytList.forEach(v => {
          if (!pairedVideoIds.has(v.videoId)) {
            pairedVideoIds.add(v.videoId);
            const targetUrl = v.destinationUrl || v.youtubeUrl;
            const key = `${scanDate}:::${targetUrl}`;
            const existingVal = dataMap.get(key);

            dataMap.set(key, {
              count: existingVal ? existingVal.count + 1 : 1,
              advertiser: v.advertiserName || detectedAdvertiser || (existingVal?.advertiser || ""),
              youtubeUrl: v.youtubeUrl,
              videoId: v.videoId,
              thumbnail: v.thumbnail || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
              headline: v.headline || (existingVal?.headline || "")
            });
          }
        });

        // 4. Susun array final untuk database
        const mergedData = Array.from(dataMap.entries()).map(([key, val]) => {
          const sep = key.indexOf(':::');
          const url = key.substring(sep + 3);
          let domain = "";
          try { domain = new URL(url).hostname; } catch (e) {}

          return {
            date: key.substring(0, sep),
            url: url,
            count: val.count,
            advertiser: val.advertiser,
            domain: domain,
            youtubeUrl: val.youtubeUrl,
            videoId: val.videoId,
            thumbnail: val.thumbnail,
            headline: val.headline
          };
        });

        chrome.storage.local.set({ adsScannerData: mergedData });

        // 5. Susun tampilan hasil untuk sesi scan saat ini di Sidebar
        const currentSessionEntries = Array.from(dataMap.entries())
          .filter(([key]) => key.startsWith(`${scanDate}:::`))
          .map(([key, val]) => {
            const sep = key.indexOf(':::');
            return {
              url: key.substring(sep + 3),
              ...val
            };
          })
          .sort((a, b) => b.count - a.count);

        scrapedUrls = currentSessionEntries.map(item => `${item.count}x ${item.url}${item.youtubeUrl ? ` | YT: ${item.youtubeUrl}` : ''}`);

        // Update icon badge di browser toolbar
        if (typeof chrome !== 'undefined' && chrome.action && chrome.action.setBadgeText) {
          chrome.action.setBadgeText({ text: String(currentSessionEntries.length) });
          chrome.action.setBadgeBackgroundColor({ color: '#4f46e5' });
        }

        if (urlListDiv) urlListDiv.innerHTML = '';

        if (currentSessionEntries.length > 0) {
          if (btnCopyAll) btnCopyAll.style.display = 'flex';
          if (countBadge) {
            countBadge.style.display = 'inline-block';
            countBadge.textContent = currentSessionEntries.length;
          }

          currentSessionEntries.forEach((item) => {
            const safeUrl = escapeHtml(item.url);
            let domain = '';
            try { domain = new URL(item.url).hostname; } catch (e) {}
            const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32` : '';

            const card = document.createElement('div');
            card.className = 'url-card';
            card.innerHTML = `
              <div class="url-content">
                <span class="url-count">${item.count}x</span>
                ${faviconUrl ? `<img src="${faviconUrl}" width="16" height="16" style="border-radius:3px; flex-shrink:0;" onerror="this.style.display='none'">` : ''}
                <div style="overflow:hidden; display:flex; flex-direction:column; gap:2px; flex-grow:1;">
                  <div class="url-text" title="${safeUrl}">${safeUrl}</div>
                  ${item.youtubeUrl ? `
                    <div style="display:flex; align-items:center; gap:6px; margin-top:2px;">
                      ${item.thumbnail ? `<img src="${escapeHtml(item.thumbnail)}" width="24" height="16" style="border-radius:2px; object-fit:cover; flex-shrink:0;">` : ''}
                      <a href="${escapeHtml(item.youtubeUrl)}" target="_blank" rel="noopener noreferrer" style="font-size:11px; color:#ef4444; font-weight:700; text-decoration:none; display:inline-flex; align-items:center; gap:4px;">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M10 15l5.19-3L10 9v6m11.56-7.83c.13.47.22 1.1.28 1.9.07.8.1 1.49.1 2.09L22 12c0 2.19-.16 3.8-.44 4.83-.25.9-.83 1.48-1.73 1.73-.47.13-1.33.22-2.65.28-1.3.07-2.49.1-3.59.1L12 19c-4.19 0-6.8-.16-7.83-.44-.9-.25-1.48-.83-1.73-1.73-.13-.47-.22-1.1-.28-1.9-.07-.8-.1-1.49-.1-2.09L2 12c0-2.19.16-3.8.44-4.83.25-.9.83-1.48 1.73-1.73z"/></svg>
                        Tonton Video YouTube ↗
                      </a>
                    </div>
                  ` : ''}
                </div>
              </div>
              <button class="btn-icon" title="Copy URL ini" type="button">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
              </button>
            `;

            const iconBtn = card.querySelector('.btn-icon');
            if (iconBtn) {
              iconBtn.addEventListener('click', (e) => {
                navigator.clipboard.writeText(`${item.count}x ${item.url}${item.youtubeUrl ? ` | ${item.youtubeUrl}` : ''}`);
                const targetBtn = e.currentTarget;
                targetBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
                setTimeout(() => {
                  targetBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
                }, 1500);
              });
            }

            if (urlListDiv) urlListDiv.appendChild(card);
          });
        } else {
          if (urlListDiv) {
            urlListDiv.innerHTML = '<div class="status-text">Target URL atau video tidak ditemukan di sesi ini.</div>';
          }
        }
      });
    });
  }
});

// FUNGSI DIEKSEKUSI LANGSUNG DI TAB UNTUK MEMBONGKAR VIDEO YOUTUBE DARI GOOGLE ADS RPC
async function extractAllCreativeVideosInPage(targetLandingUrls = []) {
  const seen = new Set();
  const cids = [];
  const advMatch = location.pathname.match(/\/advertiser\/([^/]+)/);
  const pAdv = advMatch ? advMatch[1] : '';

  // Helper pencatatan card
  function checkElement(el) {
    if (!el) return;
    const href = el.href || el.getAttribute('href') || '';
    if (href) {
      const fullMatch = href.match(/\/advertiser\/([^/]+)\/creative\/(CR[0-9]+)/);
      if (fullMatch) {
        const advId = fullMatch[1];
        const crId = fullMatch[2];
        if (!seen.has(crId)) {
          seen.add(crId);
          cids.push({ advertiserId: advId, creativeId: crId });
        }
      } else {
        const m = href.match(/creative\/(CR[0-9]+)/);
        if (m && !seen.has(m[1])) {
          seen.add(m[1]);
          cids.push({ advertiserId: pAdv, creativeId: m[1] });
        }
      }
    }

    const cid = el.getAttribute('data-creative-id') || el.getAttribute('creative-id');
    const advId = el.getAttribute('data-advertiser-id') || pAdv;
    if (cid && cid.startsWith('CR') && !seen.has(cid)) {
      seen.add(cid);
      cids.push({ advertiserId: advId, creativeId: cid });
    }
  }

  // 1. Recursive scan ke seluruh elemen DOM & Shadow DOM
  function scanTree(root) {
    if (!root) return;
    try {
      root.querySelectorAll('a, [data-creative-id], [creative-id], creative-preview').forEach(checkElement);
    } catch (e) {}

    try {
      const allEls = root.querySelectorAll('*');
      for (const el of allEls) {
        if (el.shadowRoot) {
          scanTree(el.shadowRoot);
        }
      }
    } catch (e) {}
  }
  scanTree(document);

  // 2. Scan dari intercepted data di window jika tersedia
  try {
    if (window.__ADSPY_CREATIVES__) {
      for (const cid of Object.keys(window.__ADSPY_CREATIVES__)) {
        if (cid && cid.startsWith('CR') && !seen.has(cid)) {
          seen.add(cid);
          cids.push({ advertiserId: pAdv, creativeId: cid });
        }
      }
    }
    if (window.__ADSPY_SEARCH_RESULTS__ && Array.isArray(window.__ADSPY_SEARCH_RESULTS__?.['1'])) {
      for (const it of window.__ADSPY_SEARCH_RESULTS__['1']) {
        const cid = it?.['2'];
        const adv = it?.['1'] || pAdv;
        if (cid && cid.startsWith('CR') && !seen.has(cid)) {
          seen.add(cid);
          cids.push({ advertiserId: adv, creativeId: cid });
        }
      }
    }
  } catch (e) {}

  // 3. Scan regex di DOM
  try {
    const crMatches = document.documentElement.innerHTML.match(/CR[0-9]{15,25}/g) || [];
    crMatches.forEach(cid => {
      if (!seen.has(cid)) {
        seen.add(cid);
        cids.push({ advertiserId: pAdv, creativeId: cid });
      }
    });
  } catch (e) {}

  // 4. Ambil XSRF Token (FdrFJe) secara berlapis & tangguh
  let token = document.documentElement.getAttribute('data-adspy-xsrf') || '';
  if (!token && window.WIZ_global_data && window.WIZ_global_data.FdrFJe) {
    token = window.WIZ_global_data.FdrFJe;
  }
  if (!token && window._FdrFJe) {
    token = window._FdrFJe;
  }
  if (!token) {
    const scripts = document.querySelectorAll('script');
    for (const s of scripts) {
      if (s.textContent && s.textContent.includes('FdrFJe')) {
        const m = s.textContent.match(/["']FdrFJe["']\s*:\s*["']([^"']+)["']/);
        if (m) { token = m[1]; break; }
      }
    }
  }
  if (!token) {
    try {
      const m = document.documentElement.innerHTML.match(/FdrFJe["']?\s*[:=]\s*["']([^"'\s]+)["']/);
      if (m) token = m[1];
    } catch (e) {}
  }

  // 5. Ekstraksi Paralel Cepat dengan 15 Concurrent Workers TANPA BATAS KARTU
  // Seluruh kartu iklan yang terdeteksi di halaman akan diproses!
  const targetCreatives = cids;
  const videos = [];
  const seenVids = new Set();
  let detectedPageAdv = '';
  let nextIdx = 0;
  const CONCURRENCY = 15;

  function isGoogleInternal(urlStr) {
    try {
      const h = new URL(urlStr).hostname.toLowerCase();
      return h.includes('google.') || h.endsWith('.google') || h.includes('gstatic.') ||
             h.includes('youtube.com') || h.includes('youtu.be') || h.includes('googleusercontent.com') ||
             h.includes('doubleclick.net') || h.includes('googletagmanager.com');
    } catch (e) {
      return false;
    }
  }

  function extractDestUrl(text) {
    if (!text) return '';
    const clean = text.replace(/\\\//g, '/').replace(/\x27/g, "'").replace(/\x22/g, '"');
    const paramMatches = [
      /(?:destination_url|destinationUrl|final_url|finalUrl|exit_url|exitUrl|landing_page_url|landing_page|click_url|adurl)['":\s]+(https?:\/\/[^'"\s\\<>]+)/i,
      /['"](?:destination_url|destinationUrl|final_url|exit_url|landing_page)['"]\s*:\s*['"](https?:\/\/[^'"\s\\<>]+)['"]/i
    ];
    for (const regex of paramMatches) {
      const m = clean.match(regex);
      if (m) {
        const u = m[1].replace(/[\\'"]+$/, '').trim();
        if (!isGoogleInternal(u)) return u;
      }
    }
    const allUrls = clean.match(/https?:\/\/[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[^\s'"<>\\]*/g) || [];
    for (const u of allUrls) {
      const trimmed = u.replace(/[\\'"]+$/, '').trim();
      if (!isGoogleInternal(trimmed)) {
        return trimmed;
      }
    }
    return '';
  }

  // Siapkan set slug dari targetLandingUrls untuk pemantauan kecocokan lengkap
  const targetSlugSet = new Set();
  (targetLandingUrls || []).forEach(u => {
    try {
      const segs = new URL(u).pathname.split('/').filter(Boolean);
      if (segs.length > 0) {
        const slug = segs[segs.length - 1].toLowerCase().replace(/\.(html|php|aspx)$/, '');
        if (slug.length >= 3) targetSlugSet.add(slug);
      }
    } catch (e) {}
  });

  const matchedSlugs = new Set();
  let shouldStopEarly = false;

  async function worker() {
    while (nextIdx < targetCreatives.length && !shouldStopEarly) {
      const item = targetCreatives[nextIdx++];
      try {
        let root = null;
        if (window.__ADSPY_CREATIVES__ && window.__ADSPY_CREATIVES__[item.creativeId]) {
          root = window.__ADSPY_CREATIVES__[item.creativeId]?.['1'] || {};
        }

        if (!root) {
          const payload = { '1': item.advertiserId || '', '2': item.creativeId, '5': { '1': 1 } };
          const body = 'f.req=' + encodeURIComponent(JSON.stringify(payload));
          const headers = { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' };
          if (token) headers['X-Framework-Xsrf-Token'] = token;

          const res = await fetch(window.location.origin + '/anji/_/rpc/LookupService/GetCreativeById?authuser=0', {
            method: 'POST',
            headers: headers,
            body: body,
            credentials: 'include'
          });

          if (!res.ok) continue;

          let text = await res.text();
          if (text.startsWith(")]}'")) text = text.substring(4);
          const json = JSON.parse(text);
          root = json?.['1'] || {};
        }

        const formatType = root?.['8'];
        // Format 1 (Text) atau Format 2 (Image) tidak memiliki video YouTube, lewati instan
        if (formatType && formatType !== 3) {
          continue;
        }

        const advName = root?.['22']?.['1'] || '';
        if (advName && !detectedPageAdv) detectedPageAdv = advName;

        const variationItems = root?.['5'] || [];
        const pUrls = variationItems.map(it => it?.['1']?.['4']).filter(Boolean);

        let videoId = '';
        let destinationUrl = '';
        let headline = '';

        // Cek langsung string JSON root
        const rawStr = JSON.stringify(root);
        const normRawStr = rawStr.replace(/\\\//g, '/');

        const rawYt = normRawStr.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/|ytimg\.com\/vi\/)([a-zA-Z0-9_-]{11})/);
        if (rawYt) videoId = rawYt[1];
        destinationUrl = extractDestUrl(normRawStr);

        // Cek skrip pratinjau displayads-formats
        if (pUrls.length > 0 && (!videoId || !destinationUrl)) {
          await Promise.all(pUrls.map(async (pUrl) => {
            if (videoId && destinationUrl) return;
            try {
              const fullUrl = pUrl.startsWith('//') ? 'https:' + pUrl : pUrl;
              const pRes = await fetch(fullUrl);
              if (!pRes.ok) return;
              const pText = await pRes.text();
              const cleanCode = pText
                .replace(/\x27/g, "'")
                .replace(/\x22/g, '"')
                .replace(/\x3a/g, ':')
                .replace(/\x2f/g, '/')
                .replace(/\\\//g, '/');

              if (!videoId) {
                const vm = cleanCode.match(/['"]?video_?id['"]\s*:\s*['"]([a-zA-Z0-9_-]{11})['"]/i) ||
                           cleanCode.match(/['"]?video_?videoId['"]\s*:\s*['"]([a-zA-Z0-9_-]{11})['"]/i) ||
                           cleanCode.match(/ytimg\.com\/vi\/([a-zA-Z0-9_-]{11})/) ||
                           cleanCode.match(/youtube\.com\/(?:embed|watch\?v=)([a-zA-Z0-9_-]{11})/) ||
                           cleanCode.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
                if (vm) videoId = vm[1];
              }

              if (!destinationUrl) {
                destinationUrl = extractDestUrl(cleanCode);
              }

              if (!headline) {
                const hm = cleanCode.match(/'headline':\s*'([^']+)'/) || cleanCode.match(/"headline":\s*"([^"]+)"/);
                if (hm) headline = hm[1];
              }
            } catch (e) {}
          }));
        }

        if (videoId && !seenVids.has(videoId)) {
          seenVids.add(videoId);
          videos.push({
            creativeId: item.creativeId,
            videoId: videoId,
            youtubeUrl: 'https://www.youtube.com/watch?v=' + videoId,
            thumbnail: 'https://i.ytimg.com/vi/' + videoId + '/hqdefault.jpg',
            destinationUrl: destinationUrl,
            headline: headline,
            advertiserName: advName
          });

          // Pantau apakah semua produk unik di halaman sudah berhasil dipasangkan
          if (destinationUrl && targetSlugSet.size > 0) {
            try {
              const segs = new URL(destinationUrl).pathname.split('/').filter(Boolean);
              if (segs.length > 0) {
                const s = segs[segs.length - 1].toLowerCase().replace(/\.(html|php|aspx)$/, '');
                if (targetSlugSet.has(s)) {
                  matchedSlugs.add(s);
                  if (matchedSlugs.size >= targetSlugSet.size) {
                    shouldStopEarly = true;
                  }
                }
              }
            } catch (e) {}
          }
        }
      } catch (e) {}
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(CONCURRENCY, targetCreatives.length); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  // 6. Cek juga elemen DOM & Shadow DOM langsung (embed / thumbnail YouTube) sebagai fallback tambahan
  function scanYoutubeInTree(root) {
    if (!root) return;
    try {
      root.querySelectorAll('img[src*="ytimg.com/vi/"], iframe[src*="youtube.com"], a[href*="youtube.com"], a[href*="youtu.be"]').forEach(el => {
        const src = el.src || el.href || el.getAttribute('src') || el.getAttribute('href') || '';
        const vm = src.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/|ytimg\.com\/vi\/)([a-zA-Z0-9_-]{11})/);
        if (vm && !seenVids.has(vm[1])) {
          seenVids.add(vm[1]);
          let nearbyLink = '';
          const cardEl = el.closest('creative-preview, [data-creative-id], a, div') || el.parentElement;
          if (cardEl) {
            const destA = cardEl.querySelector('a[href^="http"]:not([href*="google"]):not([href*="youtube"])');
            if (destA) nearbyLink = destA.href.replace(/\x27/g, '').replace(/[\\'"]+$/, '').trim();
          }
          videos.push({
            creativeId: '',
            videoId: vm[1],
            youtubeUrl: 'https://www.youtube.com/watch?v=' + vm[1],
            thumbnail: 'https://i.ytimg.com/vi/' + vm[1] + '/hqdefault.jpg',
            destinationUrl: nearbyLink,
            headline: '',
            advertiserName: detectedPageAdv
          });
        }
      });
    } catch (e) {}

    try {
      const allEls = root.querySelectorAll('*');
      for (const el of allEls) {
        if (el.shadowRoot) scanYoutubeInTree(el.shadowRoot);
      }
    } catch (e) {}
  }
  scanYoutubeInTree(document);

  return {
    totalDetectedCards: cids.length,
    totalVideosFound: videos.length,
    videos: videos,
    advertiser: detectedPageAdv
  };
}

// FUNGSI TARIK TANGGAL DARI HALAMAN
function fetchDateFromPage() {
  return new Promise((resolve) => {
    const inputEl = document.getElementById('inputDate');
    const oldVal = inputEl ? inputEl.value : "";
    if (inputEl) inputEl.value = "Mendeteksi...";

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || tabs.length === 0 || !tabs[0].id) {
        if (inputEl) inputEl.value = oldVal || "Semua Waktu";
        resolve();
        return;
      }

      chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        func: () => {
          const dateEl = document.querySelector('date-range-filter .button-text .secondary-text');
          return dateEl ? dateEl.textContent.trim() : null;
        }
      }, (results) => {
        if (chrome.runtime.lastError || !results || !results[0] || !results[0].result) {
          if (inputEl) inputEl.value = oldVal ? oldVal : "Semua Waktu";
        } else {
          if (inputEl) inputEl.value = results[0].result;
        }
        resolve();
      });
    });
  });
}

// FUNGSI AUTO-SCROLL DI FRAME UTAMA
async function performAutoScroll() {
  window.__stopAutoScroll = false;

  await new Promise((resolve) => {
    let lastHeight = document.documentElement.scrollHeight || document.body.scrollHeight;
    let attempts = 0;
    const maxAttempts = 5;
    const intervalTime = 700;

    const timer = setInterval(() => {
      if (window.__stopAutoScroll) {
        clearInterval(timer);
        resolve();
        return;
      }

      window.scrollTo(0, document.documentElement.scrollHeight || document.body.scrollHeight);
      const newHeight = document.documentElement.scrollHeight || document.body.scrollHeight;

      if (newHeight === lastHeight) {
        attempts++;
        if (attempts >= maxAttempts) {
          clearInterval(timer);
          resolve();
        }
      } else {
        lastHeight = newHeight;
        attempts = 0;
      }
    }, intervalTime);

    setTimeout(() => {
      clearInterval(timer);
      resolve();
    }, 60000);
  });
}

// FUNGSI SCRAPING MENDALAM (DIEKSEKUSI DI TIAP FRAME)
function scrapeDeepLinks() {
  const adUrls = [];
  const framePairs = [];
  let advertiser = "";

  function extractTargetUrl(rawHref) {
    if (!rawHref) return null;
    try {
      const parsed = new URL(rawHref);
      const params = ['adurl', 'destination_url', 'destinationUrl', 'q', 'url', 'target'];
      for (const param of params) {
        const val = parsed.searchParams.get(param);
        if (val && (val.startsWith('http://') || val.startsWith('https://'))) {
          return val;
        }
      }
    } catch (e) {}
    return rawHref;
  }

  function isInternalGoogleDomain(urlStr) {
    try {
      const hostname = new URL(urlStr).hostname.toLowerCase();
      if (
        hostname.includes('google.') ||
        hostname.endsWith('.google') ||
        hostname.includes('gstatic.') ||
        hostname.includes('youtube.com') ||
        hostname.includes('youtu.be') ||
        hostname.includes('googletagmanager.com') ||
        hostname.includes('google-analytics.com') ||
        hostname.includes('googleusercontent.com') ||
        hostname.includes('doubleclick.net') ||
        hostname.includes('w3.org') ||
        hostname.includes('schema.org')
      ) {
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  // Deteksi Nama Pengiklan jika di frame utama
  if (window.self === window.top) {
    const advEl = document.querySelector('.advertiser-name, .advertiser-title, header h1, header h2');
    if (advEl) {
      advertiser = advEl.textContent.trim();
    }
  }

  // 1. Ekstraksi URL landing page via DOM & Shadow DOM
  function findLinks(root) {
    if (!root) return;
    try {
      const links = root.querySelectorAll('a');
      links.forEach(a => {
        const href = a.href || a.getAttribute('href') || '';
        if (!href || href.startsWith('javascript:') || href.startsWith('chrome-extension:')) return;

        const target = extractTargetUrl(href);
        if (target && target.startsWith('http') && !isInternalGoogleDomain(target)) {
          adUrls.push(target);
        }
      });
    } catch (e) {}

    try {
      const allElements = root.querySelectorAll('*');
      allElements.forEach(el => {
        if (el.shadowRoot) {
          findLinks(el.shadowRoot);
        }
      });
    } catch (e) {}
  }

  try {
    findLinks(document);
  } catch (e) {}

  // 2. Ekstraksi via regex script tags di frame
  try {
    const scripts = document.querySelectorAll('script');
    const regex = /(?:destination_url|adurl)=([^"&'\s]+)/gi;
    scripts.forEach(s => {
      if (s.textContent) {
        let match;
        while ((match = regex.exec(s.textContent)) !== null) {
          try {
            const decoded = decodeURIComponent(match[1]);
            if (decoded.startsWith('http') && !isInternalGoogleDomain(decoded)) {
              adUrls.push(decoded);
            }
          } catch (e) {}
        }
      }
    });
  } catch (e) {}

  // 3. Pasangkan langsung Video YouTube di dalam frame jika ada
  let frameVideoId = '';
  try {
    const ytEl = document.querySelector('iframe[src*="youtube.com"], a[href*="youtube.com"], a[href*="youtu.be"], img[src*="ytimg.com/vi/"]');
    if (ytEl) {
      const src = ytEl.src || ytEl.href || ytEl.getAttribute('src') || ytEl.getAttribute('href') || '';
      const m = src.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/|ytimg\.com\/vi\/)([a-zA-Z0-9_-]{11})/);
      if (m) frameVideoId = m[1];
    }

    if (!frameVideoId) {
      const scripts = document.querySelectorAll('script');
      for (const s of scripts) {
        if (s.textContent && (s.textContent.includes('video_id') || s.textContent.includes('videoId') || s.textContent.includes('ytimg'))) {
          const m = s.textContent.match(/['"]?video_?id['"]\s*:\s*['"]([a-zA-Z0-9_-]{11})['"]/i) ||
                    s.textContent.match(/['"]?video_?videoId['"]\s*:\s*['"]([a-zA-Z0-9_-]{11})['"]/i) ||
                    s.textContent.match(/(?:youtube\.com\/(?:embed|watch\?v=)|youtu\.be\/|ytimg\.com\/vi\/)([a-zA-Z0-9_-]{11})/);
          if (m) {
            frameVideoId = m[1];
            break;
          }
        }
      }
    }
  } catch (e) {}

  if (frameVideoId && adUrls.length > 0) {
    adUrls.forEach(u => {
      framePairs.push({
        url: u,
        videoId: frameVideoId,
        youtubeUrl: 'https://www.youtube.com/watch?v=' + frameVideoId,
        thumbnail: 'https://i.ytimg.com/vi/' + frameVideoId + '/hqdefault.jpg'
      });
    });
  }

  return {
    urls: adUrls,
    advertiser: advertiser,
    pairs: framePairs
  };
}
