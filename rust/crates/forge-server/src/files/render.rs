//! Every preview is an inert document. User content never supplies response headers.
use axum::{
    body::{Body, Bytes},
    http::{HeaderMap, HeaderValue},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use forge_core::files::{DeliveryError, PREVIEW_MAX_BYTES, delivery::File};
use html5ever::tokenizer::{
    BufferQueue, TagKind, Token, TokenSink, TokenSinkResult, Tokenizer, TokenizerOpts,
    states::RawKind,
};
use std::cell::RefCell;
const CSP: &str =
    "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
pub fn headers() -> HeaderMap {
    let mut h = HeaderMap::new();
    for (k, v) in [
        ("cache-control", "private, no-store, max-age=0"),
        ("x-content-type-options", "nosniff"),
        ("referrer-policy", "no-referrer"),
        ("cross-origin-resource-policy", "same-origin"),
        (
            "permissions-policy",
            "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
        ),
        ("content-security-policy", CSP),
    ] {
        h.insert(k, HeaderValue::from_static(v));
    }
    h
}
fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
fn encoded_name(name: &str) -> Result<String, DeliveryError> {
    let name: String = name
        .chars()
        .map(|c| {
            if c <= '\u{1f}' || c == '\u{7f}' {
                '_'
            } else {
                c
            }
        })
        .collect();
    let units: Vec<_> = name.encode_utf16().take(200).collect();
    let name = String::from_utf16(&units).map_err(|_| DeliveryError::Unavailable)?;
    let mut result = String::new();
    use std::fmt::Write;
    for byte in name.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~".contains(&byte) {
            result.push(byte as char)
        } else {
            write!(result, "%{byte:02X}").unwrap();
        }
    }
    Ok(result)
}
pub fn download(file: &File, content: Vec<u8>) -> Result<Response, DeliveryError> {
    let mut h = headers();
    h.insert(
        "content-type",
        HeaderValue::from_static("application/octet-stream"),
    );
    h.insert(
        "content-disposition",
        HeaderValue::from_str(&format!(
            "attachment; filename=\"download\"; filename*=UTF-8''{}",
            encoded_name(&file.name)?
        ))
        .map_err(|_| DeliveryError::Unavailable)?,
    );
    let bytes = Bytes::from(content);
    let stream = futures_util::stream::unfold((bytes, 0usize), |(bytes, offset)| async move {
        if offset == bytes.len() {
            return None;
        }
        let end = (offset + 64 * 1024).min(bytes.len());
        Some((
            Ok::<_, std::convert::Infallible>(bytes.slice(offset..end)),
            (bytes, end),
        ))
    });
    Ok((h, Body::from_stream(stream)).into_response())
}
pub fn preview(file: &File, content: &[u8]) -> Result<Response, DeliveryError> {
    if content.len() > PREVIEW_MAX_BYTES {
        return Err(DeliveryError::PreviewUnavailable);
    }
    let name = escape(&file.name);
    let body = if matches!(
        file.content_type.as_str(),
        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    ) {
        format!(
            "<img alt=\"{name}\" src=\"data:{};base64,{}\">",
            file.content_type,
            STANDARD.encode(content)
        )
    } else {
        let content = content.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(content);
        let text = std::str::from_utf8(content).map_err(|_| DeliveryError::PreviewUnavailable)?;
        if text
            .chars()
            .any(|c| matches!(c,'\u{0}'..='\u{8}'|'\u{b}'|'\u{c}'|'\u{e}'..='\u{1f}'))
        {
            return Err(DeliveryError::PreviewUnavailable);
        }
        let lower = file.name.to_lowercase();
        let suffix = lower.strip_suffix('\n').unwrap_or(&lower);
        if file.content_type == "text/html" || suffix.ends_with(".html") || suffix.ends_with(".htm")
        {
            sanitize(text, false)
        } else if file.content_type == "image/svg+xml" || suffix.ends_with(".svg") {
            format!(
                "<img alt=\"{name}\" src=\"data:image/svg+xml;base64,{}\">",
                STANDARD.encode(sanitize(text, true))
            )
        } else if file.content_type.starts_with("text/") || file.content_type == "application/json"
        {
            format!("<pre>{}</pre>", escape(text))
        } else {
            return Err(DeliveryError::PreviewUnavailable);
        }
    };
    let html = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{name}</title><style>body{{margin:24px;font:14px/1.6 system-ui,sans-serif;color:#202020;background:#fff;overflow-wrap:anywhere}}pre{{white-space:pre-wrap}}img{{max-width:100%;height:auto}}table{{border-collapse:collapse}}td,th{{border:1px solid #ddd;padding:6px}}</style></head><body>{body}</body></html>"
    );
    let mut h = headers();
    h.insert(
        "content-type",
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    h.insert("content-disposition", HeaderValue::from_static("inline"));
    h.insert("content-security-policy",HeaderValue::from_str(&format!("{CSP}; script-src 'none'; style-src 'unsafe-inline'; img-src data:; object-src 'none'; frame-src 'none'; connect-src 'none'")).unwrap());
    Ok((h, html).into_response())
}
const HTML: &[&str] = &[
    "p",
    "br",
    "hr",
    "div",
    "span",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "b",
    "strong",
    "i",
    "em",
    "u",
    "s",
    "small",
    "sub",
    "sup",
    "blockquote",
    "pre",
    "code",
    "ul",
    "ol",
    "li",
    "dl",
    "dt",
    "dd",
    "table",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "th",
    "td",
    "caption",
];
const SVG: &[&str] = &[
    "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text",
    "tspan", "title", "desc",
];
const ATTRS: &[&str] = &[
    "viewBox",
    "width",
    "height",
    "x",
    "y",
    "x1",
    "x2",
    "y1",
    "y2",
    "cx",
    "cy",
    "r",
    "rx",
    "ry",
    "d",
    "points",
    "transform",
    "fill",
    "stroke",
    "stroke-width",
    "opacity",
    "xmlns",
];
fn is_void(tag: &str) -> bool {
    matches!(
        tag,
        "area"
            | "base"
            | "basefont"
            | "br"
            | "col"
            | "embed"
            | "hr"
            | "img"
            | "input"
            | "link"
            | "meta"
            | "param"
            | "source"
            | "track"
            | "wbr"
    )
}
struct Frame {
    name: String,
    emitted: bool,
    discard: bool,
}
#[derive(Default)]
struct State {
    html: String,
    stack: Vec<Frame>,
    positions: std::collections::HashMap<String, Vec<usize>>,
}
impl State {
    fn close(&mut self) {
        if let Some(f) = self.stack.pop() {
            if let Some(indices) = self.positions.get_mut(&f.name) {
                indices.pop();
            }
            if f.emitted {
                self.html.push_str("</");
                self.html.push_str(&f.name);
                self.html.push('>');
            }
        }
    }
    fn discarded(&self) -> bool {
        self.stack.last().is_some_and(|f| f.discard)
    }
    fn push(&mut self, frame: Frame) {
        self.positions
            .entry(frame.name.clone())
            .or_default()
            .push(self.stack.len());
        self.stack.push(frame);
    }
}
struct Sanitizer {
    svg: bool,
    state: RefCell<State>,
}
impl TokenSink for Sanitizer {
    type Handle = ();
    fn process_token(&self, token: Token, _: u64) -> TokenSinkResult<()> {
        let mut s = self.state.borrow_mut();
        match token {
            Token::CharacterTokens(text) if !s.discarded() => s.html.push_str(
                &text
                    .replace('&', "&amp;")
                    .replace('<', "&lt;")
                    .replace('>', "&gt;"),
            ),
            Token::TagToken(tag) => {
                let name = tag.name.as_ref();
                if tag.kind == TagKind::EndTag {
                    if let Some(position) = s.positions.get(name).and_then(|v| v.last()).copied() {
                        while s.stack.len() > position {
                            s.close()
                        }
                    }
                } else {
                    // Close common optional-end elements before emitting a sibling.
                    if !self.svg
                        && s.stack.last().is_some_and(|f| {
                            matches!(
                                (name, f.name.as_str()),
                                ("li", "li")
                                    | ("dt" | "dd", "dt" | "dd")
                                    | (
                                        "p" | "hr"
                                            | "div"
                                            | "h1"
                                            | "h2"
                                            | "h3"
                                            | "h4"
                                            | "h5"
                                            | "h6"
                                            | "ul"
                                            | "ol"
                                            | "table"
                                            | "blockquote"
                                            | "pre",
                                        "p"
                                    )
                                    | ("td" | "th", "td" | "th")
                                    | ("tr", "tr")
                            )
                        })
                    {
                        s.close()
                    }
                    let discard = s.discarded()
                        || matches!(name, "script" | "style" | "textarea" | "option" | "xmp");
                    let allowed = (if self.svg { SVG } else { HTML }).contains(&name)
                        && s.stack.len() < 32
                        && !discard;
                    if allowed {
                        s.html.push('<');
                        s.html.push_str(name);
                        if self.svg {
                            for attr in &tag.attrs {
                                let raw = attr.name.local.as_ref();
                                let key = if raw == "viewbox" { "viewBox" } else { raw };
                                if !ATTRS.contains(&key) {
                                    continue;
                                }
                                let value = attr.value.as_ref();
                                if matches!(key, "fill" | "stroke") && !value.is_empty() {
                                    static COLOR: std::sync::OnceLock<regress::Regex> =
                                        std::sync::OnceLock::new();
                                    if COLOR.get_or_init(||regress::Regex::new(r"^(?:none|currentColor|[a-zA-Z]+|#[0-9a-fA-F]{3,8}|rgba?\([\d\s,.%]+\))$").unwrap()).find(value).is_none(){continue}
                                }
                                s.html.push(' ');
                                s.html.push_str(key);
                                s.html.push_str("=\"");
                                s.html.push_str(&escape(value));
                                s.html.push('"');
                            }
                        }
                        if is_void(name) {
                            s.html.push_str(" /");
                        }
                        s.html.push('>');
                    }
                    if !is_void(name) {
                        s.push(Frame {
                            name: name.into(),
                            emitted: allowed,
                            discard,
                        });
                    }
                    if tag.self_closing && self.svg && !is_void(name) {
                        s.close();
                    }
                    return match name {
                        "script" => TokenSinkResult::RawData(RawKind::ScriptData),
                        "style" | "xmp" => TokenSinkResult::RawData(RawKind::Rawtext),
                        "textarea" => TokenSinkResult::RawData(RawKind::Rcdata),
                        _ => TokenSinkResult::Continue,
                    };
                }
            }
            _ => {}
        }
        TokenSinkResult::Continue
    }
}
pub fn sanitize(text: &str, svg: bool) -> String {
    let sink = Sanitizer {
        svg,
        state: RefCell::new(State::default()),
    };
    let input = BufferQueue::default();
    input.push_back(text.into());
    let tokenizer = Tokenizer::new(sink, TokenizerOpts::default());
    let _ = tokenizer.feed(&input);
    tokenizer.end();
    let mut state = tokenizer.sink.state.into_inner();
    while !state.stack.is_empty() {
        state.close()
    }
    state.html
}
