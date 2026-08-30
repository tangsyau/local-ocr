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
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![allow_image_preview])
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .run(tauri::generate_context!())
        .expect("error while running Local OCR");
}
