use super::parse_retry_after;
use core::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn parses_delta_seconds_and_imf_fixdate() {
    let now = UNIX_EPOCH + Duration::from_mins(29_876_126);
    let parse = |value| parse_retry_after(value, now);
    assert_eq!(
        parse("Wed, 21 Oct 2026 07:28:00 GMT"),
        Some(Duration::from_secs(120))
    );
    assert_eq!(parse("Thu, 01 Jan 1970 00:00:00 GMT"), Some(Duration::ZERO));
    assert_eq!(parse(" 30 "), Some(Duration::from_secs(30)));
    for unreadable in ["", "-1", "1.5", "soon", "Wed, 21 Oct 2026 07:28:00 UTC"] {
        assert_eq!(parse(unreadable), None);
    }
    assert!(parse_retry_after("Fri, 01 Jan 2100 00:00:00 GMT", SystemTime::now()).is_some());
}
