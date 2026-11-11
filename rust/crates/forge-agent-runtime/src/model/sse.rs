//! Incremental SSE framing. A network chunk is never assumed to be a UTF-8 or
//! event boundary. Limits apply while receiving, including ignored comments.
use crate::{Error, Result};

pub(super) const EVENT_LIMIT: usize = 4 * 1024 * 1024;
const WIRE_LIMIT: usize = 32 * 1024 * 1024;
const INVALID: Error = Error("The model returned an invalid or excessive event stream.");

#[derive(Default)]
pub(super) struct Decoder {
    line: Vec<u8>,
    data: String,
    has_data: bool,
    skip_lf: bool,
    first_line: bool,
    wire: usize,
    event_bytes: usize,
}
impl Decoder {
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<String>> {
        self.wire = self.wire.checked_add(bytes.len()).ok_or(INVALID)?;
        if self.wire > WIRE_LIMIT {
            return Err(INVALID);
        }
        let mut events = vec![];
        for &byte in bytes {
            if self.skip_lf {
                self.skip_lf = false;
                if byte == b'\n' {
                    continue;
                }
            }
            self.event_bytes += 1;
            if self.event_bytes > EVENT_LIMIT {
                return Err(INVALID);
            }
            if byte == b'\r' || byte == b'\n' {
                self.skip_lf = byte == b'\r';
                let bytes = std::mem::take(&mut self.line);
                let line = std::str::from_utf8(&bytes).map_err(|_| INVALID)?;
                let line = if !self.first_line {
                    self.first_line = true;
                    line.strip_prefix('\u{feff}').unwrap_or(line)
                } else {
                    line
                };
                if line.is_empty() {
                    if self.has_data {
                        self.data.pop(); // Last data-field newline is not part of the event.
                        events.push(std::mem::take(&mut self.data));
                        self.has_data = false;
                    }
                    self.event_bytes = 0;
                } else if !line.starts_with(':') {
                    let (field, value) = line.split_once(':').unwrap_or((line, ""));
                    if field == "data" {
                        self.has_data = true;
                        self.data.push_str(value.strip_prefix(' ').unwrap_or(value));
                        self.data.push('\n');
                    }
                }
            } else {
                self.line.push(byte);
            }
        }
        Ok(events)
    }
    pub fn finish(self) -> Result<()> {
        // An unterminated event could contain a truncated tool invocation.
        if self.has_data || !self.line.is_empty() {
            return Err(INVALID);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_byte_boundary_preserves_unicode_multiline_and_all_line_endings() {
        let wire =
            "\u{feff}: ping\r\ndata: {\rdata: \"text\":\"hé😀\"}\r\rdata: [DONE]\n\n".as_bytes();
        for split in 0..=wire.len() {
            let mut d = Decoder::default();
            let mut events = d.push(&wire[..split]).unwrap();
            events.extend(d.push(&wire[split..]).unwrap());
            d.finish().unwrap();
            assert_eq!(events, ["{\n\"text\":\"hé😀\"}", "[DONE]"]);
        }
        let mut d = Decoder::default();
        let mut events = vec![];
        for byte in wire {
            events.extend(d.push(&[*byte]).unwrap());
        }
        d.finish().unwrap();
        assert_eq!(events.len(), 2);
    }
    #[test]
    fn truncation_invalid_utf8_and_ignored_field_floods_are_bounded() {
        for bytes in [b"data: incomplete".as_slice(), b"data: {}\n".as_slice()] {
            let mut d = Decoder::default();
            d.push(bytes).unwrap();
            assert!(d.finish().is_err());
        }
        assert!(Decoder::default().push(b"data: \xff\n\n").is_err());
        for prefix in [
            b"data: ".as_slice(),
            b": ".as_slice(),
            b"ignored: ".as_slice(),
        ] {
            let mut d = Decoder::default();
            d.push(prefix).unwrap();
            assert!(d.push(&vec![b'x'; EVENT_LIMIT]).is_err());
        }
        let mut d = Decoder::default();
        let comment = vec![b'\n'; 1024 * 1024];
        for _ in 0..32 {
            d.push(&comment).unwrap();
        }
        assert!(d.push(b"\n").is_err());
    }
}
