//! Account profile input and bounded raster-avatar validation.
use crate::contract::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::Value;
pub const MAX_AVATAR_BYTES: usize = 2 * 1024 * 1024;
fn plain(v: Value, min: usize) -> Result<Value> {
    let v = text(v, min, 80, true)?;
    if v.as_str()
        .unwrap()
        .chars()
        .any(|c| c == '\u{7f}' || (c < ' ' && !['\t', '\n', '\r'].contains(&c)))
    {
        return Err(ContractError("control characters"));
    }
    Ok(v)
}
fn username(v: Value) -> Result<Value> {
    let v = text(v, 1, 32, true)?;
    pattern(v, "^[a-z0-9_-]+$")
}
fn image(v: Value) -> Result<Value> {
    let v = text(v, 0, MAX_AVATAR_BYTES.div_ceil(3) * 4 + 64, false)?;
    pattern(
        v,
        "^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$",
    )
}
pub fn values(v: Value, partial: bool) -> Result<Value> {
    let mut o = Object::new(v, &["name", "title", "username", "image"], true)?;
    for (key, parse) in [
        ("name", (|v| plain(v, 1)) as fn(Value) -> Result<Value>),
        ("title", |v| plain(v, 0)),
        ("username", |v| nullable(v, username)),
        ("image", |v| nullable(v, image)),
    ] {
        if partial {
            o.optional(key, parse)?;
        } else {
            o.required(key, parse)?;
        }
    }
    let v = o.finish();
    if v.as_object().unwrap().is_empty() {
        return Err(ContractError("empty patch"));
    }
    Ok(v)
}
pub fn command(v: Value) -> Result<Value> {
    let mut o = Object::new(
        v,
        &[
            "commandKey",
            "sessionId",
            "expectedWorkspaceId",
            "expectedRevision",
            "patch",
        ],
        true,
    )?;
    o.required("commandKey", uuid)?;
    for key in ["sessionId", "expectedWorkspaceId"] {
        o.required(key, |v| text(v, 1, 255, false))?;
    }
    o.required("expectedRevision", datetime)?;
    o.required("patch", |v| values(v, true))?;
    Ok(o.finish())
}
#[derive(Debug, thiserror::Error)]
pub enum AvatarError {
    #[error("Choose a PNG, JPEG or WebP image.")]
    Type,
    #[error("Choose an image smaller than 2 MB.")]
    Size,
    #[error("The image contents do not match its file type.")]
    Content,
}
pub async fn validate_avatar(
    image: &str,
    inspector: &dyn crate::files::upload::Inspector,
) -> std::result::Result<(), AvatarError> {
    let (mime, content) = image
        .strip_prefix("data:")
        .and_then(|s| s.split_once(";base64,"))
        .filter(|(mime, content)| {
            ["image/png", "image/jpeg", "image/webp"].contains(mime) && !content.is_empty()
        })
        .ok_or(AvatarError::Type)?;
    if content.len() > MAX_AVATAR_BYTES.div_ceil(3) * 4 {
        return Err(AvatarError::Size);
    }
    let bytes = STANDARD.decode(content).map_err(|_| AvatarError::Size)?;
    if bytes.is_empty() || bytes.len() > MAX_AVATAR_BYTES || STANDARD.encode(&bytes) != content {
        return Err(AvatarError::Size);
    }
    if inspector.detect(&bytes).await.ok().flatten().as_deref() != Some(mime) {
        return Err(AvatarError::Content);
    }
    Ok(())
}
