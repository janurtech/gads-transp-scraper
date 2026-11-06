// background.js - Service Worker untuk Ad Transparency URL Scraper & YouTube Extractor

// 1. Memaksa sidebar terbuka saat ikon ekstensi diklik
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

// 2. Listener pesan untuk ekstraksi materi iklan Google Ads Transparency
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'extract_creative') {
    handleExtractCreative(request.advertiserId, request.creativeId, request.xsrfToken)
      .then(data => sendResponse({ success: true, data }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // Async response channel
  }

  if (request.action === 'batch_extract') {
    handleBatchExtract(request.cards || request.advertiserId, request.creativeIds)
      .then(data => sendResponse({ success: true, data }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

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

/**
 * Ekstraksi video YouTube dan metadata dari ID Materi Iklan (Creative ID)
 */
async function handleExtractCreative(advertiserId, creativeId, xsrfToken) {
  if (!creativeId) {
    throw new Error('Creative ID tidak valid.');
  }

  // Jika xsrfToken tidak disertakan, coba ambil dari tab aktif
  if (!xsrfToken) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        const res = await new Promise(resolve => {
          chrome.tabs.sendMessage(tab.id, { action: 'get_xsrf_token' }, (r) => {
            if (chrome.runtime.lastError) resolve(null);
            else resolve(r);
          });
        });
        if (res && res.token) {
          xsrfToken = res.token;
        }
      }
    } catch (e) {}
  }

  const rpcUrl = 'https://adstransparency.google.com/anji/_/rpc/LookupService/GetCreativeById?authuser=0';
  const payload = {
    '1': advertiserId || '',
    '2': creativeId,
    '5': { '1': 1 }
  };

  const body = 'f.req=' + encodeURIComponent(JSON.stringify(payload));
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
  };
  if (xsrfToken) {
    headers['X-Framework-Xsrf-Token'] = xsrfToken;
  }

  let response = await fetch(rpcUrl, {
    method: 'POST',
    headers: headers,
    body: body,
    credentials: 'include'
  });

  if (!response.ok) {
    response = await fetch(rpcUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      credentials: 'include'
    });
  }

  if (!response.ok) {
    throw new Error(`Gagal memuat detail iklan (HTTP ${response.status})`);
  }

  let resText = await response.text();
  if (resText.startsWith(")]}'")) {
    resText = resText.substring(4);
  }

  const json = JSON.parse(resText);
  const root = json?.['1'] || {};
  const returnedAdvId = root?.['1'] || advertiserId || '';
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
  const headlines = new Set();
  const descriptions = new Set();
  const destinationUrls = new Set();

  // 1. Scan langsung di dalam payload RPC JSON
  try {
    const payloadStr = JSON.stringify(root);
    const ytMatches = payloadStr.matchAll(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/|ytimg\.com\/vi\/)([a-zA-Z0-9_-]{11})/g);
    for (const ym of ytMatches) {
      const vid = ym[1];
      if (vid && !videosMap.has(vid)) {
        videosMap.set(vid, {
          videoId: vid,
          youtubeUrl: `https://www.youtube.com/watch?v=${vid}`,
          shortUrl: `https://youtu.be/${vid}`,
          thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
          maxresThumbnail: `https://i.ytimg.com/vi/${vid}/maxresdefault.jpg`,
          channelName: '',
          duration: '',
          headline: '',
          longHeadline: '',
          description: '',
          destinationUrl: '',
          title: '',
          creativeId: creativeId
        });
      }
    }
    const destMatches = payloadStr.matchAll(/destination_url['":\s]+(https?:\/\/[^'"\s\\]+)/g);
    for (const dm of destMatches) {
      destinationUrls.add(dm[1]);
    }
  } catch (e) {}

  // 2. Fetch seluruh skrip pratinjau displayads-formats.googleusercontent.com secara paralel
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
        
        const headlineMatch = cleanCode.match(/'headline':\s*'([^']+)'/) || cleanCode.match(/"headline":\s*"([^"]+)"/);
        const longHeadlineMatch = cleanCode.match(/'longHeadline':\s*'([^']+)'/) || cleanCode.match(/"longHeadline":\s*"([^"]+)"/);
        const descMatch = cleanCode.match(/'description':\s*'([^']+)'/) || cleanCode.match(/"description":\s*"([^"]+)"/);
        const destMatch = cleanCode.match(/destination_url['":\s]+(https?:\/\/[^'"\s]+)/) ||
                          cleanCode.match(/['"]destination_url['"]\s*:\s*['"]([^'"]+)['"]/);
        const channelMatch = cleanCode.match(/'channelName':\s*'([^']+)'/) || cleanCode.match(/"channelName":\s*"([^"]+)"/);
        const durationMatch = cleanCode.match(/'videoDuration':\s*'([^']+)'/) || cleanCode.match(/"videoDuration":\s*"([^"]+)"/);

        if (headlineMatch) headlines.add(headlineMatch[1]);
        if (longHeadlineMatch) headlines.add(longHeadlineMatch[1]);
        if (descMatch) descriptions.add(descMatch[1]);
        if (destMatch) destinationUrls.add(destMatch[1]);

        if (videoIdMatch) {
          const vid = videoIdMatch[1];
          const chosenTitle = headlineMatch ? headlineMatch[1] : (longHeadlineMatch ? longHeadlineMatch[1] : '');
          if (!videosMap.has(vid)) {
            videosMap.set(vid, {
              videoId: vid,
              youtubeUrl: `https://www.youtube.com/watch?v=${vid}`,
              shortUrl: `https://youtu.be/${vid}`,
              thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
              maxresThumbnail: `https://i.ytimg.com/vi/${vid}/maxresdefault.jpg`,
              channelName: channelMatch ? channelMatch[1] : '',
              duration: durationMatch ? durationMatch[1] : '',
              headline: chosenTitle,
              longHeadline: longHeadlineMatch ? longHeadlineMatch[1] : '',
              description: descMatch ? descMatch[1] : '',
              destinationUrl: destMatch ? destMatch[1] : '',
              title: chosenTitle,
              creativeId: creativeId
            });
          } else {
            const ex = videosMap.get(vid);
            if (!ex.destinationUrl && destMatch) ex.destinationUrl = destMatch[1];
            if (!ex.headline && chosenTitle) ex.headline = chosenTitle;
            if (!ex.channelName && channelMatch) ex.channelName = channelMatch[1];
          }
        }
      } catch (e) {
        console.warn('Error fetching preview JS:', pUrl, e);
      }
    }));
  }

  const firstDest = Array.from(destinationUrls)[0] || '';
  const videosList = Array.from(videosMap.values()).map(v => {
    if (!v.destinationUrl && firstDest) v.destinationUrl = firstDest;
    return v;
  });

  return {
    advertiserId: returnedAdvId,
    advertiserName,
    creativeId,
    totalVariations: previewUrls.length,
    videos: videosList,
    headlines: Array.from(headlines),
    descriptions: Array.from(descriptions),
    destinationUrls: Array.from(destinationUrls)
  };
}

/**
 * Handle batch extraction untuk banyak iklan sekaligus
 */
async function handleBatchExtract(cardsOrAdvId, creativeIds) {
  let list = [];
  if (Array.isArray(cardsOrAdvId)) {
    list = cardsOrAdvId;
  } else {
    list = (creativeIds || []).map(cid => ({ advertiserId: cardsOrAdvId || '', creativeId: cid }));
  }

  const results = [];
  for (const item of list) {
    try {
      const res = await handleExtractCreative(item.advertiserId, item.creativeId);
      if (res.videos.length > 0) {
        results.push(res);
      }
    } catch (e) {
      console.warn(`Failed extracting creative ${item.creativeId}:`, e);
    }
  }
  return results;
}
