use crate::{Error, Result, sandbox::Execution};
use serde_json::{Value, json};
pub(super) const BYTES: usize = 50 * 1024;
pub(super) fn cap(line: &str) -> String {
    // JS measures string slices in UTF-16 units. Preserve that boundary; a
    // half-surrogate at the cut is represented as U+FFFD in UTF-8 transports.
    let units: Vec<_> = line.encode_utf16().take(2001).collect();
    if units.len() <= 2000 {
        line.into()
    } else {
        format!("{} [truncated]", String::from_utf16_lossy(&units[..2000]))
    }
}
fn tail(value: &str) -> (String, usize, usize, bool) {
    let lines: Vec<_> = value.split('\n').collect();
    let total = lines.len() - usize::from(lines.last() == Some(&""));
    let mut output = Vec::new();
    let mut bytes = 0;
    for line in lines.into_iter().rev().take(2000) {
        let line = cap(line);
        let size = line.len() + 1;
        if bytes + size > BYTES && !output.is_empty() {
            break;
        }
        bytes += size;
        output.push(line);
    }
    output.reverse();
    let count = output.len();
    (output.join("\n"), count, total, count < total)
}
pub(super) fn bash(value: Execution) -> Value {
    let (stdout, n, total, a) = tail(&value.stdout);
    let (stderr, m, errors, b) = tail(&value.stderr);
    json!({"stdout":if a{format!("[stdout truncated: showing last {n} of {total} lines]\n{stdout}")}else{stdout},"stderr":if b{format!("[stderr truncated: showing last {m} of {errors} lines]\n{stderr}")}else{stderr},"exitCode":value.exit_code,"truncated":a||b})
}
pub(super) fn read(path: &str, content: &str, offset: u64, limit: u64) -> Result<Value> {
    let lines: Vec<_> = content.split('\n').collect();
    let total = lines.len() - usize::from(lines.last() == Some(&""));
    if offset > total as u64 && !(total == 0 && offset == 1) {
        return Err(Error("The read offset is past the end of the file."));
    }
    let mut output = Vec::new();
    let mut bytes = 0;
    for (index, line) in lines
        .iter()
        .take(total)
        .enumerate()
        .skip((offset - 1) as usize)
        .take(limit as usize)
    {
        let line = format!("{}: {}", index + 1, cap(line));
        let size = line.len() + 1;
        if bytes + size > BYTES && !output.is_empty() {
            break;
        }
        bytes += size;
        output.push(line);
    }
    let next = offset + output.len() as u64;
    let truncated = next <= total as u64;
    let mut value =
        json!({"content":output.join("\n"),"path":path,"totalLines":total,"truncated":truncated});
    if truncated {
        value["nextOffset"] = json!(next);
    }
    Ok(value)
}
