let globalData = [];
let activeTab = 'tab-analysis';
let searchQuery = '';
let selectedStatus = 'ALL';
let selectedDate = '';
let sortColumn = 'skor';
let sortDirection = 'desc';

// Helper sanitasi HTML untuk mencegah DOM XSS
function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Sanitasi atribut href agar hanya mengizinkan http/https
function sanitizeHref(url) {
  if (!url) return '#';
  const trimmed = String(url).trim();
  if (trimmed.startsWith('https://') || trimmed.startsWith('http://')) {
    return escapeHtml(trimmed);
  }
  return '#';
}

// Format sel CSV sesuai standar RFC 4180
function toCsvCell(val) {
  if (val === null || val === undefined) return '""';
  const str = String(val).replace(/"/g, '""');
  return `"${str}"`;
}

// Ambil hostname domain dari URL
function getDomain(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return "unknown-domain";
  }
}

// Parser Tanggal Kronologis (Mendukung ID, EN, ISO, dsb)
function parseDateScore(dateStr) {
  if (!dateStr || dateStr === "Tanpa Tanggal" || dateStr === "Semua Waktu") {
    return 0;
  }

  const months = {
    jan: 0, januari: 0, january: 0,
    feb: 1, februari: 1, february: 1,
    mar: 2, maret: 2, march: 2,
    apr: 3, april: 3,
    mei: 4, may: 4,
    jun: 5, juni: 5, june: 5,
    jul: 6, juli: 6, july: 6,
    agu: 7, ags: 7, agustus: 7, aug: 7, august: 7,
    sep: 8, september: 8,
    okt: 9, oktober: 9, oct: 9, october: 9,
    nov: 10, november: 10,
    des: 11, desember: 11, dec: 11, december: 11
  };

  const standardTime = Date.parse(dateStr);
  if (!isNaN(standardTime)) return standardTime;

  const cleaned = dateStr.trim().toLowerCase().replace(/,/g, '');
  const parts = cleaned.split(/[\s\-\/]+/);

  if (parts.length >= 3) {
    if (!isNaN(parts[0]) && months[parts[1]] !== undefined && !isNaN(parts[2])) {
      return new Date(parseInt(parts[2], 10), months[parts[1]], parseInt(parts[0], 10)).getTime();
    }
    if (months[parts[0]] !== undefined && !isNaN(parts[1]) && !isNaN(parts[2])) {
      return new Date(parseInt(parts[2], 10), months[parts[0]], parseInt(parts[1], 10)).getTime();
    }
    if (parts[0].length === 4 && !isNaN(parts[0]) && !isNaN(parts[1]) && !isNaN(parts[2])) {
      return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10)).getTime();
    }
    if (!isNaN(parts[0]) && !isNaN(parts[1]) && parts[2].length === 4 && !isNaN(parts[2])) {
      return new Date(parseInt(parts[2], 10), parseInt(parts[1], 10) - 1, parseInt(parts[0], 10)).getTime();
    }
  }

  return 1;
}

// Ekstraksi Nama Produk Bersih dari URL tanpa parameter tracking
function extractProductName(url) {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    const parts = pathname.split('/').filter(p => p.length > 0);
    
    let rawName = parts.length > 0 ? parts[parts.length - 1] : parsed.hostname;
    rawName = rawName.replace(/\.(html?|php|asp[x]?|jsp|do)$/i, '');
    rawName = decodeURIComponent(rawName).replace(/[-_+]/g, ' ').trim();

    if (!rawName) rawName = parsed.hostname;
    rawName = rawName.replace(/\b\w/g, l => l.toUpperCase());
    return rawName.length > 40 ? rawName.substring(0, 40) + "..." : rawName;
  } catch (e) {
    let fallback = url.split(/[?#]/)[0].split('/').filter(p => p.length > 0).pop() || "Produk Unknown";
    return fallback.replace(/[-_+]/g, ' ').trim();
  }
}

// Hitung Indikator Tren & Momentum Produk
function calculateTrend(dateHistory) {
  if (!dateHistory || dateHistory.length <= 1) {
    return { text: '➡️ Stabil', class: 'trend-steady' };
  }

  dateHistory.sort((a, b) => a.timestamp - b.timestamp);
  const newest = dateHistory[dateHistory.length - 1].count;
  const previous = dateHistory[dateHistory.length - 2].count;

  if (previous === 0) return { text: '🔥 Baru', class: 'trend-surge' };

  const delta = Math.round(((newest - previous) / previous) * 100);

  if (delta >= 40) {
    return { text: `🔥 +${delta}% Surge`, class: 'trend-surge' };
  } else if (delta > 0) {
    return { text: `📈 +${delta}% Naik`, class: 'trend-up' };
  } else if (delta < 0) {
    return { text: `📉 ${delta}%`, class: 'trend-down' };
  } else {
    return { text: '➡️ Stabil', class: 'trend-steady' };
  }
}

// Inisialisasi Event Listener
document.addEventListener('DOMContentLoaded', () => {
  setupTheme();
  setupTabs();
  setupFilters();
  setupSortHeaders();
  loadData();
});

// === THEME ENGINE LOGIC ===
function setupTheme() {
  const themeSelect = document.getElementById('themeSelectDashboard');

  function applyTheme(themeName) {
    const validTheme = themeName || 'theme-default';
    document.body.className = validTheme;
    if (themeSelect && themeSelect.value !== validTheme) {
      themeSelect.value = validTheme;
    }
  }

  // Muat tema yang tersimpan di chrome.storage atau localStorage
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['selectedTheme'], (res) => {
      if (res && res.selectedTheme) {
        applyTheme(res.selectedTheme);
      }
    });

    if (chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.selectedTheme) {
          applyTheme(changes.selectedTheme.newValue);
        }
      });
    }
  } else {
    try {
      const localSaved = localStorage.getItem('selectedTheme');
      if (localSaved) applyTheme(localSaved);
    } catch(e) {}
  }

  // Listener pergantian tema di dashboard
  if (themeSelect) {
    themeSelect.addEventListener('change', (e) => {
      const chosen = e.target.value;
      applyTheme(chosen);
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ selectedTheme: chosen });
      }
      try { localStorage.setItem('selectedTheme', chosen); } catch(err) {}
    });
  }
}

