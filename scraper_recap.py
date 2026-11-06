import os
import sys
import re
import asyncio
import requests
from urllib.parse import urlparse, parse_qs
from datetime import datetime, timedelta, timezone
from playwright.async_api import async_playwright

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")

def get_kemarin_dates():
    wib = timezone(timedelta(hours=7))
    now_wib = datetime.now(wib)
    kemarin_wib = now_wib - timedelta(days=1)
    return {
        "iso": kemarin_wib.strftime("%Y-%m-%d"),
        "display": kemarin_wib.strftime("%d %b %Y"),
        "hari_ini_display": now_wib.strftime("%d %b %Y")
    }

def periksa_kredensial():
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        print("❌ ERROR: Kredensial Telegram belum disetel di GitHub Secrets!")
        sys.exit(1)

def baca_daftar_kompetitor():
    targets = []
    if not os.path.exists("competitors.txt"):
        return targets

    with open("competitors.txt", "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                clean = line.split("#")[0].strip()
                if clean:
                    targets.append(clean)
    return targets

def unescape_js(text):
    if not text:
        return ""
    replacements = {
        "\\x27": "'", "\\x22": '"', "\\x3a": ":", "\\x2f": "/",
        "\\x3d": "=", "\\x26": "&", "\\u0026": "&", "\\u003d": "=",
        "\\u003c": "<", "\\u003e": ">"
    }
    for k, v in replacements.items():
        text = text.replace(k, v)
    return text

def is_internal_domain(url_str):
    try:
        domain = urlparse(url_str).netloc.lower()
        internal = ['gstatic.', 'doubleclick.net', 'googlesyndication.com', 'schema.org', 'w3.org']
        return any(x in domain for x in internal)
    except Exception:
        return False

async def scrape_target(page, target_raw, tgl_info):
    kemarin_iso = tgl_info["iso"]
    captured_ads = []
    detected_brand_name = target_raw
    seen_urls = set()

    # Network listener untuk menangkap destination_url asli & YouTube ID
    async def handle_response(response):
        url = response.url
        if "displayads-formats.googleusercontent.com" in url or "GetCreativeById" in url:
            try:
                body = await response.text()
                clean_body = unescape_js(body)

                dest_matches = re.findall(r'destination_url[\'":\s]+(https?:\/\/[^\'"\s\\&]+)', clean_body)
                yt_matches = re.findall(r'(?:video_?id[\'":\s]+|ytimg\.com\/vi\/|youtu\.be\/|watch\?v=)([a-zA-Z0-9_-]{11})', clean_body, re.I)
                hl_matches = re.findall(r'[\'"](?:headline|longHeadline)[\'"]\s*:\s*[\'"]([^\'"]+)[\'"]', clean_body)

                headline = hl_matches[0].strip() if hl_matches else ""
                video_id = yt_matches[0] if yt_matches else ""
                yt_url = f"https://youtu.be/{video_id}" if video_id else "-"

                for d in dest_matches:
                    clean_d = d.split("?")[0].rstrip("/")
                    if len(clean_d) > 10 and not is_internal_domain(clean_d):
                        captured_ads.append({
                            "url": clean_d,
                            "headline": headline,
                            "youtubeUrl": yt_url,
                            "advertiser": detected_brand_name
                        })
            except Exception:
                pass

    page.on("response", handle_response)

    is_url = target_raw.startswith("http://") or target_raw.startswith("https://")

    if is_url:
        target_url = target_raw
        if "start-date=" not in target_url and "start_date=" not in target_url:
            sep = "&" if "?" in target_url else "?"
            target_url = f"{target_url}{sep}start-date={kemarin_iso}&end-date={kemarin_iso}"
        print(f"\n🔍 [1/3] Mengunjungi URL langsung: {target_url}")
        await page.goto(target_url, wait_until="domcontentloaded", timeout=45000)
        await page.wait_for_timeout(3000)
    else:
        # Buka Ads Transparency dengan filter tanggal H-1
        base_url = f"https://adstransparency.google.com/?region=ID&start-date={kemarin_iso}&end-date={kemarin_iso}"
        print(f"\n🔍 [1/3] Membuka beranda: {base_url}")
        await page.goto(base_url, wait_until="domcontentloaded", timeout=45000)
        await page.wait_for_timeout(3000)

        # Cari input dan ketik nama kompetitor
        search_input = page.locator("input[type='text'], input[role='combobox']").first
        if await search_input.count() > 0:
            print(f"⌨️ Mengetik nama target: '{target_raw}'...")
            await search_input.click()
            await search_input.fill("")
            await search_input.press_sequentially(target_raw, delay=80)
            await page.wait_for_timeout(2500)

            # Cari dan klik menu dropdown autocomplete
            clicked = False
            dropdown_selectors = [
                'div[role="listbox"] [role="option"]',
                '[role="option"]',
                'material-select-item',
                '.prediction-item',
                'text--suggestion',
                '.name'
            ]

            for sel in dropdown_selectors:
                try:
                    options = page.locator(sel)
                    cnt = await options.count()
                    if cnt > 0:
                        for i in range(min(cnt, 3)):
                            txt = await options.nth(i).text_content()
                            if target_raw.lower() in txt.lower() or "pengiklan" in txt.lower():
                                print(f"👉 Mengklik suggestion menu: {txt.strip()[:40]}...")
                                await options.nth(i).click()
                                clicked = True
                                break
                    if clicked:
                        break
                except Exception:
                    pass

            if not clicked:
                print("⌨️ Fallback: Menekan tombol ArrowDown + Enter...")
                await page.keyboard.press("ArrowDown")
                await page.wait_for_timeout(400)
                await page.keyboard.press("Enter")

            # Tunggu kartu iklan termuat di layar
            try:
                await page.wait_for_selector('creative-preview, a[href*="/creative/"]', timeout=10000)
                print("✅ Hasil pencarian iklan berhasil dimuat!")
            except Exception:
                pass

    print(f"📄 Halaman aktif: {page.url}")

    # 2. Auto-scroll bertahap untuk memicu pemuatan materi iklan (~400 iklan)
    print("⏳ [2/3] Sedang auto-scroll memuat materi iklan...")
    for _ in range(15):
        await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        await page.wait_for_timeout(900)

    # 3. Ekstraksi kartu iklan secara mendalam HANYA dari elemen creative
    print("🔎 [3/3] Membaca kartu materi iklan murni dari layar...")
    try:
        dom_cards = await page.evaluate("""() => {
            const results = [];
            const seen = new Set();
            
            function scan(root) {
                if (!root) return;
                
                // Cari HANYA kartu materi iklan (creative-preview atau link creative)
                const elements = root.querySelectorAll('creative-preview, a[href*="/creative/"]');
                elements.forEach(el => {
                    let text = el.innerText || el.textContent || '';
                    let href = el.href || el.getAttribute('href') || '';
                    
                    // Ambil ID YouTube dari gambar thumbnail
                    let ytId = '';
                    const imgs = el.querySelectorAll('img');
                    imgs.forEach(img => {
                        const src = img.src || img.getAttribute('src') || '';
                        const m = src.match(/(?:ytimg\\.com\\/vi\\/|youtu\\.be\\/|youtube\\.com\\/embed\\/)([a-zA-Z0-9_-]{11})/);
                        if (m) ytId = m[1];
                    });

                    // Cek iframe di dalam kartu jika ada
                    const iframes = el.querySelectorAll('iframe');
                    iframes.forEach(f => {
                        const src = f.src || f.getAttribute('src') || '';
                        const m = src.match(/(?:ytimg\\.com\\/vi\\/|youtu\\.be\\/|youtube\\.com\\/embed\\/)([a-zA-Z0-9_-]{11})/);
                        if (m) ytId = m[1];
                    });

                    // Filter teks agar murni judul produk (abaikan teks sistem Google)
                    const lines = text.split('\\n').map(l => l.trim()).filter(l => l.length > 5);
                    const validLines = lines.filter(l => 
                        !l.toLowerCase().includes('terverifikasi') &&
                        !l.toLowerCase().includes('sponsored') &&
                        !l.toLowerCase().includes('disponsori') &&
                        !l.toLowerCase().includes('00:00') &&
                        !l.toLowerCase().includes('tidak dapat') &&
                        !l.toLowerCase().includes('mencakup beberapa') &&
                        !l.toLowerCase().includes('pusat iklan') &&
                        !l.toLowerCase().includes('arrow_outward') &&
                        !l.toLowerCase().includes('sesuaikan') &&
                        !l.toLowerCase().includes('buat iklan')
                    );

                    const headline = validLines[0] || '';

                    if ((headline && headline.length > 5) || ytId) {
                        const key = headline || ytId;
                        if (!seen.has(key)) {
                            seen.add(key);
                            results.push({
                                headline: headline,
                                ytId: ytId,
                                href: href
                            });
                        }
                    }
                });

                // Scan shadow DOM
                const all = root.querySelectorAll('*');
                all.forEach(el => {
                    if (el.shadowRoot) scan(el.shadowRoot);
                });
            }
            
            scan(document);
            return results;
        }""")

        print(f"📋 Ditemukan {len(dom_cards)} kartu materi iklan asli di DOM.")

        for cd in dom_cards:
            hl = cd.get("headline", "").strip()
            yt_id = cd.get("ytId")
            yt_url = f"https://youtu.be/{yt_id}" if yt_id else "-"
            lk = cd.get("href") or "https://adstransparency.google.com"
            if lk.startswith("/"):
                lk = f"https://adstransparency.google.com{lk}"

            # Pasangkan YouTube URL jika ada yang cocok
            captured_ads.append({
                "url": lk,
                "headline": hl or "Materi Iklan Video",
                "youtubeUrl": yt_url,
                "advertiser": detected_brand_name
            })
    except Exception as e:
        print(f"⚠️ Catatan DOM scan: {e}")

    print(f"📦 Total materi iklan valid terhimpun: {len(captured_ads)} materi.")
    return captured_ads

def hitung_performa_dan_rekomendasi(all_items):
    product_map = {}

    for item in all_items:
        raw_url = item.get("url", "")
        headline = item.get("headline", "").strip()
        yt_url = item.get("youtubeUrl", "-")

        # Bersihkan headline
        clean_headline = re.sub(r'^(Sponsored|Disponsori|Iklan|00:00)\s*', '', headline, flags=re.I).strip()
        
        # Nama produk
        nama_produk = clean_headline
        if not nama_produk or len(nama_produk) < 4:
            path_parts = [p for p in urlparse(raw_url).path.split("/") if p]
            if path_parts and "creative" not in path_parts[-1]:
                nama_produk = path_parts[-1].replace("-", " ").title()
            else:
                nama_produk = "Produk Unggulan"

        if len(nama_produk) > 55:
            nama_produk = nama_produk[:52] + "..."

        # Kunci agregasi
        agg_key = nama_produk if nama_produk != "Produk Unggulan" else (yt_url if yt_url != "-" else raw_url)

        if agg_key not in product_map:
            domain = urlparse(raw_url).netloc
            brand_label = f"{domain} • {item['advertiser']}" if (domain and "google" not in domain) else item['advertiser']
            product_map[agg_key] = {
                "nama": nama_produk,
                "brand": brand_label,
                "url": raw_url,
                "youtubeUrl": yt_url,
                "totalTayangan": 0,
                "tren": "Stabil"
            }

        product_map[agg_key]["totalTayangan"] += 1

        # Lengkapi URL YT jika sebelumnya kosong
        if product_map[agg_key]["youtubeUrl"] == "-" and yt_url != "-":
            product_map[agg_key]["youtubeUrl"] = yt_url

        # Lengkapi URL jika sebelumnya masih adstransparency
        if "adstransparency.google.com" in product_map[agg_key]["url"] and "adstransparency.google.com" not in raw_url:
            product_map[agg_key]["url"] = raw_url

    products = list(product_map.values())
    if not products:
        return []

    max_tayangan = max(p["totalTayangan"] for p in products) or 1

    for p in products:
        score_volume = (p["totalTayangan"] / max_tayangan) * 100
        p["skor"] = round(score_volume, 1)

        if p["skor"] >= 80:
            p["rek"] = "Prioritas Utama"
        elif p["skor"] >= 65:
            p["rek"] = "Sangat Layak Uji"
        elif p["skor"] >= 45:
            p["rek"] = "Potensial"
        else:
            p["rek"] = "Cadangan"

    products.sort(key=lambda x: x["totalTayangan"], reverse=True)
    return products

def kirim_ke_telegram(pesan):
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": pesan,
        "parse_mode": "Markdown",
        "disable_web_page_preview": True
    }
    try:
        resp = requests.post(url, json=payload, timeout=20)
        if resp.status_code == 200:
            print("✅ Berhasil kirim rekap ke Telegram!")
        else:
            print(f"❌ Gagal kirim Telegram (Status {resp.status_code}): {resp.text}")
    except Exception as e:
        print(f"❌ Error koneksi ke Telegram API: {e}")

