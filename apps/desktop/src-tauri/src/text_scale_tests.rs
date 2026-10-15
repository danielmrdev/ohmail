//! The text DPI pin held through a notify (no loop), and the kept size.

use super::*;

#[cfg(target_os = "linux")]
mod pin {
    use super::super::{hold, DpiSetting};
    use std::cell::{Cell, RefCell};

    /// 96 DPI in GTK's unit, the value `gtk_text_dpi` pins.
    const PINNED: i32 = 98_304;

    /// GtkSettings as the pin meets it: every write notifies synchronously, and the app's handler
    /// (`hold`) runs inside that notify, the way `connect_gtk_xft_dpi_notify` runs it.
    struct Notifying {
        value: Cell<i32>,
        writes: RefCell<Vec<i32>>,
        depth: Cell<u32>,
    }

    impl Notifying {
        fn new(value: i32) -> Self {
            Notifying { value: Cell::new(value), writes: RefCell::new(Vec::new()), depth: Cell::new(0) }
        }
        /// Somebody else (the desktop, a backend re-read) writes the property; GTK notifies.
        fn external(&self, value: i32) {
            self.value.set(value);
            self.notify();
        }
        fn notify(&self) {
            self.depth.set(self.depth.get() + 1);
            assert!(self.depth.get() < 4, "the notify handler re-entered itself: a loop");
            hold(self);
            self.depth.set(self.depth.get() - 1);
        }
    }

    impl DpiSetting for Notifying {
        fn dpi(&self) -> i32 {
            self.value.get()
        }
        fn set_dpi(&self, value: i32) {
            self.writes.borrow_mut().push(value);
            self.value.set(value);
            self.notify();
        }
    }

    #[test]
    fn the_pin_holds_after_a_notify_and_writes_once() {
        let s = Notifying::new(89_368);
        assert!(hold(&s));
        assert_eq!(s.dpi(), PINNED);
        assert_eq!(*s.writes.borrow(), vec![PINNED], "the handler's own notify wrote again");

        /* GTK re-reads the desktop's setting at runtime, in either direction: the handler puts
           the pin back, once each time. */
        s.external(122_880);
        s.external(93_388);
        assert_eq!(s.dpi(), PINNED);
        assert_eq!(*s.writes.borrow(), vec![PINNED, PINNED, PINNED]);

        /* A notify that changes nothing writes nothing. */
        s.external(PINNED);
        assert_eq!(s.writes.borrow().len(), 3);
    }
}

#[test]
fn only_the_offered_sizes_are_zooms() {
    for (percent, zoom) in [(90, 0.9), (100, 1.0), (110, 1.1), (125, 1.25), (150, 1.5)] {
        assert_eq!(zoom_for(percent), Some(zoom));
    }
    for percent in [0, 50, 95, 120, 200, u32::MAX] {
        assert_eq!(zoom_for(percent), None, "{percent} became a zoom");
    }
}

fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("ohmail-text-scale-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

#[test]
fn a_kept_size_is_read_back_and_nothing_else_is() {
    let dir = scratch("kept");
    assert_eq!(read_kept(&dir), None, "an empty directory kept a size");
    keep(&dir, 125).unwrap();
    assert_eq!(read_kept(&dir), Some(125));
    keep(&dir, 100).unwrap();
    assert_eq!(read_kept(&dir), Some(100), "returning to the default is kept too");
    keep(&dir, 95).unwrap();
    assert_eq!(read_kept(&dir), Some(100), "a size Settings does not offer was written");
    for junk in ["", "abc", "1250", "-1", "125 percent"] {
        std::fs::write(dir.join(KEPT_FILE), junk).unwrap();
        assert_eq!(read_kept(&dir), None, "{junk:?} read as a size");
    }
    let _ = std::fs::remove_dir_all(&dir);
}
