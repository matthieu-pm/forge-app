use forge_core::profiles;
use serde_json::Value;
#[test]
fn profile_command_normalization_matches_source() {
    let data: Value =
        serde_json::from_str(include_str!("../../../reference-fixtures.json")).unwrap();
    for c in data["profiles"]["contracts"].as_array().unwrap() {
        let result = if c["kind"] == "command" {
            profiles::command(c["input"].clone())
        } else {
            profiles::values(c["input"].clone(), false)
        };
        assert_eq!(result.is_ok(), c["valid"].as_bool().unwrap(), "{c}");
        if let Ok(v) = result {
            assert_eq!(v, c["value"], "{c}");
        }
    }
    for length in [
        profiles::MAX_AVATAR_BYTES.div_ceil(3) * 4 + 64,
        profiles::MAX_AVATAR_BYTES.div_ceil(3) * 4 + 65,
    ] {
        let image = format!("data:image/png;base64,{}", "A".repeat(length - 22));
        let v = serde_json::json!({"name":"A","title":"","username":null,"image":image});
        assert_eq!(
            profiles::values(v, false).is_ok(),
            length == profiles::MAX_AVATAR_BYTES.div_ceil(3) * 4 + 64
        );
    }
}
