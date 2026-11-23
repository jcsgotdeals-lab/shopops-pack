#!/usr/bin/env bash
# Adds camera + vibration permissions and the app icon to the generated Android project.
set -euo pipefail
M=android/app/src/main/AndroidManifest.xml
grep -q 'android.permission.CAMERA' "$M" || sed -i 's#<uses-permission android:name="android.permission.INTERNET" />#<uses-permission android:name="android.permission.INTERNET" />\n    <uses-permission android:name="android.permission.CAMERA" />\n    <uses-permission android:name="android.permission.VIBRATE" />\n    <uses-feature android:name="android.hardware.camera" android:required="false" />#' "$M"
grep -q 'android.permission.CAMERA' "$M" || { echo "Could not add camera permission"; exit 1; }
# Text-to-speech engine visibility (Android 11+)
grep -q 'TTS_SERVICE' "$M" || sed -i 's#<application#<queries><intent><action android:name="android.intent.action.TTS_SERVICE" /></intent></queries>\n    <application#' "$M"
# Launcher icons
for d in mdpi:48 hdpi:72 xhdpi:96 xxhdpi:144 xxxhdpi:192; do
  dir=android/app/src/main/res/mipmap-${d%%:*}
  mkdir -p "$dir"
  cp android-extras/icons/ic_launcher_${d##*:}.png "$dir/ic_launcher.png"
  cp android-extras/icons/ic_launcher_${d##*:}.png "$dir/ic_launcher_round.png"
  cp android-extras/icons/ic_launcher_${d##*:}.png "$dir/ic_launcher_foreground.png"
done
rm -f android/app/src/main/res/mipmap-anydpi-v26/ic_launcher*.xml
echo "Android project patched."
