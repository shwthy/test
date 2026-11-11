# Jetpack Arena APK (host a game from your phone)

The APK bundles the game page plus an embedded Node.js runtime that runs the game server on the phone.

## Get the APK
1. Create a GitHub repo and push this folder (keep the `.github` folder).
2. Repo -> Actions -> "Build APK" -> Run workflow (it also runs on every push to main).
3. When it finishes, open the run and download the `jetpack-arena-apk` artifact, unzip it, install `app-debug.apk` (allow "install unknown apps").

## Play
- Host: open the app -> HOST GAME -> turn on your hotspot -> tell friends the address shown -> START PLAYING.
- Friends: connect to the host's hotspot/Wi-Fi, then either open `http://<address>:3000` in Chrome, or open the app and use JOIN GAME.
- Keep the host's app open and screen on while playing.
