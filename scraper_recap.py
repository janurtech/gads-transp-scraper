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
    """Memastikan token dan chat id sudah dimasukkan di GitHub Secrets"""
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        print("\n" + "="*60)
        print("❌ ERROR: Kredensial Telegram belum disetel di GitHub Secrets!")
        print("Pastikan Anda sudah menambahkan:")
        print("1. TELEGRAM_BOT_TOKEN (dari @BotFather)")
        print("2. TELEGRAM_CHAT_ID (dari @userinfobot)")
        print("di menu Settings > Secrets and variables > Actions")
        print("="*60 + "\n")
        sys.exit(1)

def baca_daftar_kompetitor():
    """Membaca URL target dari file competitors.txt"""
    targets = []
    if not os.path.exists("competitors.txt"):
        print("⚠️ File competitors.txt tidak ditemukan!")
        return targets

    with open("competitors.txt", "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                url = line.split("#")[0].strip()
                if "adstransparency.google.com" in url:
                    targets.append(url)
    return targets

def extract_target_url(raw_href):
    """Mengekstrak landing page asli dari parameter redirect Google"""
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

def is_internal_domain(url_str):
    try:
        domain = urlparse(url_str).netloc.lower()
        internal = ['google.', '.google', 'gstatic.', 'youtube.com', 'youtu.be', 'doubleclick.net', 'googlesyndication.com', 'schema.org', 'w3.org']
        return any(x in domain for x in internal)
    except Exception:
        return False

def set_filter_tanggal_h_minus_1(page):
    """Mengatur filter tanggal ke H-1 (Kemarin / Yesterday) di Google Ads Transparency UI"""
    print("📅 [2/4] Mengatur filter tanggal ke H-1 (Kemarin)...")
    try:
        # 1. Cari elemen date-range-filter
        date_filter = page.locator("date-range-filter, [role='button']:has-text('rentang'), [role='button']:has-text('date'), button:has-text('Rentang')").first
        if date_filter.count() > 0:
            date_filter.click()
            page.wait_for_timeout(1200)

            # 2. Cari opsi menu "Kemarin" (ID) atau "Yesterday" (EN)
            option_kemarin = page.locator("text=/^(Kemarin|Yesterday)$/i, [role='option']:has-text('Kemarin'), [role='menuitem']:has-text('Kemarin'), [role='option']:has-text('Yesterday'), [role='menuitem']:has-text('Yesterday')").first
            
            if option_kemarin.count() == 0:
                option_kemarin = page.get_by_text(re.compile(r"^(kemarin|yesterday)", re.I)).first

            if option_kemarin.count() > 0:
                option_kemarin.click()
                print("✅ Filter tanggal H-1 (Kemarin) BERHASIL dipilih di UI!")
                page.wait_for_timeout(3000)
                return True
            else:
                print("ℹ️ Menu 'Kemarin' tidak terlihat, mencoba selector alternatif...")
                # Tekan tombol ESC untuk menutup menu jika tidak ditemukan
                page.keyboard.press("Escape")
    except Exception as e:
        print(f"⚠️ Catatan filter tanggal UI: {e}")
    return False

def scrape_advertiser(page, advertiser_url, tgl_info):
    """Buka halaman profil kompetitor, terapkan filter H-1, auto-scroll, dan ekstrak iklan"""
    kemarin_iso = tgl_info["iso"]

    # Tambahkan parameter tanggal H-1 ke URL jika belum ada
    target_url = advertiser_url
    if "start-date=" not in target_url and "start_date=" not in target_url:
        sep = "&" if "?" in target_url else "?"
        target_url = f"{target_url}{sep}start-date={kemarin_iso}&end-date={kemarin_iso}"

    print(f"\n🔍 [1/4] Mengunjungi target: {target_url}")
    page.goto(target_url, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(4000)

    # Tangkap nama pengiklan
    advertiser_name = "Pengiklan"
    try:
        adv_heading = page.locator("h1, .advertiser-name, [role='heading']").first
        if adv_heading.count() > 0:
            advertiser_name = adv_heading.text_content().strip()
    except Exception:
        pass
    print(f"🏢 Pengiklan: {advertiser_name}")

    # Set tanggal H-1 lewat UI untuk memastikan data terfilter akurat
    set_filter_tanggal_h_minus_1(page)

    # Auto-Scroll sampai materi iklan termuat
    print("⏳ [3/4] Sedang auto-scroll memuat seluruh materi iklan H-1...")
    last_height = page.evaluate("document.body.scrollHeight")
    attempts = 0
    max_scrolls = 15

    for i in range(max_scrolls):
        page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        page.wait_for_timeout(1500)
        new_height = page.evaluate("document.body.scrollHeight")
        if new_height == last_height:
            attempts += 1
            if attempts >= 3:
                break
        else:
            last_height = new_height
            attempts = 0

    print("🔎 [4/4] Memindai seluruh frame & elemen materi iklan...")
    page_data = []
    all_links = set()

    # 1. Ambil link dari main page
    try:
        main_links = page.evaluate("() => Array.from(document.querySelectorAll('a')).map(a => a.href)")
        for l in main_links:
            if l: all_links.add(l)
    except Exception:
        pass

    # 2. Ambil link dari seluruh child iframes
    for frame in page.frames:
        try:
            f_links = frame.evaluate("() => Array.from(document.querySelectorAll('a')).map(a => a.href)")
            for l in f_links:
                if l: all_links.add(l)
        except Exception:
            pass

    # 3. Scan regex dari seluruh isi HTML halaman
    html_content = page.content()
    dest_matches = re.findall(r'destination_url[\'":\s]+(https?:\/\/[^\'"\s\\&]+)', html_content)
    for dm in dest_matches:
        all_links.add(dm)

    # Ekstraksi YouTube Video ID
    yt_matches = re.findall(r'(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/|ytimg\.com\/vi\/)([a-zA-Z0-9_-]{11})', html_content)
    default_yt = f"https://youtu.be/{yt_matches[0]}" if yt_matches else "-"

    for raw_link in all_links:
        real_url = extract_target_url(raw_link)
        if real_url and not is_internal_domain(real_url):
            clean_url = real_url.split("?")[0].rstrip("/")
            if len(clean_url) > 10:
                page_data.append({
                    "url": clean_url,
                    "advertiser": advertiser_name,
                    "youtubeUrl": default_yt
                })

    print(f"📦 Ditemukan {len(page_data)} materi iklan H-1 untuk {advertiser_name}.")
    return page_data

def hitung_performa_dan_rekomendasi(all_items):
    """Agregasi total tayangan, ranking, skor performa, dan label rekomendasi"""
    product_map = {}

    for item in all_items:
        url = item["url"]
        if url not in product_map:
            path_parts = [p for p in urlparse(url).path.split("/") if p]
            product_name = path_parts[-1].replace("-", " ").title() if path_parts else urlparse(url).netloc

            product_map[url] = {
                "nama": product_name,
                "brand": f"{urlparse(url).netloc} • {item['advertiser']}",
                "url": url,
                "youtubeUrl": item.get("youtubeUrl", "-"),
                "totalTayangan": 0,
                "hariAktif": 1, # Periode H-1 spesifik
                "tren": "Stabil"
            }
        product_map[url]["totalTayangan"] += 1

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

    products.sort(key=lambda x: x["skor"], reverse=True)
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
        print("⚠️ Tidak ada URL target yang ditemukan di competitors.txt.")
        kirim_ke_telegram(f"⚠️ *Laporan Ads Transparency (H-1: {tgl_info['display']})*\nFile `competitors.txt` kosong.")
        return

    print(f"🎯 Ditemukan {len(targets)} target kompetitor di competitors.txt.")
    all_scraped_items = []

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
        )
        page = browser.new_page(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        )

        for target_url in targets:
            try:
                items = scrape_advertiser(page, target_url, tgl_info)
                all_scraped_items.extend(items)
            except Exception as e:
                print(f"⚠️ Gagal scrape {target_url}: {e}")

        browser.close()

    ranked_products = hitung_performa_dan_rekomendasi(all_scraped_items)

    if not ranked_products:
        print("⚠️ Tidak ada produk materi iklan yang terdeteksi pada H-1.")
        pesan_kosong = f"📊 *REKAP PERFORMA PRODUK TERPANTAU*\n"
        pesan_kosong += f"📅 *Periode Riset: H-1 (Kemarin, {tgl_info['display']})*\n\n"
        pesan_kosong += f"ℹ️ Robot berhasil memeriksa {len(targets)} pengiklan, namun tidak menemukan materi iklan yang aktif pada tanggal kemarin ({tgl_info['display']})."
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