document.getElementById('btnRefresh').addEventListener('click', loadData);

// === TAB NAVIGATION LOGIC ===
function setupTabs() {
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));
      
      btn.classList.add('active');
      activeTab = btn.getAttribute('data-target');
      document.getElementById(activeTab).classList.add('active');
      renderCurrentTab();
    });
  });
}

// === SETUP FILTERS (SEARCH, PILLS, DATES) ===
function setupFilters() {
  const searchInput = document.getElementById('searchInput');
  const pills = document.querySelectorAll('.pill');
  const dateFilter = document.getElementById('dateFilter');
  const btnDeleteFilteredDate = document.getElementById('btnDeleteFilteredDate');

  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      searchQuery = e.target.value.toLowerCase().trim();
      renderCurrentTab();
    });
  }

  pills.forEach(pill => {
    pill.addEventListener('click', () => {
      pills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      selectedStatus = pill.getAttribute('data-rek');
      renderCurrentTab();
    });
  });

  if (dateFilter) {
    dateFilter.addEventListener('change', (e) => {
      selectedDate = e.target.value;
      if (btnDeleteFilteredDate) {
        btnDeleteFilteredDate.style.display = selectedDate ? 'inline-flex' : 'none';
        btnDeleteFilteredDate.textContent = `🗑 Hapus Data ${selectedDate}`;
      }
      renderCurrentTab();
    });
  }

  if (btnDeleteFilteredDate) {
    btnDeleteFilteredDate.addEventListener('click', () => {
      if (!selectedDate) return;
      const yakin = confirm(`Yakin ingin menghapus semua data scan pada tanggal "${selectedDate}"?`);
      if (!yakin) return;

      globalData = globalData.filter(item => item.date !== selectedDate);
      saveDataToStorage(() => {
        selectedDate = '';
        dateFilter.value = '';
        btnDeleteFilteredDate.style.display = 'none';
        populateDateDropdown();
        renderAllTabs();
      });
    });
  }
}

// === SETUP COLUMN SORTING ===
function setupSortHeaders() {
  const headers = document.querySelectorAll('th.sortable');
  headers.forEach(th => {
    th.addEventListener('click', () => {
      const col = th.getAttribute('data-sort');
      if (sortColumn === col) {
        sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
      } else {
        sortColumn = col;
        sortDirection = 'desc';
      }

      headers.forEach(h => {
        const icon = h.querySelector('.sort-icon');
        if (icon) icon.textContent = '';
      });
      const icon = th.querySelector('.sort-icon');
      if (icon) icon.textContent = sortDirection === 'asc' ? ' ▲' : ' ▼';

      renderCurrentTab();
    });
  });
}

