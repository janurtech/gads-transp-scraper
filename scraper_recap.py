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
    """Menghitung tanggal H-1 (Kemarin) berdasarkan Waktu Indonesia Barat (WIB / UTC+7)"""
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
        print("\n" + "="*60)
        print("❌ ERROR: Kredensial Telegram belum disetel di GitHub Secrets!")
        print("Pastikan TELEGRAM_BOT_TOKEN dan TELEGRAM_CHAT_ID sudah disetel.")
        print("="*60 + "\n")
        sys.exit(1)

def baca_daftar_kompetitor():
    targets = []
    if not os.path.exists("competitors.txt"):
        print("⚠️ File competitors.txt tidak ditemukan!")
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

    # Handler network response non-blocking
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

    # 1. Navigasi Halaman
    is_url = target_raw.startswith("http://") or target_raw.startswith("https://")

    if is_url:
        target_url = target_raw
        if "start-date=" not in target_url and "start_date=" not in target_url:
            sep = "&" if "?" in target_url else "?"
            target_url = f"{target_url}{sep}start-date={kemarin_iso}&end-date={kemarin_iso}"
        print(f"\n🔍 [1/3] Membuka URL: {target_url}")
        await page.goto(target_url, wait_until="domcontentloaded", timeout=45000)
    else:
        # Buka beranda Ads Transparency dengan filter tanggal H-1
        base_url = f"https://adstransparency.google.com/?region=ID&start-date={kemarin_iso}&end-date={kemarin_iso}"
        print(f"\n🔍 [1/3] Mencari: '{target_raw}' di Google Ads Transparency...")
        await page.goto(base_url, wait_until="domcontentloaded", timeout=45000)
        await page.wait_for_timeout(2000)

        # Cari kolom pencarian dan ketik nama target
        search_input = page.locator("input[type='text'], input[role='combobox']").first
        if await search_input.count() > 0:
            await search_input.click()
            await search_input.fill(target_raw)
            await page.wait_for_timeout(1500)

            # Pilih opsi pertama (Agregasi seluruh akun pengiklan)
            await page.keyboard.press("ArrowDown")
            await page.wait_for_timeout(300)
            await page.keyboard.press("Enter")
            await page.wait_for_timeout(3000)
            print(f"🎯 Memuat hasil agregasi untuk: {target_raw}")

    # Ambil judul dari halaman jika ada
    try:
        h_el = page.locator("h1, .advertiser-name, [role='heading']").first
        if await h_el.count() > 0:
            detected_brand_name = (await h_el.text_content()).strip()
    except Exception:
        pass
    print(f"🏢 Pengiklan: {detected_brand_name}")

    # 2. Auto-Scroll Terkendali (15 kali scroll, total ~20 detik)
    print("⏳ [2/3] Sedang auto-scroll memuat materi iklan...")
    max_scrolls = 15
    for i in range(max_scrolls):
        await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        await page.wait_for_timeout(1000)

    # 3. Ekstraksi kartu iklan dari DOM (termasuk Shadow DOM)
    print("🔎 [3/3] Membaca kartu materi iklan yang termuat...")
    try:
        dom_cards = await page.evaluate("""() => {
            const list = [];
            function scanNode(root) {
                if (!root) return;
                const elements = root.querySelectorAll('creative-preview, [data-creative-id], .creative-card, a[href*="/creative/"]');
                elements.forEach(c => {
                    let text = c.textContent ? c.textContent.trim() : '';
                    let href = c.href || c.getAttribute('href') || '';
                    let ytId = '';
                    const img = c.querySelector('img[src*="ytimg.com/vi/"]');
                    if (img) {
                        const m = img.src.match(/ytimg\\.com\\/vi\\/([a-zA-Z0-9_-]{11})/);
                        if (m) ytId = m[1];
                    }
                    if (text || href || ytId) {
                        list.push({ text: text.substring(0, 100), href, ytId });
                    }
                });
                
                const all = root.querySelectorAll('*');
                all.forEach(el => {
                    if (el.shadowRoot) scanNode(el.shadowRoot);
                });
            }
            scanNode(document);
            return list;
        }""")

        for cd in dom_cards:
            headline = cd.get("text") or "Materi Iklan"
            yt_id = cd.get("ytId")
            yt_url = f"https://youtu.be/{yt_id}" if yt_id else "-"
            raw_href = cd.get("href") or ""
            target_link = f"https://adstransparency.google.com{raw_href}" if raw_href.startswith("/") else (raw_href or "https://adstransparency.google.com")

            # Tambahkan ke daftar jika belum ada
            if yt_id or len(headline) > 10:
                captured_ads.append({
                    "url": target_link,
                    "headline": headline,
                    "youtubeUrl": yt_url,
                    "advertiser": detected_brand_name
                })
    except Exception as e:
        print(f"⚠️ DOM scan notice: {e}")

    print(f"📦 Berhasil menangkap {len(captured_ads)} materi iklan untuk {detected_brand_name}.")
    return captured_ads

