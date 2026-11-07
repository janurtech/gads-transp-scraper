import os
import sys
import re
import csv
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
        "file_date": kemarin_wib.strftime("%Y%m%d"),
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

    # Network listener terisolasi untuk page ini
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
        print(f"🔍 [1/3] Mengunjungi URL langsung: {target_url}")
        await page.goto(target_url, wait_until="domcontentloaded", timeout=45000)
        await page.wait_for_timeout(3000)
    else:
        # Buka Ads Transparency dengan filter tanggal H-1
        base_url = f"https://adstransparency.google.com/?region=ID&start-date={kemarin_iso}&end-date={kemarin_iso}"
        print(f"🔍 [1/3] Membuka beranda: {base_url}")
        await page.goto(base_url, wait_until="domcontentloaded", timeout=45000)
        await page.wait_for_timeout(3000)

        # Siapkan variasi nama (dengan PT dan tanpa PT)
        query_variants = [target_raw]
        clean_no_pt = re.sub(r'^PT\.?\s*', '', target_raw, flags=re.I).strip()
        if clean_no_pt and clean_no_pt.lower() != target_raw.lower():
            query_variants.append(clean_no_pt)

        search_success = False
        dropdown_selectors = [
            'div[role="listbox"] [role="option"]',
            '[role="option"]',
            'material-select-item',
            '.prediction-item',
            'text--suggestion',
            '.name'
        ]

        for q in query_variants:
            print(f"⌨️ Mencari: '{q}'...")
            search_input = page.locator("input[type='text'], input[role='combobox']").first
            if await search_input.count() > 0:
                await search_input.click()
                await search_input.fill("")
                await search_input.press_sequentially(q, delay=80)
                await page.wait_for_timeout(2500)

                for sel in dropdown_selectors:
                    try:
                        options = page.locator(sel)
                        cnt = await options.count()
                        if cnt > 0:
                            for i in range(min(cnt, 4)):
                                txt = await options.nth(i).text_content()
                                if q.lower() in txt.lower() or "pengiklan" in txt.lower() or "advertiser" in txt.lower():
                                    print(f"👉 Mengklik suggestion menu: {txt.strip()[:50]}...")
                                    await options.nth(i).click()
                                    search_success = True
                                    break
                        if search_success:
                            break
                    except Exception:
                        pass

            if search_success:
                break
            else:
                print(f"ℹ️ Saran tidak langsung ditemukan untuk '{q}', mencoba varian berikutnya jika ada...")

        if not search_success:
            print("⌨️ Fallback: Menekan tombol ArrowDown + Enter...")
            await page.keyboard.press("ArrowDown")
            await page.wait_for_timeout(400)
            await page.keyboard.press("Enter")

        try:
            await page.wait_for_selector('creative-preview, a[href*="/creative/"]', timeout=10000)
            print("✅ Halaman hasil materi iklan berhasil dimuat!")
        except Exception:
            pass

    # Ambil judul nama pengiklan resmi dari halaman
    try:
        h_el = page.locator("h1, .advertiser-name, [role='heading']").first
        if await h_el.count() > 0:
            txt = (await h_el.text_content()).strip()
            if len(txt) > 2 and "transparansi" not in txt.lower():
                detected_brand_name = txt
    except Exception:
        pass
    print(f"🏢 Pengiklan Terdeteksi: {detected_brand_name}")
    print(f"📄 URL Aktif: {page.url}")

    # 2. Auto-scroll bertahap untuk memuat iklan
    print("⏳ [2/3] Sedang auto-scroll memuat materi iklan...")
    for _ in range(15):
        await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        await page.wait_for_timeout(900)

    # 3. Ekstraksi kartu iklan murni dari DOM
    print("🔎 [3/3] Membaca kartu materi iklan dari layar...")
    try:
        dom_cards = await page.evaluate("""() => {
            const results = [];
            const seen = new Set();
            
            function scan(root) {
                if (!root) return;
                
                const elements = root.querySelectorAll('creative-preview, a[href*="/creative/"]');
                elements.forEach(el => {
                    let text = el.innerText || el.textContent || '';
                    let href = el.href || el.getAttribute('href') || '';
                    
                    let ytId = '';
                    const imgs = el.querySelectorAll('img');
                    imgs.forEach(img => {
                        const src = img.src || img.getAttribute('src') || '';
                        const m = src.match(/(?:ytimg\\.com\\/vi\\/|youtu\\.be\\/|youtube\\.com\\/embed\\/)([a-zA-Z0-9_-]{11})/);
                        if (m) ytId = m[1];
                    });

                    const iframes = el.querySelectorAll('iframe');
                    iframes.forEach(f => {
                        const src = f.src || f.getAttribute('src') || '';
                        const m = src.match(/(?:ytimg\\.com\\/vi\\/|youtu\\.be\\/|youtube\\.com\\/embed\\/)([a-zA-Z0-9_-]{11})/);
                        if (m) ytId = m[1];
                    });

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

                const all = root.querySelectorAll('*');
                all.forEach(el => {
                    if (el.shadowRoot) scan(el.shadowRoot);
                });
            }
            
            scan(document);
            return results;
        }""")

        print(f"📋 Ditemukan {len(dom_cards)} kartu materi iklan di DOM untuk {detected_brand_name}.")

        for cd in dom_cards:
            hl = cd.get("headline", "").strip()
            yt_id = cd.get("ytId")
            yt_url = f"https://youtu.be/{yt_id}" if yt_id else "-"
            lk = cd.get("href") or "https://adstransparency.google.com"
            if lk.startswith("/"):
                lk = f"https://adstransparency.google.com{lk}"

            captured_ads.append({
                "url": lk,
                "headline": hl or "Materi Iklan Video",
                "youtubeUrl": yt_url,
                "advertiser": detected_brand_name
            })
    except Exception as e:
        print(f"⚠️ Catatan DOM scan: {e}")

    print(f"📦 Total materi iklan terhimpun untuk {detected_brand_name}: {len(captured_ads)} materi.")
    return captured_ads