// === LOAD DATA ===
function loadData() {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['adsScannerData'], (result) => {
      globalData = result.adsScannerData || [];
      populateDateDropdown();
      renderAllTabs();
    });
  } else {
    // Fallback Mock Data jika dibuka langsung di browser luar Chrome extension
    globalData = [
      {
        date: "4 Sep 2026",
        url: "https://larisgaskeun.com/paket-hemat-kelly-5in1-indonesia?utm_source=fb",
        count: 25,
        advertiser: "PT Laris Indonesia",
        youtubeUrl: "https://www.youtube.com/watch?v=6B4zyy0oR8E",
        videoId: "6B4zyy0oR8E",
        thumbnail: "https://i.ytimg.com/vi/6B4zyy0oR8E/hqdefault.jpg"
      },
      {
        date: "3 Sep 2026",
        url: "https://larisgaskeun.com/paket-hemat-kelly-5in1-indonesia",
        count: 12,
        advertiser: "PT Laris Indonesia",
        youtubeUrl: "https://www.youtube.com/watch?v=6B4zyy0oR8E",
        videoId: "6B4zyy0oR8E",
        thumbnail: "https://i.ytimg.com/vi/6B4zyy0oR8E/hqdefault.jpg"
      },
      {
        date: "4 Sep 2026",
        url: "https://diskonlagilagi.shop/Tatakan-Kompor",
        count: 15,
        advertiser: "Toko Berkah Bersama",
        youtubeUrl: "https://www.youtube.com/watch?v=iCsZGWT2h-E",
        videoId: "iCsZGWT2h-E",
        thumbnail: "https://i.ytimg.com/vi/iCsZGWT2h-E/hqdefault.jpg"
      },
      {
        date: "3 Sep 2026",
        url: "https://diskonlagilagi.shop/Tatakan-Kompor",
        count: 10,
        advertiser: "Toko Berkah Bersama",
        youtubeUrl: "https://www.youtube.com/watch?v=iCsZGWT2h-E",
        videoId: "iCsZGWT2h-E",
        thumbnail: "https://i.ytimg.com/vi/iCsZGWT2h-E/hqdefault.jpg"
      },
      {
        date: "4 Sep 2026",
        url: "https://diskonlagilagi.shop/Pembersih-Kerak-Ajaib",
        count: 8,
        advertiser: "Toko Berkah Bersama"
      },
      {
        date: "4 Sep 2026",
        url: "https://belanjabergaransi.com/celana-korset-bantu-jadi-ide4L",
        count: 18,
        advertiser: "Korset Official Store"
      },
      {
        date: "3 Sep 2026",
        url: "https://belanjabergaransi.com/celana-korset-bantu-jadi-ide4L",
        count: 18,
        advertiser: "Korset Official Store"
      },
      {
        date: "4 Sep 2026",
        url: "https://tokohero.co.id/sepatu-sneakers-pria-casual",
        count: 5,
        advertiser: "Hero Fashion Group"
      }
    ];
    populateDateDropdown();
    renderAllTabs();
  }
}

function saveDataToStorage(callback) {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.set({ adsScannerData: globalData }, callback);
  } else {
    if (callback) callback();
  }
}

function populateDateDropdown() {
  const dateFilter = document.getElementById('dateFilter');
  if (!dateFilter) return;

  const currentVal = dateFilter.value;
  const uniqueDates = Array.from(new Set(globalData.map(d => d.date || "Tanpa Tanggal")));
  
  uniqueDates.sort((a, b) => parseDateScore(b) - parseDateScore(a));

  dateFilter.innerHTML = '<option value="">Semua Tanggal Scan</option>';
  uniqueDates.forEach(tgl => {
    const opt = document.createElement('option');
    opt.value = tgl;
    opt.textContent = tgl;
    dateFilter.appendChild(opt);
  });

  if (uniqueDates.includes(currentVal)) {
    dateFilter.value = currentVal;
  }
}

function renderAllTabs() {
  renderAnalysisDashboard();
  renderDomainDashboard();
  renderRawDashboard();
}

function renderCurrentTab() {
  if (activeTab === 'tab-analysis') renderAnalysisDashboard();
  else if (activeTab === 'tab-domain') renderDomainDashboard();
  else if (activeTab === 'tab-raw') renderRawDashboard();
}

