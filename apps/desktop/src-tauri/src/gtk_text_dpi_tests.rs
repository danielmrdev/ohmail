//! The GTK text DPI policy: non-baseline desktop text scales are pinned to 96 DPI.

use super::pinned_dpi;

#[test]
fn a_sub_baseline_text_scale_is_pinned_to_96_dpi() {
    assert_eq!(pinned_dpi(89_368), Some(98_304));
}

#[test]
fn an_above_baseline_text_scale_is_pinned_to_96_dpi() {
    assert_eq!(pinned_dpi(112_640), Some(98_304));
}

#[test]
fn the_96_dpi_baseline_is_left_unchanged() {
    assert_eq!(pinned_dpi(98_304), None);
}
