use super::{
    Executor, normalize,
    output::{BYTES, cap},
    quote,
};
use crate::{Error, Result};
use regex::Regex;
use serde_json::{Value, json};
use std::sync::LazyLock;
const PROBE: &str = "command -v rg >/dev/null 2>&1 || exit 127; rg --line-number --color=never --hidden --glob '!.git/*' --max-count 1 -- '__eve_ripgrep_probe_never_matches__' /workspace";
static MATCH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^.+:[0-9]+:").unwrap());
impl Executor {
    pub(super) async fn search(&self, name: &str, input: &Value, path: &str) -> Result<Value> {
        let rg = self
            .ripgrep
            .get_or_try_init(|| async {
                let v = self.sandbox.run(PROBE).await?;
                Ok::<bool, Error>(
                    matches!(v.exit_code, 0 | 1) && forge_core::text::trim(&v.stderr).is_empty(),
                )
            })
            .await
            .copied()
            .unwrap_or(false);
        let limit = input["limit"].as_u64().unwrap_or(100) as usize;
        let pattern = input["pattern"].as_str().unwrap();
        let command = if name == "glob" {
            glob_command(rg, path, pattern)
        } else {
            grep_command(rg, path, input, limit)
        };
        let result = self.sandbox.run(&command).await?;
        if !matches!(result.exit_code, 0 | 1)
            || result.exit_code == 1 && !forge_core::text::trim(&result.stderr).is_empty()
        {
            return Err(Error("Sandbox file search failed."));
        }
        Ok(if name == "glob" {
            glob_output(path, &result.stdout, limit)
        } else {
            grep_output(path, &result.stdout, limit)
        })
    }
}
fn glob_command(rg: bool, path: &str, pattern: &str) -> String {
    if rg {
        format!(
            "rg --files --hidden --glob '!.git/*' --glob {} {}",
            quote(pattern),
            quote(path)
        )
    } else {
        let mut pattern = pattern.replace("**", "*");
        while pattern.starts_with("*/") {
            pattern = pattern[2..].into();
        }
        let selector = if pattern.contains('/') {
            format!("-path {}", quote(&format!("*/{pattern}")))
        } else {
            format!("-name {}", quote(&pattern))
        };
        format!(
            "find {} -type f -not -path '*/.git/*' {selector}",
            quote(path)
        )
    }
}
fn grep_command(rg: bool, path: &str, input: &Value, limit: usize) -> String {
    let mut parts = vec![if rg {
        "rg --line-number --color=never --hidden --glob '!.git/*'".into()
    } else {
        "grep -r -n --exclude-dir=.git".into()
    }];
    if input["ignoreCase"] == true {
        parts.push(if rg { "--ignore-case" } else { "-i" }.into());
    }
    if input["literal"] == true {
        parts.push(if rg { "--fixed-strings" } else { "-F" }.into());
    } else if !rg {
        parts.push("-E".into());
    }
    if let Some(glob) = input["glob"].as_str() {
        parts.push(if rg {
            format!("--glob {}", quote(glob))
        } else {
            format!("--include={}", quote(glob))
        });
    }
    if let Some(context) = input["context"].as_u64().filter(|n| *n > 0) {
        parts.push(format!("{} {context}", if rg { "--context" } else { "-C" }));
    }
    parts.push(format!("{} {limit}", if rg { "--max-count" } else { "-m" }));
    parts.push(if rg { "--" } else { "-e" }.into());
    parts.push(quote(input["pattern"].as_str().unwrap()));
    parts.push(quote(path));
    parts.join(" ")
}
fn glob_output(path: &str, stdout: &str, limit: usize) -> Value {
    let lines: Vec<_> = stdout.split('\n').filter(|s| !s.is_empty()).collect();
    let mut truncated = lines.len() > limit;
    let mut results = Vec::new();
    let mut bytes = 0;
    for line in lines.into_iter().take(limit) {
        let line = normalize(line);
        let size = line.len() + 1;
        if bytes + size > BYTES && !results.is_empty() {
            truncated = true;
            break;
        }
        bytes += size;
        results.push(line);
    }
    if results.is_empty() {
        return json!({"content":"No files found","count":0,"path":path,"truncated":false});
    }
    let count = results.len();
    let mut content = results.join("\n");
    if truncated {
        content += &format!(
            "\n\n(Results truncated: showing first {count} results out of more. Use a more specific path or pattern to narrow results.)"
        );
    }
    json!({"content":content,"count":count,"path":path,"truncated":truncated})
}
fn grep_output(path: &str, stdout: &str, limit: usize) -> Value {
    if forge_core::text::trim(stdout).is_empty() {
        return json!({"content":"No matches found","matchCount":0,"path":path,"truncated":false});
    }
    let lines: Vec<_> = stdout.split('\n').collect();
    let mut output = Vec::new();
    let mut bytes = 0;
    let mut count = 0;
    let mut size_limit = false;
    for (index, line) in lines.iter().enumerate() {
        if line.is_empty() && index == lines.len() - 1 {
            continue;
        }
        if MATCH.is_match(line) {
            count += 1;
        }
        let line = cap(line);
        let size = line.len() + 1;
        if bytes + size > BYTES && !output.is_empty() {
            size_limit = true;
            break;
        }
        bytes += size;
        output.push(line);
    }
    let truncated = size_limit || count >= limit;
    let mut content = output.join("\n");
    if truncated {
        let mut notes = Vec::new();
        if count >= limit {
            notes.push(format!(
                "Match limit reached ({limit}). Use a larger limit or more specific pattern."
            ));
        }
        if size_limit {
            notes.push("Output truncated due to size. Use a more specific path or pattern.".into());
        }
        content += &format!("\n\n[{}]", notes.join(" "));
    }
    json!({"content":content,"matchCount":count,"path":path,"truncated":truncated})
}
