/// ECMAScript String.trim's whitespace set differs from Unicode White_Space.
pub fn trim(value: &str) -> &str {
    value.trim_matches(|c|matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}'))
}
pub fn length(value: &str) -> usize {
    // The installed Zod v4 string length checks count Unicode code points.
    value.chars().count()
}

/// Matches the reference's UUID boundary, including nil/max values. The UUID
/// crate also accepts compact/URN spellings that the HTTP contract rejects.
pub fn is_uuid(value: &str) -> bool {
    static UUID: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    UUID.get_or_init(||regex::Regex::new(r"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$").unwrap()).is_match(value)
}