// === TAB 1: RENDER ANALISIS PRODUK ===
function renderAnalysisDashboard() {
  const container = document.getElementById('tableBodyAnalysis');
  const statsContainer = document.getElementById('statsGridAnalysis');
  if (!container) return;

  if (globalData.length === 0) {
    if (statsContainer) statsContainer.innerHTML = '';
    container.innerHTML = '<tr><td colspan="8" style="text-align:center; padding: 40px; color: #64748b;">Belum ada data iklan. Silakan lakukan scanning melalui Side Panel.</td></tr>';
    return;
  }

  // 1. Agregasi Produk Berdasarkan URL
  const productMap = {};
  globalData.forEach(item => {
    if (!item || !item.url) return;

    if (!productMap[item.url]) {
      const domain = getDomain(item.url);
      productMap[item.url] = {
        url: item.url,
        domain: domain,
        nama: extractProductName(item.url),
        advertiser: item.advertiser || "",
        youtubeUrl: item.youtubeUrl || "",
        videoId: item.videoId || "",
        thumbnail: item.thumbnail || "",
        headline: item.headline || "",
        totalTayangan: 0,
        datesSet: new Set(),
        dateHistory: []
      };
    }

    productMap[item.url].totalTayangan += Number(item.count || 0);
    const dateStr = item.date || "Tanpa Tanggal";
    if (dateStr !== "Tanpa Tanggal" && dateStr !== "Semua Waktu") {
      productMap[item.url].datesSet.add(dateStr);
    }

    productMap[item.url].dateHistory.push({
      date: dateStr,
      count: Number(item.count || 0),
      timestamp: parseDateScore(dateStr)
    });

    if (item.advertiser && !productMap[item.url].advertiser) {
      productMap[item.url].advertiser = item.advertiser;
    }
    if (item.youtubeUrl && !productMap[item.url].youtubeUrl) {
      productMap[item.url].youtubeUrl = item.youtubeUrl;
      productMap[item.url].videoId = item.videoId || "";
      productMap[item.url].thumbnail = item.thumbnail || "";
      productMap[item.url].headline = item.headline || "";
    }
  });

  let products = Object.values(productMap).map(p => {
    const datesArray = Array.from(p.datesSet);
    return {
      ...p,
      hariAktif: datesArray.length > 0 ? datesArray.length : 1,
      daftarTanggal: datesArray.length > 0 ? datesArray : ["Tanpa Tanggal"],
      trend: calculateTrend(p.dateHistory)
    };
  });

  // 2. Kalkulasi Skor Performa (Max 100)
  const maxTayangan = Math.max(...products.map(p => p.totalTayangan), 1);
  const maxHari = Math.max(...products.map(p => p.hariAktif), 1);

  products = products.map(p => {
    const scoreVolume = (p.totalTayangan / maxTayangan) * 70;
    const scoreHari = (p.hariAktif / maxHari) * 30;
    p.skorNum = Number((scoreVolume + scoreHari).toFixed(1));
    p.skor = p.skorNum.toFixed(1);

    if (p.skorNum >= 80) { p.rek = "Prioritas Utama"; p.badge = "badge-green"; }
    else if (p.skorNum >= 65) { p.rek = "Sangat Layak Uji"; p.badge = "badge-blue"; }
    else if (p.skorNum >= 45) { p.rek = "Potensial"; p.badge = "badge-yellow"; }
    else if (p.skorNum >= 25) { p.rek = "Cadangan (Monitor)"; p.badge = "badge-gray"; }
    else { p.rek = "Tidak Direkomendasikan"; p.badge = "badge-red"; }

    return p;
  });

  window.analyzedProducts = products;

  // 3. Filter berdasarkan Search, Status Pill, dan Date Filter
  let filtered = products.filter(p => {
    if (selectedStatus !== 'ALL' && p.rek !== selectedStatus) return false;
    if (selectedDate && !p.daftarTanggal.includes(selectedDate)) return false;
    if (searchQuery) {
      const matchName = p.nama.toLowerCase().includes(searchQuery);
      const matchDomain = p.domain.toLowerCase().includes(searchQuery);
      const matchUrl = p.url.toLowerCase().includes(searchQuery);
      const matchAdv = (p.advertiser || "").toLowerCase().includes(searchQuery);
      const matchYt = (p.youtubeUrl || "").toLowerCase().includes(searchQuery);
      if (!matchName && !matchDomain && !matchUrl && !matchAdv && !matchYt) return false;
    }
    return true;
  });

  // 4. Pengurutan Kolom
  filtered.sort((a, b) => {
    let res = 0;
    if (sortColumn === 'nama') res = a.nama.localeCompare(b.nama);
    else if (sortColumn === 'hari') res = a.hariAktif - b.hariAktif;
    else if (sortColumn === 'tayangan') res = a.totalTayangan - b.totalTayangan;
    else if (sortColumn === 'skor' || sortColumn === 'rank') res = a.skorNum - b.skorNum;
    return sortDirection === 'asc' ? res : -res;
  });

  // 5. Update Top Stats Cards
  const totalTayanganAll = products.reduce((sum, p) => sum + p.totalTayangan, 0);
  const totalProdukUnik = products.length;
  const topProduk = products.sort((a, b) => b.skorNum - a.skorNum)[0] ? products[0].nama : "-";
  const hotCandidate = products.find(p => p.trend.text.includes('Surge') || p.trend.text.includes('Naik'));
  const hotProduk = hotCandidate ? hotCandidate.nama : topProduk;

  if (statsContainer) {
    statsContainer.innerHTML = `
      <div class="stat-card" style="--color: #4f46e5;">
        <div class="stat-title">Total Tayangan Iklan</div>
        <div class="stat-value">${totalTayanganAll}</div>
        <div class="stat-desc">Akumulasi seluruh tanggal</div>
      </div>
      <div class="stat-card" style="--color: #10b981;">
        <div class="stat-title">Jumlah Produk Terpantau</div>
        <div class="stat-value">${totalProdukUnik}</div>
        <div class="stat-desc">${filtered.length} produk cocok dengan filter</div>
      </div>
      <div class="stat-card" style="--color: #f59e0b;">
        <div class="stat-title">Produk Peringkat #1</div>
        <div class="stat-value" style="font-size: 19px; line-height: 34px;">${escapeHtml(topProduk)}</div>
        <div class="stat-desc">Volume & konsistensi tertinggi</div>
      </div>
      <div class="stat-card" style="--color: #ef4444;">
        <div class="stat-title">Trending / Momentum</div>
        <div class="stat-value" style="font-size: 19px; line-height: 34px;">${escapeHtml(hotProduk)}</div>
        <div class="stat-desc">Iklan sedang agresif dinaikkan</div>
      </div>
    `;
  }

  // 6. Render Tabel
  container.innerHTML = '';
  if (filtered.length === 0) {
    container.innerHTML = '<tr><td colspan="8" style="text-align:center; padding: 36px; color: #64748b;">Tidak ada produk yang cocok dengan kriteria pencarian/filter.</td></tr>';
    return;
  }

  filtered.forEach((p, index) => {
    const avgPerDay = (p.totalTayangan / p.hariAktif).toFixed(1);
    const safeNama = escapeHtml(p.nama);
    const safeUrl = escapeHtml(p.url);
    const href = sanitizeHref(p.url);
    const safeRek = escapeHtml(p.rek);
    const faviconUrl = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(p.domain)}&sz=32`;

    const dateLabelsHtml = p.daftarTanggal.map(tgl => 
      `<span style="font-size:10px; background:#f1f5f9; border:1px solid #e2e8f0; color:#475569; padding:2px 5px; border-radius:4px; margin:1px; display:inline-block; white-space:nowrap;">${escapeHtml(tgl)}</span>`
    ).join('');

    container.innerHTML += `
      <tr>
        <td><strong>#${index + 1}</strong></td>
        <td>
          <div class="product-cell">
            <img class="favicon-img" src="${faviconUrl}" onerror="this.style.display='none'">
            <div>
              <strong>${safeNama}</strong>
              <div style="font-size: 11px; color: var(--muted);">${escapeHtml(p.domain)}${p.advertiser ? ` • ${escapeHtml(p.advertiser)}` : ''}</div>
            </div>
          </div>
        </td>
        <td>
          <a class="link-url" href="${href}" target="_blank" rel="noopener noreferrer">
            <span style="max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block;">${safeUrl}</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
          </a>
        </td>
        <td style="text-align: center;">
          ${p.youtubeUrl ? `
            <a href="${sanitizeHref(p.youtubeUrl)}" target="_blank" rel="noopener noreferrer" style="text-decoration:none; display:inline-flex; flex-direction:column; align-items:center; gap:4px;">
              ${p.thumbnail ? `<img src="${escapeHtml(p.thumbnail)}" width="64" height="36" style="border-radius:4px; object-fit:cover; border:1px solid #e2e8f0;">` : ''}
              <span class="badge badge-red" style="font-size:10px; display:inline-flex; align-items:center; gap:3px; padding:2px 6px;">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M10 15l5.19-3L10 9v6m11.56-7.83c.13.47.22 1.1.28 1.9.07.8.1 1.49.1 2.09L22 12c0 2.19-.16 3.8-.44 4.83-.25.9-.83 1.48-1.73 1.73-.47.13-1.33.22-2.65.28-1.3.07-2.49.1-3.59.1L12 19c-4.19 0-6.8-.16-7.83-.44-.9-.25-1.48-.83-1.73-1.73-.13-.47-.22-1.1-.28-1.9-.07-.8-.1-1.49-.1-2.09L2 12c0-2.19.16-3.8.44-4.83.25-.9.83-1.48 1.73-1.73.47-.13 1.33-.22 2.65-.28 1.3-.07 2.49-.1 3.59-.1L12 5c4.19 0 6.8.16 7.83.44.9.25 1.48.83 1.73 1.73z"/></svg>
                Tonton Video ↗
              </span>
            </a>
          ` : `<span style="color:#94a3b8; font-size:12px;">-</span>`}
        </td>
        <td style="text-align: center;">
          <div style="font-weight: 700; margin-bottom: 4px;">${p.hariAktif} Hari</div>
          <div style="display: flex; flex-wrap: wrap; justify-content: center; gap: 2px;">
            ${dateLabelsHtml}
          </div>
        </td>
        <td style="text-align: center;">
          <strong style="font-size: 14px;">${p.totalTayangan}x</strong>
          <div style="font-size:11px; color:#64748b;">(~${avgPerDay}/hari)</div>
          <div><span class="trend-badge ${p.trend.class}">${p.trend.text}</span></div>
        </td>
        <td>
          <div style="font-weight:800; font-size:16px;">${p.skor}</div>
          <div class="score-bar"><div class="score-fill" style="width: ${p.skor}%"></div></div>
        </td>
        <td><span class="badge ${p.badge}">${safeRek}</span></td>
      </tr>
    `;
  });
}

// === TAB 2: RENDER ANALISIS DOMAIN & TOKO ===
function renderDomainDashboard() {
  const container = document.getElementById('tableBodyDomain');
  const statsContainer = document.getElementById('statsGridDomain');
  if (!container) return;

  if (globalData.length === 0) {
    if (statsContainer) statsContainer.innerHTML = '';
    container.innerHTML = '<tr><td colspan="8" style="text-align:center; padding: 40px; color: #64748b;">Belum ada data domain untuk dianalisis.</td></tr>';
    return;
  }

  const domainMap = {};
  let totalAllVolume = 0;

  globalData.forEach(item => {
    if (!item || !item.url) return;
    const dom = getDomain(item.url);
    const count = Number(item.count || 0);
    totalAllVolume += count;

    if (!domainMap[dom]) {
      domainMap[dom] = {
        domain: dom,
        advertiser: item.advertiser || "",
        urlsSet: new Set(),
        datesSet: new Set(),
        totalVolume: 0,
        urlVolumes: {}
      };
    }

    domainMap[dom].urlsSet.add(item.url);
    if (item.date) domainMap[dom].datesSet.add(item.date);
    domainMap[dom].totalVolume += count;
    domainMap[dom].urlVolumes[item.url] = (domainMap[dom].urlVolumes[item.url] || 0) + count;

    if (item.advertiser && !domainMap[dom].advertiser) {
      domainMap[dom].advertiser = item.advertiser;
    }
  });

  let domainList = Object.values(domainMap).map(d => {
    let topUrl = "";
    let maxV = -1;
    Object.entries(d.urlVolumes).forEach(([u, v]) => {
      if (v > maxV) { maxV = v; topUrl = u; }
    });

    const share = totalAllVolume > 0 ? ((d.totalVolume / totalAllVolume) * 100).toFixed(1) : 0;

    return {
      domain: d.domain,
      advertiser: d.advertiser || "Tidak Terdeteksi",
      productCount: d.urlsSet.size,
      totalVolume: d.totalVolume,
      activeDays: d.datesSet.size,
      dates: Array.from(d.datesSet),
      topProduct: extractProductName(topUrl),
      topUrl: topUrl,
      marketShare: share
    };
  });

  domainList.sort((a, b) => b.totalVolume - a.totalVolume);
  window.analyzedDomains = domainList;

  let filtered = domainList.filter(d => {
    if (selectedDate && !d.dates.includes(selectedDate)) return false;
    if (searchQuery) {
      const mDom = d.domain.toLowerCase().includes(searchQuery);
      const mAdv = d.advertiser.toLowerCase().includes(searchQuery);
      const mProd = d.topProduct.toLowerCase().includes(searchQuery);
      if (!mDom && !mAdv && !mProd) return false;
    }
    return true;
  });

  const totalDomains = domainList.length;
  const topDom = domainList[0] ? domainList[0].domain : "-";
  const avgProducts = totalDomains > 0 ? (domainList.reduce((s, d) => s + d.productCount, 0) / totalDomains).toFixed(1) : 0;
  const topDomShare = domainList[0] ? domainList[0].marketShare : 0;

  if (statsContainer) {
    statsContainer.innerHTML = `
      <div class="stat-card" style="--color: #4f46e5;">
        <div class="stat-title">Total Domain Terpantau</div>
        <div class="stat-value">${totalDomains}</div>
        <div class="stat-desc">Kompetitor unik teridentifikasi</div>
      </div>
      <div class="stat-card" style="--color: #10b981;">
        <div class="stat-title">Market Leader</div>
        <div class="stat-value" style="font-size: 20px; line-height: 34px;">${escapeHtml(topDom)}</div>
        <div class="stat-desc">${topDomShare}% share dari total iklan</div>
      </div>
      <div class="stat-card" style="--color: #f59e0b;">
        <div class="stat-title">Rata-rata Produk/Domain</div>
        <div class="stat-value">${avgProducts}</div>
        <div class="stat-desc">Variasi landing page per brand</div>
      </div>
      <div class="stat-card" style="--color: #ef4444;">
        <div class="stat-title">Total Iklan Terdistribusi</div>
        <div class="stat-value">${totalAllVolume}</div>
        <div class="stat-desc">Di seluruh domain</div>
      </div>
    `;
  }

  container.innerHTML = '';
  if (filtered.length === 0) {
    container.innerHTML = '<tr><td colspan="8" style="text-align:center; padding: 36px; color: #64748b;">Tidak ada domain yang cocok dengan pencarian.</td></tr>';
    return;
  }

  filtered.forEach((d, idx) => {
    const faviconUrl = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(d.domain)}&sz=32`;
    container.innerHTML += `
      <tr>
        <td><strong>#${idx + 1}</strong></td>
        <td>
          <div class="product-cell">
            <img class="favicon-img" src="${faviconUrl}" onerror="this.style.display='none'">
            <strong>${escapeHtml(d.domain)}</strong>
          </div>
        </td>
        <td><span style="color: var(--muted); font-weight: 500;">${escapeHtml(d.advertiser)}</span></td>
        <td style="text-align: center;"><span class="badge badge-date">${d.productCount} Produk</span></td>
        <td style="text-align: center;"><strong style="font-size: 14px;">${d.totalVolume}x</strong></td>
        <td style="text-align: center;"><strong>${d.activeDays} Hari</strong></td>
        <td>
          <div style="font-weight: 700;">${d.marketShare}%</div>
          <div class="score-bar"><div class="score-fill" style="width: ${d.marketShare}%; background: #10b981;"></div></div>
        </td>
        <td>
          <a class="link-url" href="${sanitizeHref(d.topUrl)}" target="_blank" rel="noopener noreferrer">
            ${escapeHtml(d.topProduct)}
          </a>
        </td>
      </tr>
    `;
  });
}

