import os
import sys
import re
import time
import requests
from urllib.parse import urlparse, parse_qs
from datetime import datetime, timedelta, timezone
from playwright.sync_api import sync_playwright

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
    """Membaca daftar target dari file competitors.txt (bisa berupa Nama Brand atau URL)"""
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
        internal = ['google.', '.google', 'gstatic.', 'youtube.com', 'youtu.be', 'doubleclick.net', 'googlesyndication.com', 'schema.org', 'w3.org']
        return any(x in domain for x in internal)
    except Exception:
        return False

def extract_target_url(raw_href):
    if not raw_href:
        return None
    try:
        parsed = urlparse(raw_href)
        params = parse_qs(parsed.query)
        for key in ['adurl', 'destination_url', 'destinationUrl', 'q', 'url', 'target']:
            if key in params and params[key]:
                val = params[key][0]
                if val.startswith("http://") or val.startswith("https://"):
                    return val
    except Exception:
        pass
    return raw_href

def set_filter_tanggal_h_minus_1(page):
    """Memilih filter tanggal H-1 (Kemarin) di Google Ads Transparency UI"""
    print("📅 [2/4] Memeriksa & Mengatur filter tanggal ke Kemarin...")
    try:
        date_btn = page.locator("date-range-filter, [role='button']:has-text('Kustom'), [role='button']:has-text('rentang'), [role='button']:has-text('date'), button:has-text('Rentang')").first
        if date_btn.count() > 0:
            date_btn.click()
            page.wait_for_timeout(1000)

            opt_kemarin = page.locator("text=/^(Kemarin|Yesterday)$/i, [role='option']:has-text('Kemarin'), [role='menuitem']:has-text('Kemarin'), [role='option']:has-text('Yesterday'), [role='menuitem']:has-text('Yesterday')").first
            if opt_kemarin.count() == 0:
                opt_kemarin = page.get_by_text(re.compile(r"^(kemarin|yesterday)", re.I)).first

            if opt_kemarin.count() > 0:
                opt_kemarin.click()
                print("✅ Filter tanggal 'Kemarin' BERHASIL dipilih!")
                page.wait_for_timeout(3000)
                return True
            else:
                page.keyboard.press("Escape")
    except Exception as e:
        print(f"⚠️ Catatan filter tanggal: {e}")
    return False

