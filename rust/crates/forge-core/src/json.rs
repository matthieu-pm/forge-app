//! Bounded parsing for rich documents whose JSON arrays double their node depth.
use serde::Deserialize;
use serde_json::Value;

pub fn parse(input: &str) -> Result<Value, serde_json::Error> {
    let mut depth = 0usize;
    let mut quoted = false;
    let mut escaped = false;
    for byte in input.bytes() {
        if quoted {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                quoted = false;
            }
        } else {
            match byte {
                b'"' => quoted = true,
                b'[' | b'{' => {
                    depth += 1;
                    if depth > 256 {
                        return Err(<serde_json::Error as serde::de::Error>::custom(
                            "JSON nesting exceeds 256 containers",
                        ));
                    }
                }
                b']' | b'}' => depth = depth.saturating_sub(1),
                _ => {}
            }
        }
    }
    let mut parser = serde_json::Deserializer::from_str(input);
    parser.disable_recursion_limit();
    let value = Value::deserialize(&mut parser)?;
    parser.end()?;
    Ok(value)
}