// === TAB 3: RENDER DATA MENTAH & RIWAYAT (DENGAN GRANULAR DELETE & YOUTUBE) ===
function renderRawDashboard() {
  const container = document.getElementById('tableBodyRaw');
  const statsContainer = document.getElementById('statsGridRaw');
  if (!container) return;

  const dataCopy = [...globalData];

  dataCopy.sort((a, b) => {
    const timeA = parseDateScore(a.date);
    const timeB = parseDateScore(b.date);
    if (timeB !== timeA) return timeB - timeA;
    return (b.count || 0) - (a.count || 0);
  });

  const filtered = dataCopy.filter(item => {
    if (selectedDate && (item.date || "Tanpa Tanggal") !== selectedDate) return false;
    if (searchQuery) {
      const mUrl = item.url.toLowerCase().includes(searchQuery);
      const mDate = (item.date || "").toLowerCase().includes(searchQuery);
      const mYt = (item.youtubeUrl || "").toLowerCase().includes(searchQuery);
      if (!mUrl && !mDate && !mYt) return false;
    }
    return true;
  });

  const totalUniqueUrls = new Set(dataCopy.map(d => d.url)).size;
  const totalInstances = dataCopy.reduce((sum, item) => sum + (item.count || 0), 0); 
  const highDuplicates = dataCopy.filter(item => (item.count || 0) >= 5).length; 
  const maxDuplicate = dataCopy.length > 0 ? Math.max(...dataCopy.map(i => i.count || 0)) : 0;

  if (statsContainer) {
    statsContainer.innerHTML = `
      <div class="stat-card" style="--color: var(--primary);">
        <div class="stat-title">Total URL Unik</div><div class="stat-value">${totalUniqueUrls}</div><div class="stat-desc">Iklan beda link</div>
      </div>
      <div class="stat-card" style="--color: var(--success);">
        <div class="stat-title">Total Instance</div><div class="stat-value">${totalInstances}</div><div class="stat-desc">Jumlah total duplikasi (Raw)</div>
      </div>
      <div class="stat-card" style="--color: var(--danger);">
        <div class="stat-title">High Duplicate</div><div class="stat-value">${highDuplicates}</div><div class="stat-desc">Iklan dengan 5+ duplikat</div>
      </div>
      <div class="stat-card" style="--color: var(--warning);">
        <div class="stat-title">Top Duplication</div><div class="stat-value">${maxDuplicate}x</div><div class="stat-desc">Duplikasi terbanyak per scan</div>
      </div>
    `;
  }

  container.innerHTML = '';
  if (filtered.length === 0) {
    container.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 40px; color: #64748b;">Tidak ada data tersimpan yang cocok dengan filter.</td></tr>';
    return;
  }

  filtered.forEach((item, index) => {
    const safeDate = escapeHtml(item.date || "Tanpa Tanggal");
    const safeUrl = escapeHtml(item.url);
    const href = sanitizeHref(item.url);
    const count = Number(item.count || 0);
    const dom = getDomain(item.url);
    const faviconUrl = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(dom)}&sz=32`;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${index + 1}</td>
      <td><span class="badge badge-date">${safeDate}</span></td>
      <td>
        <div class="product-cell">
          <img class="favicon-img" src="${faviconUrl}" onerror="this.style.display='none'">
          <a class="link-url" href="${href}" target="_blank" rel="noopener noreferrer">${safeUrl}</a>
        </div>
      </td>
      <td>
        ${item.youtubeUrl ? `
          <div class="product-cell">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="#ef4444" style="flex-shrink:0;"><path d="M10 15l5.19-3L10 9v6m11.56-7.83c.13.47.22 1.1.28 1.9.07.8.1 1.49.1 2.09L22 12c0 2.19-.16 3.8-.44 4.83-.25.9-.83 1.48-1.73 1.73-.47.13-1.33.22-2.65.28-1.3.07-2.49.1-3.59.1L12 19c-4.19 0-6.8-.16-7.83-.44-.9-.25-1.48-.83-1.73-1.73-.13-.47-.22-1.1-.28-1.9-.07-.8-.1-1.49-.1-2.09L2 12c0-2.19.16-3.8.44-4.83.25-.9.83-1.48 1.73-1.73.47-.13 1.33-.22 2.65-.28 1.3-.07 2.49-.1 3.59-.1L12 5c4.19 0 6.8.16 7.83.44.9.25 1.48.83 1.73 1.73z"/></svg>
            <a class="link-url" href="${sanitizeHref(item.youtubeUrl)}" target="_blank" rel="noopener noreferrer" style="color:#ef4444;" title="${escapeHtml(item.youtubeUrl)}">
              <span style="max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block;">${escapeHtml(item.youtubeUrl)}</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
            </a>
          </div>
        ` : `<div style="text-align:center;"><span style="color:#94a3b8; font-size:12px;">-</span></div>`}
      </td>
      <td style="text-align: right;"><span class="badge badge-yellow">${count}x duplikat</span></td>
      <td style="text-align: center;">
        <button class="btn-trash" title="Hapus baris ini dari database" type="button">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
        </button>
      </td>
    `;

    const trashBtn = tr.querySelector('.btn-trash');
    if (trashBtn) {
      trashBtn.addEventListener('click', () => {
        const yakin = confirm(`Hapus URL ini dari database?\n${item.url}`);
        if (!yakin) return;

        globalData = globalData.filter(d => !(d.date === item.date && d.url === item.url));
        saveDataToStorage(() => {
          populateDateDropdown();
          renderAllTabs();
        });
      });
    }

    container.appendChild(tr);
  });
}

