/// ECMAScript String.trim's whitespace set differs from Unicode White_Space.
pub fn trim(value: &str) -> &str {
    value.trim_matches(|c|matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}'))
}
pub fn length(value: &str) -> usize {
    // The installed Zod v4 string length checks count Unicode code points.
    value.chars().count()
}
