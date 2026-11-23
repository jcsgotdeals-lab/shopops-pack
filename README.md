# ShopOps Pack

Packing app for TikTok Shop LIVE auctions. Every sold item gets a numbered sticker. After the show, each buyer gets a numbered tray, and you pack trays by scanning. Runs on Android phones and on any computer (Mac, Windows, Chromebook) from the same code. All data stays on the device.

## How a show works

1. **Shows → New show.**
2. **Stickers**: create a batch before you go live (for example "Toys", 300 stickers). Print the PDF on your thermal printer with 50 × 25 mm labels. Set the printer to "actual size". Name your TikTok listing after the batch, like "Toys #12", so the number shows on the packing slip.
3. **During the live**: stick the next sticker on each item as it sells and set it aside.
4. **Import**: in Seller Center, download the shipping labels with packing slips as one PDF and drop it in. You can add several PDFs from the same show, or an order CSV. Check the preview, type any sticker numbers it couldn't find, then tap **Create trays**. Buyers who won earliest get the lowest tray numbers.
5. **Trays**: download **Shipping labels in tray order**, and **Tray labels** if you want a label on each tray.
6. **Scan**: scan each sticker with a USB scanner or the phone camera. The screen shows the tray number and reads it out loud.
7. **Pack**: scan any item to open its tray, then scan each item as it goes in the box. An item from another buyer triggers an alarm. When every item is scanned, the tray is marked packed. Then go to **Next tray**.
8. **History**: search any buyer, order ID or sticker number across all shows.

**Settings** has label size, voice, beeps and vibration, a CSV export, and **Backup / Restore**. Back up regularly: the data lives only on the device, so restoring a backup is also how you move it to another device.

## Hardware

- Any USB or Bluetooth barcode scanner in keyboard mode. Click the scan box and scan.
- Phone camera: tap **Camera** on the Scan or Pack screen.
- Thermal label printer with 50 × 25 mm rolls. Other sizes can be set in Settings.

## Install

### Option A: web app (recommended; works on Android, Mac and Windows)

1. Create a GitHub repository and upload this whole folder to it.
2. In the repository, go to **Settings → Pages → Source: GitHub Actions**. The "Publish web app" workflow publishes it to `https://<your-user>.github.io/<repo>/`.
3. Open that address in Chrome on each device and choose **Install app** (on Android, ⋮ menu → Install app). After that it opens like a normal app and works offline.

### Option B: Android APK

The "Build Android APK" workflow builds the APK on GitHub on every push. Open **Actions → Build Android APK → latest run → Artifacts**, download `ShopOps-Pack-apk`, copy the APK to the phone and open it. Android will ask you to allow installing from this source. Push a tag such as `v1.0.0` to also get the APK on the Releases page.

The APK is unsigned for store use (debug build). That's fine for your own phones. Publishing to the Play Store needs a signing key.

### Try it locally on a computer

`python3 -m http.server 8080 --directory app`, then open http://localhost:8080.

## Limits in this version

- TikTok only, from its PDF and CSV exports. There's no live sale capture for Whatnot or eBay Live.
- One device per show. There's no real-time team sync between packers yet.
- The PDF reader was tested with a mock TikTok packing slip. Send a real (redacted) PDF from Seller Center to tune it to the exact layout.

## Project layout

- `app/`: the whole app (plain HTML, CSS and JS, no build step).
  - `src/importer.js` reads the PDFs and CSVs.
  - `src/labels.js` makes the sticker and label PDFs.
  - `src/code128.js` is the barcode encoder and camera decoder.
- `app/vendor/`: pdf-lib (MIT) and pdf.js (Apache-2.0).
- `.github/workflows/`: the web publishing and APK builds.
- `test/`: end-to-end tests and mock fixtures.