// === EXPORT CSV ADAPTIF SESUAI RFC 4180 (TERMASUK YOUTUBE) ===
document.getElementById('btnExport').addEventListener('click', () => {
  if (globalData.length === 0) { alert('Data kosong.'); return; }

  let csvContent = "";
  let fileName = "";
  const dateStr = new Date().toISOString().split('T')[0];

  if (activeTab === 'tab-raw') {
    csvContent = "No,Tanggal,Domain,Target URL,URL Video YouTube,Video ID,Jumlah Duplikat\n";
    const dataExport = [...globalData].sort((a, b) => (b.count || 0) - (a.count || 0));
    dataExport.forEach((item, index) => {
      csvContent += `${index + 1},${toCsvCell(item.date || 'Tanpa Tanggal')},${toCsvCell(getDomain(item.url))},${toCsvCell(item.url)},${toCsvCell(item.youtubeUrl || '')},${toCsvCell(item.videoId || '')},${item.count || 0}\n`;
    });
    fileName = `Ads_RawData_${dateStr}.csv`;

  } else if (activeTab === 'tab-domain') {
    csvContent = "Peringkat,Domain,Pengiklan,Variasi Produk,Total Tayangan,Hari Terpantau,Share Dominasi,Produk Terpopuler\n";
    const domains = window.analyzedDomains || [];
    domains.forEach((d, idx) => {
      csvContent += `${idx + 1},${toCsvCell(d.domain)},${toCsvCell(d.advertiser)},${d.productCount},${d.totalVolume},${d.activeDays},"${d.marketShare}%",${toCsvCell(d.topProduct)}\n`;
    });
    fileName = `Ads_DomainAnalysis_${dateStr}.csv`;

  } else {
    csvContent = "Peringkat,Nama Produk,Domain,URL Iklan,URL Video YouTube,Video ID,Hari Aktif,Rincian Tanggal,Total Tayangan,Tren,Skor Performa,Status Rekomendasi\n";
    const products = window.analyzedProducts || [];
    products.forEach((p, index) => {
      const safeDates = p.daftarTanggal.join('; ');
      csvContent += `${index + 1},${toCsvCell(p.nama)},${toCsvCell(p.domain)},${toCsvCell(p.url)},${toCsvCell(p.youtubeUrl || '')},${toCsvCell(p.videoId || '')},${p.hariAktif},${toCsvCell(safeDates)},${p.totalTayangan},${toCsvCell(p.trend.text)},${p.skor},${toCsvCell(p.rek)}\n`;
    });
    fileName = `Ads_ProductAnalysis_${dateStr}.csv`;
  }

  downloadFile(csvContent, 'text/csv;charset=utf-8;', fileName);
});

