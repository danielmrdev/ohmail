//! THE APP OWNS ITS SCALE. What size the window draws at is this app's Settings → Text size and
//! nothing else.
//!
//! Linux: `gtk_text_dpi.rs` pins GTK's text DPI at 96 once, at launch, so the desktop's
//! `text-scaling-factor` never reaches WebKit's canvas (issue #14). GTK can re-read that setting
//! while the app runs — the desktop's value changing is measured to shrink the live window — so
//! the pin is held here too, from a `notify::gtk-xft-dpi` handler applying the same policy.
//!
//! Every platform: Text size is the webview's own page zoom, kept for the next launch so the
//! window's first frame is already drawn at it.

use std::path::Path;

/// The sizes Settings offers, in percent. The page's `TEXT_SIZES` is the same list.
pub const SIZES: [u32; 5] = [90, 100, 110, 125, 150];

/// The size kept for the next launch, beside the app's other files: the number and a newline.
pub const KEPT_FILE: &str = "text-size";

/// The page zoom for a size Settings offers, or `None` for anything else.
pub fn zoom_for(percent: u32) -> Option<f64> {
    SIZES.contains(&percent).then(|| f64::from(percent) / 100.0)
}

/// The one property the pin reads and writes. GTK's settings object in the app; a recording
/// double in the tests, which notifies on every write the way GObject does.
#[cfg(target_os = "linux")]
pub trait DpiSetting {
    fn dpi(&self) -> i32;
    fn set_dpi(&self, value: i32);
}

/// Put the pinned value back if something moved it, by `gtk_text_dpi`'s policy. Writing only on a
/// difference is what keeps the notify handler from looping: its own write notifies once more and
/// finds nothing to do. Answers whether it wrote.
#[cfg(target_os = "linux")]
pub fn hold<S: DpiSetting + ?Sized>(setting: &S) -> bool {
    match crate::gtk_text_dpi::pinned_dpi(setting.dpi()) {
        Some(value) => {
            setting.set_dpi(value);
            true
        }
        None => false,
    }
}

#[cfg(target_os = "linux")]
mod gtk_pin {
    use gtk::prelude::GtkSettingsExt;

    impl super::DpiSetting for gtk::Settings {
        fn dpi(&self) -> i32 {
            self.gtk_xft_dpi()
        }
        fn set_dpi(&self, value: i32) {
            self.set_gtk_xft_dpi(value);
        }
    }

    pub fn keep() {
        if !gtk::is_initialized_main_thread() {
            return;
        }
        if let Some(settings) = gtk::Settings::default() {
            super::hold(&settings);
            settings.connect_gtk_xft_dpi_notify(|s| {
                super::hold(s);
            });
        }
    }
}

/// Keep GTK's text DPI pinned for the rest of the run: `main` calls this right after the launch
/// pin. A no-op off Linux, and where GTK is not up.
pub fn keep_text_dpi_pinned() {
    #[cfg(target_os = "linux")]
    gtk_pin::keep();
}

/// The size the last launch kept, when it is one Settings offers. Bounded read: this app writes
/// four bytes at most.
pub fn read_kept(dir: &Path) -> Option<u32> {
    use std::io::Read;
    let mut text = String::new();
    std::fs::File::open(dir.join(KEPT_FILE)).ok()?.take(16).read_to_string(&mut text).ok()?;
    let percent: u32 = text.trim().parse().ok()?;
    zoom_for(percent).map(|_| percent)
}

/// Keep a size for the next launch, written only when it changed. Best effort: a lost write costs
/// the next launch one frame at the old size, and the page's boot stamp corrects it.
#[cfg_attr(not(feature = "local-engine"), allow(dead_code))]
pub fn keep(dir: &Path, percent: u32) -> std::io::Result<()> {
    if zoom_for(percent).is_none() || read_kept(dir) == Some(percent) {
        return Ok(());
    }
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!("{KEPT_FILE}.tmp"));
    std::fs::write(&tmp, format!("{percent}\n"))?;
    std::fs::rename(&tmp, dir.join(KEPT_FILE))
}

/// From the one `setup`, right after the main window is built and before it is shown: the kept
/// size is the window's zoom from its first frame. Nothing kept is the default, 100%.
pub fn prepare<R: tauri::Runtime>(app: &tauri::App<R>) {
    use tauri::Manager;
    let Some(percent) = app.path().app_data_dir().ok().as_deref().and_then(read_kept) else {
        return;
    };
    if let (Some(zoom), Some(window)) = (zoom_for(percent), app.get_webview_window("main")) {
        if percent != 100 {
            let _ = window.set_zoom(zoom);
        }
    }
}

/// Settings → Text size, from the page: the main window's zoom, kept for the next launch. Only
/// the five sizes are taken; the page's own storage stays the setting and this follows it.
#[cfg(feature = "local-engine")]
#[tauri::command]
pub fn set_text_size<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    percent: u32,
) -> Result<(), String> {
    use tauri::Manager;
    if window.label() != "main" {
        return Err("text size is the main window's".into());
    }
    let zoom = zoom_for(percent).ok_or_else(|| format!("not a text size: {percent}"))?;
    window.set_zoom(zoom).map_err(|e| e.to_string())?;
    if let Ok(dir) = window.app_handle().path().app_data_dir() {
        let _ = keep(&dir, percent);
    }
    Ok(())
}

#[cfg(test)]
#[path = "text_scale_tests.rs"]
mod tests;