def hitung_performa_dan_rekomendasi(all_items):
    """Agregasi tayangan, ranking produk, skor performa, dan label rekomendasi"""
    product_map = {}

    for item in all_items:
        raw_url = item.get("url", "")
        headline = item.get("headline", "").strip()

        # Bersihkan headline dari teks UI Google
        clean_headline = re.sub(r'^(Sponsored|Disponsori|Iklan|00:00)\s*', '', headline, flags=re.I).strip()
        
        # Nama produk
        nama_produk = clean_headline
        if not nama_produk or len(nama_produk) < 4:
            path_parts = [p for p in urlparse(raw_url).path.split("/") if p]
            if path_parts:
                nama_produk = path_parts[-1].replace("-", " ").title()
            else:
                nama_produk = "Produk Unggulan"

        # Potong nama jika terlalu panjang
        if len(nama_produk) > 55:
            nama_produk = nama_produk[:52] + "..."

        agg_key = raw_url if (raw_url and "adstransparency.google.com" not in raw_url) else nama_produk

        if agg_key not in product_map:
            domain = urlparse(raw_url).netloc
            brand_label = f"{domain} • {item['advertiser']}" if (domain and "google" not in domain) else item['advertiser']
            product_map[agg_key] = {
                "nama": nama_produk,
                "brand": brand_label,
                "url": raw_url,
                "youtubeUrl": item.get("youtubeUrl", "-"),
                "totalTayangan": 0,
                "tren": "Stabil"
            }

        product_map[agg_key]["totalTayangan"] += 1

        if product_map[agg_key]["youtubeUrl"] == "-" and item.get("youtubeUrl") != "-":
            product_map[agg_key]["youtubeUrl"] = item["youtubeUrl"]

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
    print("📤 Mengirim laporan ke Telegram...")
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

    pesan = f"📊 *REKAP PERFORMA PRODUK TERPANTAU*\n"
    pesan += f"📅 *Periode Riset: H-1 (Kemarin, {tgl_info['display']})*\n"
    pesan += f"🎯 Target: {len(targets)} Pengiklan\n\n"

    for idx, p in enumerate(ranked_products[:15], 1):
        pesan += f"━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        pesan += f"*{idx}. [Rank #{idx}] {p['nama']}*\n"
        pesan += f"• *Brand:* {p['brand']}\n"
        pesan += f"• *Tayangan:* {p['totalTayangan']}x | Tren: {p['tren']}\n"
        pesan += f"• *Rekomendasi:* {p['rek']} (Skor: {p['skor']})\n"
        pesan += f"• *URL:* {p['url']}\n"
        pesan += f"• *Link YT:* {p['youtubeUrl']}\n\n"

    kirim_ke_telegram(pesan)

def main():
    asyncio.run(async_main())

if __name__ == "__main__":
    main()
