# Bacain Dong

Chrome extension (Manifest V3) untuk **membacakan halaman web**, menyimpan halaman sebagai draft lokal, lalu menyinkronkannya ke Google Drive.

## Fitur

- Klik icon extension → popup **Active / Deactive** (per tab).
- Saat **Active**, panel mengambang muncul di pojok kanan bawah halaman:
  - **Persentase** halaman yang sudah di-scroll atau dibaca (mana yang lebih jauh).
  - **Play / Pause** — satu tombol bergantian: saat belum jalan/di-pause yang tampil Play, saat jalan yang tampil Pause. Play membacakan teks halaman (text-to-speech bawaan browser), mulai dari bagian yang sedang terlihat, paragraf yang dibaca di-highlight dan halaman ikut ter-scroll.
  - **Stop** — hentikan bacaan dan reset posisi baca.
  - **Save to draft** — simpan halaman ke folder baru bernama judul halaman.
  - **Sync** — login Google lalu upload semua folder draft yang belum ada di Google Drive.

## Instalasi

1. Buka `chrome://extensions`
2. Aktifkan **Developer mode** (kanan atas)
3. Klik **Load unpacked** → pilih folder project ini
4. Buka halaman web apa pun → klik icon extension → **Active**

Content script di-inject saat popup dibuka (permission `activeTab`), jadi tidak perlu reload tab. Tanpa host permission.

## Draft

**Save to draft** menyimpan halaman utuh (HTML + CSS + gambar, format MHTML via `chrome.pageCapture`) ke folder Downloads Chrome:

```
~/Downloads/Bacain Dong/<judul halaman>/<judul halaman>.mhtml
~/Downloads/Bacain Dong/<judul halaman>/meta.json     # judul, url, waktu simpan
```

- Judul yang sama disimpan lagi → folder baru `<judul> (2)`, `<judul> (3)`, dst.
- Karakter yang tidak boleh di nama folder (`/ \ : * ? " < > |`) diganti `-`; nama dipotong 80 karakter.
- Browser tidak boleh membaca isi folder Downloads, jadi salinan draft juga disimpan di IndexedDB extension (`unlimitedStorage`). Salinan inilah yang dipakai **Sync**.
- Buka file `.mhtml` dengan Chrome (drag ke tab atau double-click) untuk membaca ulang halaman.

## Sync ke Google Drive

Hasil di Drive: `My Drive/Bacain Dong/<judul halaman>/` berisi `.mhtml` dan `meta.json`.

- Folder yang sudah ada di Drive (nama sama) dilewati; yang belum ada diupload.
- Folder di Drive dianggap selesai hanya setelah file terakhirnya terupload (penanda `appProperties.complete = '1'`). Kalau upload gagal di tengah jalan, folder setengah jadi dihapus; kalau penghapusan ikut gagal, folder itu tetap tidak dianggap selesai dan diulang di sync berikutnya.
- Scope OAuth hanya `drive.file`: extension hanya melihat file/folder yang dia buat sendiri.

### Setup OAuth (wajib sekali, supaya tombol Sync jalan)

Extension butuh OAuth client ID milik kamu sendiri:

1. `chrome://extensions` → Load unpacked → salin **ID** extension (32 karakter).
2. [Google Cloud Console](https://console.cloud.google.com) → buat project → **APIs & Services → Library** → aktifkan **Google Drive API**.
3. **OAuth consent screen** → External → tambahkan scope `.../auth/drive.file`. Selama status **Testing**, hanya akun di **Test users** yang bisa login; supaya akun lain bisa, ubah ke **In production** (`drive.file` bukan scope sensitif, tanpa verifikasi Google).
4. **Credentials → Create credentials → OAuth client ID** → Application type **Chrome extension** → isi **Item ID** dengan ID dari langkah 1.
5. Tempel client ID ke `manifest.json`:

   ```json
   "oauth2": { "client_id": "1234567890-abc.apps.googleusercontent.com", ... }
   ```

6. Reload extension di `chrome://extensions`.

Selama `client_id` masih `YOUR_CLIENT_ID...`, tombol Sync menampilkan pesan error yang menunjuk ke sini.

ID extension unpacked bergantung pada path folder. Kalau folder dipindah, ID berubah dan client ID harus dibuat ulang — atau pasang field `key` di `manifest.json` supaya ID tetap.

Build dari Chrome Web Store punya **Item ID sendiri**, beda dengan build unpacked. Client ID di `manifest.json` harus dibuat dengan Item ID yang dipakai build yang dipublish (ulangi langkah 4 dengan Item ID dari CWS dashboard). Workflow release menolak publish ke store selama `client_id` masih placeholder.

## Batasan

- Sync mencocokkan folder berdasarkan **nama**: dua draft berjudul sama dari dua perangkat berbeda akan dianggap satu folder di Drive.
- Upload memakai `uploadType=multipart` satu request per file; halaman MHTML yang sangat besar (puluhan MB) di koneksi lambat bisa gagal, dan akan diulang di sync berikutnya.
- Panel hanya mengikuti scroll jendela utama (`document.scrollingElement`), bukan container scroll di dalam halaman.

## Deploy

Push tag → GitHub Actions build zip, lampirkan ke GitHub Release, dan (kalau secret CWS diisi) upload + publish ke Chrome Web Store.

```bash
git tag v1.0.1
git push origin v1.0.1
```

Tag `v1.0.1` → `manifest.json` version di-set ke `1.0.1` saat build. Tag dan versi wajib sama. Workflow memberi warning kalau `oauth2.client_id` masih placeholder.

### Aktifkan auto-publish ke Chrome Web Store

Tanpa secret, workflow cuma bikin GitHub Release (package tetap dihasilkan & diverifikasi). Untuk auto-upload ke store, tambahkan 4 secret di **Settings → Secrets and variables → Actions**:

| Secret | Isi |
|---|---|
| `CWS_EXTENSION_ID` | ID extension dari CWS dashboard (32 char) |
| `CWS_CLIENT_ID` | OAuth client ID dari Google Cloud Console |
| `CWS_CLIENT_SECRET` | OAuth client secret |
| `CWS_REFRESH_TOKEN` | Refresh token hasil OAuth sekali jalan |

Cara dapat kredensial CWS: publish manual pertama kali lewat dashboard, lalu ikuti [panduan `chrome-webstore-upload-cli`](https://github.com/fregante/chrome-webstore-upload-cli) untuk generate refresh token.

Build manual:

```bash
python build.py 1.0.1     # bump versi + rebuild zip di build/
```

## Struktur

```
manifest.json     # MV3 config
background.js     # service worker: simpan draft (MHTML), download, sync Google Drive
db.js             # IndexedDB draft store (dipakai background.js + offscreen.js)
offscreen.html/js # bikin blob: URL untuk chrome.downloads (service worker tak punya createObjectURL)
text.js           # helper pecah teks jadi potongan bacaan
content.js        # panel mengambang, progress, text-to-speech, tombol draft/sync
popup.html/js     # toggle Active / Deactive + inject content script on demand
generate_icons.py # generator icon PNG
build.py          # bikin zip siap upload ke Chrome Web Store
```