async def async_main():
    periksa_kredensial()

    tgl_info = get_kemarin_dates()
    print(f"📅 Menjalankan riset untuk tanggal H-1: {tgl_info['display']} (WIB)")

    targets = baca_daftar_kompetitor()
    if not targets:
        print("⚠️ Tidak ada target di competitors.txt.")
        kirim_ke_telegram("⚠️ File `competitors.txt` kosong.")
        return

    print(f"🎯 Memproses {len(targets)} target kompetitor...")
    all_scraped_items = []

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
        )
        page = await browser.new_page(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            locale="id-ID"
        )

        for target in targets:
            try:
                items = await scrape_target(page, target, tgl_info)
                all_scraped_items.extend(items)
            except Exception as e:
                print(f"⚠️ Gagal scrape target '{target}': {e}")

        await browser.close()

    ranked_products = hitung_performa_dan_rekomendasi(all_scraped_items)

    if not ranked_products:
        print("⚠️ Tidak ada produk materi iklan yang terdeteksi.")
        pesan_kosong = f"📊 *REKAP PERFORMA PRODUK TERPANTAU*\n"
        pesan_kosong += f"📅 *Periode Riset: H-1 (Kemarin, {tgl_info['display']})*\n\n"
        pesan_kosong += f"ℹ️ Robot berhasil mengecek {len(targets)} pengiklan, namun tidak ada materi iklan yang aktif pada tanggal kemarin ({tgl_info['display']})."
        kirim_ke_telegram(pesan_kosong)
        return

    # Kirim Top 25 Produk (Dibagi per 12 produk agar muat rapi di Telegram tanpa terpotong)
    limit_products = ranked_products[:25]
    total_batch = (len(limit_products) + 11) // 12

    for batch_idx in range(total_batch):
        chunk = limit_products[batch_idx * 12 : (batch_idx + 1) * 12]
        
        pesan = f"📊 *REKAP PERFORMA PRODUK TERPANTAU* (Bagian {batch_idx + 1}/{total_batch})\n"
        pesan += f"📅 *Periode Riset: H-1 (Kemarin, {tgl_info['display']})*\n"
        pesan += f"🎯 Target: {len(targets)} Pengiklan | Total Produk: {len(ranked_products)}\n\n"

        start_num = (batch_idx * 12) + 1
        for idx, p in enumerate(chunk, start_num):
            pesan += f"━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
            pesan += f"*{idx}. [Rank #{idx}] {p['nama']}*\n"
            pesan += f"• *Brand:* {p['brand']}\n"
            pesan += f"• *Tayangan:* {p['totalTayangan']}x | Tren: {p['tren']}\n"
            pesan += f"• *Rekomendasi:* {p['rek']} (Skor: {p['skor']})\n"
            pesan += f"• *URL:* {p['url']}\n"
            pesan += f"• *Link YT:* {p['youtubeUrl']}\n\n"

        kirim_ke_telegram(pesan)
        await asyncio.sleep(1)

def main():
    asyncio.run(async_main())

if __name__ == "__main__":
    main()
