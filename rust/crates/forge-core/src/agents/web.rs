//! Source web-tool contracts and public-address classification. DNS answers must
//! be checked with this policy before they are pinned to an outbound request.
use crate::contract::*;
use serde_json::Value;
use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    sync::LazyLock,
};
static DESCRIPTORS: LazyLock<Vec<Value>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../data/web-tools.json"))
        .expect("source web tool definitions")
});
pub fn descriptors() -> &'static [Value] {
    &DESCRIPTORS
}
pub fn input(name: &str, value: Value) -> Result<Value> {
    if name != "web_fetch" {
        return Err(ContractError("web tool"));
    }
    let mut object = Object::new(value, &["url", "format", "timeout"], true)?;
    object.required("url", string)?;
    object.optional("format", |v| enumeration(v, &["markdown", "text", "html"]))?;
    object.optional("timeout", |v| number(v, -f64::MAX, f64::MAX, false))?;
    Ok(object.finish())
}
fn normalized(value: &str) -> &str {
    let value = crate::text::trim(value);
    let value = value
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(value);
    value.split('%').next().unwrap_or(value)
}
pub fn loopback(value: &str) -> bool {
    let value = normalized(value).to_lowercase();
    let value = value.strip_suffix('.').unwrap_or(&value);
    value == "localhost"
        || value.ends_with(".localhost")
        || value.parse::<IpAddr>().is_ok_and(|a| match a {
            IpAddr::V4(a) => a.is_loopback(),
            IpAddr::V6(a) => a.is_loopback() || a.to_ipv4_mapped().is_some_and(|a| a.is_loopback()),
        })
}
pub fn private(value: &str) -> bool {
    if loopback(value) {
        return true;
    }
    match normalized(value).parse::<IpAddr>() {
        Ok(IpAddr::V4(a)) => private_v4(a),
        Ok(IpAddr::V6(a)) => a
            .to_ipv4_mapped()
            .map(private_v4)
            .unwrap_or_else(|| private_v6(a)),
        _ => false,
    }
}
fn private_v4(address: Ipv4Addr) -> bool {
    let value = u32::from(address);
    [
        (0x00000000, 8),
        (0x0a000000, 8),
        (0x64400000, 10),
        (0xa9fe0000, 16),
        (0xac100000, 12),
        (0xc0000000, 24),
        (0xc0000200, 24),
        (0xc0586300, 24),
        (0xc0a80000, 16),
        (0xc6120000, 15),
        (0xc6336400, 24),
        (0xcb007100, 24),
        (0xe0000000, 4),
        (0xf0000000, 4),
    ]
    .iter()
    .any(|(base, bits)| value >> (32 - bits) == base >> (32 - bits))
}
fn private_v6(address: Ipv6Addr) -> bool {
    let value = u128::from(address);
    [
        ("::", 96),
        ("64:ff9b::", 96),
        ("64:ff9b:1::", 48),
        ("100::", 64),
        ("2001::", 23),
        ("2001:db8::", 32),
        ("2002::", 16),
        ("fc00::", 7),
        ("fe80::", 10),
        ("ff00::", 8),
    ]
    .iter()
    .any(|(base, bits)| {
        value >> (128 - bits) == u128::from(base.parse::<Ipv6Addr>().unwrap()) >> (128 - bits)
    })
}
