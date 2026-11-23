// Sounds, voice and vibration for scan results.
let ctx;
function tone(freq, ms, type = 'sine', when = 0, gain = 0.18) {
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.value = gain;
    o.connect(g); g.connect(ctx.destination);
    const t = ctx.currentTime + when;
    o.start(t);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
    o.stop(t + ms / 1000 + 0.02);
  } catch (e) { /* audio unavailable */ }
}

export function feedback(kind, settings, speech) {
  if (settings.sounds) {
    if (kind === 'ok') { tone(880, 90); tone(1320, 120, 'sine', 0.09); }
    else if (kind === 'done') { tone(660, 100); tone(880, 100, 'sine', 0.1); tone(1320, 200, 'sine', 0.2); }
    else if (kind === 'warn') { tone(440, 160, 'triangle'); }
    else { tone(220, 250, 'square', 0, 0.12); tone(180, 300, 'square', 0.27, 0.12); }
  }
  if (settings.vibrate && navigator.vibrate) {
    navigator.vibrate(kind === 'ok' ? 40 : kind === 'done' ? [40, 60, 40] : [200, 80, 200]);
  }
  const tts = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.TextToSpeech;
  if (settings.voice && speech && tts && window.Capacitor.isNativePlatform()) {
    tts.stop().catch(() => {}).finally(() => tts.speak({ text: speech, lang: 'en-US', rate: 1.15 }).catch(() => {}));
  } else if (settings.voice && speech && 'speechSynthesis' in window) {
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(speech);
      u.rate = 1.15; u.lang = 'en-US';
      speechSynthesis.speak(u);
    } catch (e) { /* no voice */ }
  }
}