def hitung_performa_dan_rekomendasi(all_items):
    product_map = {}

    for item in all_items:
        raw_url = item.get("url", "")
        headline = item.get("headline", "").strip()
        yt_url = item.get("youtubeUrl", "-")

        clean_headline = re.sub(r'^(Sponsored|Disponsori|Iklan|00:00)\s*', '', headline, flags=re.I).strip()
        
        nama_produk = clean_headline
        if not nama_produk or len(nama_produk) < 4:
            path_parts = [p for p in urlparse(raw_url).path.split("/") if p]
            if path_parts and "creative" not in path_parts[-1]:
                nama_produk = path_parts[-1].replace("-", " ").title()
            else:
                nama_produk = "Produk Unggulan"

        if len(nama_produk) > 55:
            nama_produk = nama_produk[:52] + "..."

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

        if product_map[agg_key]["youtubeUrl"] == "-" and yt_url != "-":
            product_map[agg_key]["youtubeUrl"] = yt_url

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

def simpan_ke_csv(products, filename, tanggal_str):
    with open(filename, mode='w', newline='', encoding='utf-8-sig') as f:
        writer = csv.writer(f)
        writer.writerow(["Tanggal", "Rank", "Nama Produk", "Brand / Pengiklan", "Total Tayangan", "Skor Performa", "Rekomendasi", "URL Landing Page", "Link YouTube"])
        for idx, p in enumerate(products, 1):
            writer.writerow([
                tanggal_str,
                f"#{idx}",
                p["nama"],
                p["brand"],
                p["totalTayangan"],
                p["skor"],
                p["rek"],
                p["url"],
                p["youtubeUrl"]
            ])

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
            print("✅ Berhasil kirim pesan teks ke Telegram!")
        else:
            print(f"❌ Gagal kirim Telegram: {resp.text}")
    except Exception as e:
        print(f"❌ Error koneksi ke Telegram API: {e}")

