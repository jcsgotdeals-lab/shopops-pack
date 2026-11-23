// Camera barcode scanning. Uses the built-in BarcodeDetector where the browser
// has it (Android Chrome, macOS Chrome); otherwise our own Code 128 decoder.
import { decodeImageData } from './code128.js';

export class CameraScanner {
  constructor(videoEl, onCode) {
    this.video = videoEl;
    this.onCode = onCode;
    this.running = false;
    this.last = { code: null, at: 0 };
    this.canvas = document.createElement('canvas');
  }
  async start() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('This device or browser does not allow camera access. Use a USB scanner or type the code.');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
    });
    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', '');
    await this.video.play();
    this.detector = null;
    if ('BarcodeDetector' in window) {
      try {
        const formats = await window.BarcodeDetector.getSupportedFormats();
        if (formats.includes('code_128')) this.detector = new window.BarcodeDetector({ formats: ['code_128', 'qr_code', 'ean_13', 'upc_a', 'code_39'].filter(f => formats.includes(f)) });
      } catch (e) { this.detector = null; }
    }
    this.running = true;
    this.loop();
  }
  stop() {
    this.running = false;
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }
  emit(code) {
    const now = Date.now();
    if (code === this.last.code && now - this.last.at < 2500) return; // same sticker still in view
    this.last = { code, at: now };
    this.onCode(code);
  }
  async loop() {
    if (!this.running) return;
    try {
      const v = this.video;
      if (v.readyState >= 2 && v.videoWidth) {
        let code = null;
        if (this.detector) {
          const found = await this.detector.detect(v);
          if (found.length) code = found[0].rawValue;
        } else {
          // crop centre band, downscale for speed
          const w = Math.min(960, v.videoWidth), h = Math.round(w * v.videoHeight / v.videoWidth);
          const c = this.canvas; c.width = w; c.height = h;
          const g = c.getContext('2d', { willReadFrequently: true });
          g.drawImage(v, 0, 0, w, h);
          const band = g.getImageData(0, Math.round(h * 0.3), w, Math.round(h * 0.4));
          code = decodeImageData(band);
        }
        if (code) this.emit(code.trim());
      }
    } catch (e) { /* frame errors are transient */ }
    setTimeout(() => this.loop(), this.detector ? 120 : 80);
  }
}
