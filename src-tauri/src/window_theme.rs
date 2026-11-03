//! Native title bar theming. Windows: DWM attributes so the native caption matches
//! DESIGN.md tokens while keeping Snap Layouts. Other OSes: no-op (native decorations
//! follow the system theme, and the webview sets `data-theme`).

use crate::error::Result;
use crate::model::ResolvedTheme;

/// (caption bg, caption text, border) as 0xRRGGBB, from DESIGN.md §2 (`bg`, `fg`, `line`).
pub fn colors(theme: ResolvedTheme) -> (u32, u32, u32) {
    match theme {
        ResolvedTheme::Dark => (0x14130F, 0xE9E4D8, 0x2E2B25),
        ResolvedTheme::Light => (0xF4F0E6, 0x1E1C18, 0xD6CFBE),
    }
}

/// DWM wants COLORREF = 0x00BBGGRR.
pub fn to_colorref(rgb: u32) -> u32 {
    let r = (rgb >> 16) & 0xFF;
    let g = (rgb >> 8) & 0xFF;
    let b = rgb & 0xFF;
    (b << 16) | (g << 8) | r
}

#[cfg(windows)]
pub fn apply(window: &tauri::WebviewWindow, theme: ResolvedTheme) -> Result<()> {
    use windows::core::BOOL;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR,
        DWMWA_USE_IMMERSIVE_DARK_MODE,
    };

    let hwnd = window
        .hwnd()
        .map_err(|e| crate::error::Error::Internal(format!("no window handle: {e}")))?;
    let hwnd = HWND(hwnd.0);
    let (caption, text, border) = colors(theme);

    // Windows 10 fallback (and harmless on 11): dark/light caption controls.
    let dark = BOOL::from(theme == ResolvedTheme::Dark);
    // SAFETY: valid HWND owned by this process; pointer/size describe a live BOOL.
    unsafe {
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE,
            std::ptr::from_ref(&dark).cast(),
            std::mem::size_of::<BOOL>() as u32,
        );
    }
    // Windows 11 (build 22000+): exact colours. Older builds reject these; ignore failure.
    for (attr, rgb) in [(DWMWA_CAPTION_COLOR, caption), (DWMWA_TEXT_COLOR, text), (DWMWA_BORDER_COLOR, border)] {
        let colorref = to_colorref(rgb);
        // SAFETY: as above; pointer/size describe a live u32 COLORREF.
        unsafe {
            let _ = DwmSetWindowAttribute(
                hwnd,
                attr,
                std::ptr::from_ref(&colorref).cast(),
                std::mem::size_of::<u32>() as u32,
            );
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn apply(_window: &tauri::WebviewWindow, _theme: ResolvedTheme) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colorref_swaps_red_and_blue() {
        assert_eq!(to_colorref(0x14130F), 0x0F1314);
        assert_eq!(to_colorref(0xF4F0E6), 0xE6F0F4);
    }
}