def kirim_file_ke_telegram(file_path, caption):
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendDocument"
    try:
        with open(file_path, "rb") as f:
            files = {"document": f}
            data = {
                "chat_id": TELEGRAM_CHAT_ID,
                "caption": caption,
                "parse_mode": "Markdown"
            }
            resp = requests.post(url, data=data, files=files, timeout=30)
            if resp.status_code == 200:
                print("✅ Berhasil kirim file CSV ke Telegram!")
            else:
                print(f"❌ Gagal kirim file ke Telegram: {resp.text}")
    except Exception as e:
        print(f"❌ Error kirim file: {e}")

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
    target_stats = {}

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
        )

        for target in targets:
            try:
                # Buka Tab Baru Bersih untuk setiap target agar tidak bentrok
                page = await browser.new_page(
                    user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    locale="id-ID"
                )
                print(f"\n" + "="*50)
                print(f"🚀 Memulai scrape untuk: {target}")
                items = await scrape_target(page, target, tgl_info)
                await page.close()

                all_scraped_items.extend(items)
                target_stats[target] = len(items)
                print(f"✅ Selesai: {target} menghasilkan {len(items)} materi iklan.")
                print("="*50 + "\n")
            except Exception as e:
                print(f"⚠️ Gagal scrape target '{target}': {e}")
                target_stats[target] = 0

        await browser.close()

    ranked_products = hitung_performa_dan_rekomendasi(all_scraped_items)

    if not ranked_products:
        print("⚠️ Tidak ada produk materi iklan yang terdeteksi.")
        pesan_kosong = f"📊 *REKAP PERFORMA PRODUK TERPANTAU*\n"
        pesan_kosong += f"📅 *Periode Riset: H-1 (Kemarin, {tgl_info['display']})*\n\n"
        pesan_kosong += f"ℹ️ Robot berhasil mengecek {len(targets)} pengiklan, namun tidak ada materi iklan yang aktif pada tanggal kemarin ({tgl_info['display']})."
        kirim_ke_telegram(pesan_kosong)
        return

    # 1. Simpan CSV Lengkap Berisi Seluruh Produk dari Semua Pengiklan
    csv_filename = f"Rekap_Iklan_H1_{tgl_info['file_date']}.csv"
    simpan_ke_csv(ranked_products, csv_filename, tgl_info['display'])

    # 2. Susun Teks Ringkasan Target
    ringkasan_target = "\n".join([f"• *{t}:* {count} materi" for t, count in target_stats.items()])

    # 3. Kirim Pesan Teks: Khusus TOP 25 Produk Pemenang
    limit_products = ranked_products[:25]
    total_batch = (len(limit_products) + 12) // 13

    for batch_idx in range(total_batch):
        chunk = limit_products[batch_idx * 13 : (batch_idx + 1) * 13]
        
        pesan = f"📊 *REKAP PERFORMA PRODUK TERPANTAU* (Bagian {batch_idx + 1}/{total_batch})\n"
        pesan += f"📅 *Periode Riset: H-1 (Kemarin, {tgl_info['display']})*\n"
        pesan += f"🎯 *Status Pengiklan:*\n{ringkasan_target}\n"
        pesan += f"📦 *Total Terkumpul:* {len(ranked_products)} Produk Unik\n"
        pesan += f"🏆 *Menampilkan Top 25 Produk Teratas*\n\n"

        start_num = (batch_idx * 13) + 1
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

    # 4. Kirim File CSV Lampiran Berisi SELURUH Data
    caption_csv = f"📁 *DATA LENGKAP {len(ranked_products)} PRODUK TERPANTAU*\n"
    caption_csv += f"📅 Periode: {tgl_info['display']}\n"
    caption_csv += f"💡 _Buka file ini di Excel/Spreadsheet untuk melihat seluruh link landing page dan link video YouTube dari semua pengiklan._"
    kirim_file_ke_telegram(csv_filename, caption_csv)

    try:
        os.remove(csv_filename)
    except Exception:
        pass

def main():
    asyncio.run(async_main())

if __name__ == "__main__":
    main()
