// GTK stores text DPI in 1024ths.
const BASELINE_DPI: i32 = 96 * 1024;

pub(super) fn pinned_dpi(current_dpi: i32) -> Option<i32> {
    if current_dpi == BASELINE_DPI {
        None
    } else {
        Some(BASELINE_DPI)
    }
}

#[cfg(test)]
#[path = "gtk_text_dpi_tests.rs"]
mod tests;