// === EXPORT MARKDOWN (NOTION / OBSIDIAN / CHATGPT) ===
document.getElementById('btnCopyMarkdown').addEventListener('click', (e) => {
  if (globalData.length === 0) { alert('Data kosong.'); return; }

  let md = "";
  if (activeTab === 'tab-domain') {
    md = "| Rank | Domain / Brand | Pengiklan | Variasi Produk | Total Tayangan | Dominasi | Produk Unggulan |\n";
    md += "|---|---|---|---|---|---|---|\n";
    const domains = window.analyzedDomains || [];
    domains.forEach((d, idx) => {
      md += `| #${idx + 1} | ${d.domain} | ${d.advertiser} | ${d.productCount} | ${d.totalVolume}x | ${d.marketShare}% | [${d.topProduct}](${d.topUrl}) |\n`;
    });
  } else if (activeTab === 'tab-raw') {
    md = "| No | Tanggal Scan | URL Landing Page | Video YouTube | Jumlah Duplikat |\n";
    md += "|---|---|---|---|---|\n";
    globalData.slice(0, 100).forEach((item, idx) => {
      const ytCell = item.youtubeUrl ? `[Buka Video](${item.youtubeUrl})` : '-';
      md += `| ${idx + 1} | ${item.date || '-'} | [${item.url}](${item.url}) | ${ytCell} | ${item.count}x |\n`;
    });
  } else {
    md = "| Rank | Produk | Domain | Video YouTube | Hari Aktif | Tayangan | Tren | Skor | Rekomendasi |\n";
    md += "|---|---|---|---|---|---|---|---|---|\n";
    const products = window.analyzedProducts || [];
    products.forEach((p, idx) => {
      const ytCell = p.youtubeUrl ? `[Buka Video](${p.youtubeUrl})` : '-';
      md += `| #${idx + 1} | [${p.nama}](${p.url}) | ${p.domain} | ${ytCell} | ${p.hariAktif} Hari | ${p.totalTayangan}x | ${p.trend.text} | **${p.skor}** | ${p.rek} |\n`;
    });
  }

  navigator.clipboard.writeText(md);
  const targetBtn = e.currentTarget;
  const originalHtml = targetBtn.innerHTML;
  targetBtn.innerHTML = '✅ Copied Markdown!';
  setTimeout(() => { targetBtn.innerHTML = originalHtml; }, 2000);
});

// === EXPORT JSON DATABASE BACKUP ===
document.getElementById('btnExportJson').addEventListener('click', () => {
  if (globalData.length === 0) { alert('Data kosong.'); return; }
  const jsonStr = JSON.stringify(globalData, null, 2);
  const dateStr = new Date().toISOString().split('T')[0];
  downloadFile(jsonStr, 'application/json;charset=utf-8;', `Ads_Database_${dateStr}.json`);
});

// Helper Download File
function downloadFile(content, mimeType, fileName) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", fileName);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
