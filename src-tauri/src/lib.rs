use tauri::Manager;

// Dialog/drag-drop asset permissions are session-scoped. Re-authorize only the
// selected local image when restoring a saved task; never grant a whole directory.
#[tauri::command]
fn allow_image_preview(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let file = std::path::PathBuf::from(path)
        .canonicalize()
        .map_err(|_| "原图片不存在或无法读取".to_string())?;
    let extension = file
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !file.is_file()
        || !matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "webp" | "bmp" | "tif" | "tiff")
    {
        return Err("仅支持本地图片预览".to_string());
    }
    app.asset_protocol_scope()
        .allow_file(&file)
        .map_err(|_| "无法授权当前图片预览".to_string())?;
    Ok(file.to_string_lossy().into_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let result = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![allow_image_preview])
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .run(tauri::generate_context!());
    if let Err(error) = result {
        let message = format!("本地 OCR 无法启动：{error}\n\n如果错误提示缺少 Microsoft Edge WebView2 Runtime，请在联网电脑从微软官网下载 Evergreen Standalone Installer（x64 完整离线安装包），复制到本机安装后重试。\n下载地址：https://developer.microsoft.com/microsoft-edge/webview2/\n\n不要选择需要联网的 Bootstrapper。其他错误请保留此信息用于排查。");
        #[cfg(target_os = "windows")]
        show_startup_error(&message);
        eprintln!("{message}");
        std::process::exit(1);
    }
}

// This message must be native: an HTML error screen cannot open if WebView2 is
// missing. No new installer payload or runtime download is added here.
#[cfg(target_os = "windows")]
fn show_startup_error(message: &str) {
    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(window: *mut std::ffi::c_void, text: *const u16, caption: *const u16, flags: u32) -> i32;
    }
    let text: Vec<u16> = message.encode_utf16().chain(Some(0)).collect();
    let caption: Vec<u16> = "本地 OCR — 启动失败".encode_utf16().chain(Some(0)).collect();
    unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), caption.as_ptr(), 0x10); }
}