def scrape_target(page, target_raw, tgl_info):
    """
    Scrape kompetitor:
    - Jika target berupa Nama (misal: PT MUBARAK MEDIA GRUP), robot mencari lewat search bar
      sehingga Google mengelompokkan SELURUH akun (~400 iklan).
    - Jika berupa URL, robot langsung mengunjungi URL tersebut.
    """
    kemarin_iso = tgl_info["iso"]
    captured_ads = []
    detected_brand_name = target_raw

    # Listener untuk mencegat payload materi iklan (displayads-formats & RPC)
    def handle_response(response):
        url = response.url
        if "displayads-formats.googleusercontent.com" in url or "GetCreativeById" in url:
            try:
                body = response.text()
                clean_body = unescape_js(body)

                # Ambil destination_url
                dest_matches = re.findall(r'destination_url[\'":\s]+(https?:\/\/[^\'"\s\\&]+)', clean_body)
                # Ambil video_id YouTube
                yt_matches = re.findall(r'(?:video_?id[\'":\s]+|ytimg\.com\/vi\/|youtu\.be\/|watch\?v=)([a-zA-Z0-9_-]{11})', clean_body, re.I)
                # Ambil headline produk
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
        print(f"\n🔍 [1/4] Mengunjungi URL target: {target_url}")
        page.goto(target_url, wait_until="domcontentloaded", timeout=60000)
    else:
        # Buka beranda Ads Transparency dengan filter tanggal H-1
        base_url = f"https://adstransparency.google.com/?region=ID&start-date={kemarin_iso}&end-date={kemarin_iso}"
        print(f"\n🔍 [1/4] Mencari nama kompetitor: '{target_raw}' (Mode Seluruh Akun)")
        page.goto(base_url, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(3000)

        # Cari kolom pencarian dan ketik nama target
        search_input = page.locator("input[type='text'], input[role='combobox']").first
        if search_input.count() > 0:
            search_input.click()
            search_input.fill(target_raw)
            page.wait_for_timeout(2000)

            # Pilih suggestion teratas (Semua Akun Pengiklan)
            page.keyboard.press("ArrowDown")
            page.wait_for_timeout(500)
            page.keyboard.press("Enter")
            page.wait_for_timeout(4000)
            print(f"🎯 Membuka hasil penelusuran agregasi untuk: {target_raw}")

    # Cek & sesuaikan filter tanggal di UI
    set_filter_tanggal_h_minus_1(page)
    page.wait_for_timeout(3000)

    # Ambil judul brand dari halaman jika ada
    try:
        h_el = page.locator("h1, .advertiser-name, [role='heading']").first
        if h_el.count() > 0:
            detected_brand_name = h_el.text_content().strip()
    except Exception:
        pass
    print(f"🏢 Nama Brand Terdeteksi: {detected_brand_name}")

    # 2. Auto-Scroll Agresif untuk memuat seluruh materi iklan (~400 iklan)
    print("⏳ [3/4] Sedang auto-scroll memuat seluruh materi iklan...")
    max_scrolls = 25
    for i in range(max_scrolls):
        page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        page.wait_for_timeout(1200)

    # 3. Fallback: Ekstraksi elemen dari DOM (kartu, thumbnail YT, teks headline)
    print("🔎 [4/4] Memeriksa kartu iklan yang telah dimuat di layar...")
    try:
        cards_data = page.evaluate("""() => {
            const list = [];
            const cards = document.querySelectorAll('creative-preview, [data-creative-id], .creative-card, a[href*="/creative/"]');
            cards.forEach(c => {
                let text = c.textContent ? c.textContent.trim() : '';
                let href = c.href || c.getAttribute('href') || '';
                let ytId = '';
                const img = c.querySelector('img[src*="ytimg.com/vi/"]');
                if (img) {
                    const m = img.src.match(/ytimg\\.com\\/vi\\/([a-zA-Z0-9_-]{11})/);
                    if (m) ytId = m[1];
                }
                list.push({ text: text.substring(0, 80), href, ytId });
            });
            return list;
        }""")

        for cd in cards_data:
            if cd.get("ytId") and not any(a.get("youtubeUrl") == f"https://youtu.be/{cd['ytId']}" for a in captured_ads):
                # Buat item jika terdeteksi video YouTube di DOM
                fallback_name = cd.get("text") or "Materi Iklan Video"
                captured_ads.append({
                    "url": f"https://adstransparency.google.com{cd['href']}" if cd.get("href") else "https://adstransparency.google.com",
                    "headline": fallback_name,
                    "youtubeUrl": f"https://youtu.be/{cd['ytId']}",
                    "advertiser": detected_brand_name
                })
    except Exception as e:
        print(f"⚠️ DOM scan notice: {e}")

    print(f"📦 Total materi iklan yang berhasil ditangkap: {len(captured_ads)} materi.")
    return captured_ads

def hitung_performa_dan_rekomendasi(all_items):
    """Agregasi tayangan, ranking produk, skor performa, dan label rekomendasi"""
    product_map = {}

    for item in all_items:
        # Gunakan URL landing page asli jika ada, atau headline jika fallback
        raw_url = item.get("url", "")
        headline = item.get("headline", "").strip()

        # Identifikasi nama produk terbaik
        nama_produk = headline
        if not nama_produk or len(nama_produk) < 4:
            path_parts = [p for p in urlparse(raw_url).path.split("/") if p]
            if path_parts:
                nama_produk = path_parts[-1].replace("-", " ").title()
            else:
                nama_produk = urlparse(raw_url).netloc or "Produk Iklan"

        # Key agregasi unik
        agg_key = raw_url if (raw_url and "adstransparency" not in raw_url) else nama_produk

        if agg_key not in product_map:
            brand_label = f"{urlparse(raw_url).netloc} • {item['advertiser']}" if urlparse(raw_url).netloc else item['advertiser']
            product_map[agg_key] = {
                "nama": nama_produk,
                "brand": brand_label,
                "url": raw_url,
                "youtubeUrl": item.get("youtubeUrl", "-"),
                "totalTayangan": 0,
                "tren": "Stabil"
            }

        product_map[agg_key]["totalTayangan"] += 1

        # Lengkapi URL YT jika sebelumnya kosong
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

def main():
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

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
        )
        page = browser.new_page(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            locale="id-ID"
        )

        for target in targets:
            try:
                items = scrape_target(page, target, tgl_info)
                all_scraped_items.extend(items)
            except Exception as e:
                print(f"⚠️ Gagal scrape target '{target}': {e}")

        browser.close()

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

if __name__ == "__main__":
    main()
