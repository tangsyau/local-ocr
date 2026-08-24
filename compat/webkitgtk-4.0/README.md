# WebKitGTK 4.0 compatibility shell

This directory contains the Tauri 1 shell used only for the Linux x64
WebKitGTK 4.0 AppImage. The Vue frontend and Python OCR sidecar remain shared
with the main Tauri 2/WebKitGTK 4.1 build.

The GitHub Actions workflow builds this shell inside a Debian 11 container.
Do not replace the main `src-tauri` directory with this compatibility shell.

It intentionally produces only an AppImage. The main Linux artifact keeps the
Tauri 2/WebKitGTK 4.1 build, so users can select one of the two AppImages for
their distribution. The compatibility frontend is built with
`VITE_WEBKITGTK_4_0=1` and uses `window.__TAURI__` through the shared bridge.
