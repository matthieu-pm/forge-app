//! Native rendering of the configured Turndown rules used by the source tool.
use super::{
    Failure,
    dom::{Dom, Handle, Kind, Node},
};
use forge_core::text::trim;
use regex::{Captures, Regex};
use std::{rc::Rc, sync::LazyLock};
const BLOCK: &str = "address article aside audio blockquote body canvas center dd dir div dl dt fieldset figcaption figure footer form frameset h1 h2 h3 h4 h5 h6 header hgroup hr html isindex li main menu nav noframes noscript ol output p pre section table tbody td tfoot th thead tr ul";
const VOID: &str =
    "area base br col command embed hr img input keygen link meta param source track wbr";
const KEEP: &str = "a table thead tbody tfoot th td iframe script audio video";
fn has(list: &str, tag: &str) -> bool {
    list.split(' ').any(|s| s == tag)
}
fn block(n: &Handle) -> bool {
    has(BLOCK, n.tag())
}
fn text(n: &Handle) -> String {
    if n.kind == Kind::Text {
        n.text.borrow().clone()
    } else {
        n.children.borrow().iter().map(text).collect()
    }
}
fn interesting(n: &Handle) -> bool {
    has(VOID, n.tag()) || has(KEEP, n.tag()) || n.children.borrow().iter().any(interesting)
}
fn trim_newlines(s: &str) -> &str {
    s.trim_matches('\n')
}
fn join(a: &str, b: &str) -> String {
    let left = a.trim_end_matches('\n');
    let right = b.trim_start_matches('\n');
    format!(
        "{left}{}{right}",
        "\n".repeat((a.len() - left.len()).max(b.len() - right.len()).min(2))
    )
}
fn ascii_spaces(s: &str) -> String {
    let mut output = String::new();
    let mut space = false;
    for ch in s.chars() {
        if matches!(ch, ' ' | '\r' | '\n' | '\t') {
            if !space {
                output.push(' ');
            }
            space = true;
        } else {
            output.push(ch);
            space = false;
        }
    }
    output
}
fn collapse(root: &Handle) {
    fn boundary(last: &mut Option<Handle>, keep: &mut bool) {
        if let Some(node) = last.take() {
            let value = node.text.borrow().trim_end_matches(' ').to_owned();
            *node.text.borrow_mut() = value;
        }
        *keep = false;
    }
    fn element(node: &Handle, last: &mut Option<Handle>, keep: &mut bool) {
        if block(node) || node.tag() == "br" {
            boundary(last, keep)
        } else if has(VOID, node.tag()) || node.tag() == "pre" {
            *last = None;
            *keep = true;
        } else if last.is_some() {
            *keep = false;
        }
    }
    fn visit(parent: &Handle, last: &mut Option<Handle>, keep: &mut bool) {
        let children = parent.children.borrow().clone();
        for node in children {
            match node.kind {
                Kind::Text => {
                    let mut value = ascii_spaces(&node.text.borrow());
                    if !*keep
                        && last.as_ref().is_none_or(|p| p.text.borrow().ends_with(' '))
                        && value.starts_with(' ')
                    {
                        value.remove(0);
                    }
                    *node.text.borrow_mut() = value.clone();
                    if !value.is_empty() {
                        *last = Some(node);
                    }
                }
                Kind::Element => {
                    element(&node, last, keep);
                    if node.tag() != "pre" && !node.children.borrow().is_empty() {
                        visit(&node, last, keep);
                        element(&node, last, keep);
                    }
                }
                _ => {}
            }
        }
    }
    let mut last = None;
    let mut keep = false;
    visit(root, &mut last, &mut keep);
    boundary(&mut last, &mut keep);
    // Prune in one pass; repeatedly removing individual vector children would
    // make a page with many comments or empty spans quadratic in node count.
    let mut pending = vec![root.clone()];
    while let Some(node) = pending.pop() {
        let mut children = node.children.borrow_mut();
        children.retain(|child| {
            let keep = child.kind == Kind::Element
                || child.kind == Kind::Text && !child.text.borrow().is_empty();
            if !keep {
                *child.parent.borrow_mut() = std::rc::Weak::new();
            }
            keep
        });
        pending.extend(children.iter().cloned());
    }
}
fn escape(value: &str) -> String {
    static RULES: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
        [
            (r"\\", r"\\"),
            (r"\*", r"\*"),
            (r"^-", r"\-"),
            (r"^\+ ", r"\+ "),
            (r"^(=+)", r"\$1"),
            (r"^(#{1,6}) ", r"\$1 "),
            (r"`", r"\`"),
            (r"^~~~", r"\~~~"),
            (r"\[", r"\["),
            (r"\]", r"\]"),
            (r"^>", r"\>"),
            (r"_", r"\_"),
            (r"^([0-9]+)\. ", r"$1\. "),
        ]
        .into_iter()
        .map(|(pattern, replacement)| (Regex::new(pattern).unwrap(), replacement))
        .collect()
    });
    RULES.iter().fold(value.to_owned(), |s, (re, replacement)| {
        re.replace_all(&s, *replacement).into_owned()
    })
}
fn collapse_attribute(s: &str) -> String {
    static LINES: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(\n+[\t\r\n \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*)+").unwrap()
    });
    LINES.replace_all(s, "\n").into_owned()
}
fn link(s: &str) -> String {
    let escaped = s
        .chars()
        .flat_map(|c| {
            if matches!(c, '<' | '>' | '(' | ')') {
                vec!['\\', c]
            } else {
                vec![c]
            }
        })
        .collect::<String>();
    if escaped.contains(' ') {
        format!("<{escaped}>")
    } else {
        escaped
    }
}
fn flanks(node: &Handle) -> (String, String) {
    if block(node) {
        return (String::new(), String::new());
    }
    let content = text(node);
    let stripped = trim(&content);
    let leading = content.len()
        - content
            .trim_start_matches(|c: char| trim(c.encode_utf8(&mut [0; 4])).is_empty())
            .len();
    let trailing = content.len()
        - content
            .trim_end_matches(|c: char| trim(c.encode_utf8(&mut [0; 4])).is_empty())
            .len();
    let mut left = content[..leading].to_owned();
    let mut right = if stripped.is_empty() {
        String::new()
    } else {
        content[content.len() - trailing..].to_owned()
    };
    let (before, after) = Node::siblings(node);
    if before.is_some_and(|n| !block(&n) && text(&n).ends_with(' ')) {
        left = left.trim_start_matches([' ', '\t', '\r', '\n']).into();
    }
    if after.is_some_and(|n| !block(&n) && text(&n).starts_with(' ')) {
        right = right.trim_end_matches([' ', '\t', '\r', '\n']).into();
    }
    (left, right)
}
fn render(node: &Handle, in_code: bool) -> Result<String, Failure> {
    if node.kind == Kind::Text {
        let value = node.text.borrow();
        return Ok(if in_code {
            value.clone()
        } else {
            escape(&value)
        });
    }
    if node.kind != Kind::Element && node.kind != Kind::Document {
        return Ok(String::new());
    }
    let code = in_code || node.tag() == "code";
    let mut content = String::new();
    for child in node.children.borrow().iter() {
        content = join(&content, &render(child, code)?);
        if content.len() > 8 * 1024 * 1024 {
            return Err(Failure::ComplexHtml);
        }
    }
    if node.kind == Kind::Document {
        return Ok(content);
    }
    let blank = !interesting(node) && trim(&text(node)).is_empty();
    let (leading, trailing) = flanks(node);
    if !leading.is_empty() || !trailing.is_empty() {
        content = trim(&content).into();
    }
    let replacement = if blank {
        if block(node) {
            "\n\n".into()
        } else {
            String::new()
        }
    } else {
        match node.tag() {
            "script" | "style" | "meta" | "link" => String::new(),
            "p" => format!("\n\n{content}\n\n"),
            "br" => "  \n".into(),
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => format!(
                "\n\n{} {content}\n\n",
                "#".repeat(node.tag().as_bytes()[1] as usize - b'0' as usize)
            ),
            "blockquote" => format!(
                "\n\n{}\n\n",
                trim_newlines(&content)
                    .split('\n')
                    .map(|s| format!("> {s}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            ),
            "ul" | "ol" => {
                let nested = node.parent.borrow().upgrade().is_some_and(|p| {
                    p.tag() == "li"
                        && p.children
                            .borrow()
                            .iter()
                            .rev()
                            .find(|c| c.kind == Kind::Element)
                            .is_some_and(|c| Rc::ptr_eq(c, node))
                });
                if nested {
                    format!("\n{content}")
                } else {
                    format!("\n\n{content}\n\n")
                }
            }
            "li" => {
                let mut marker = "-   ".to_owned();
                if let Some(parent) = node.parent.borrow().upgrade()
                    && parent.tag() == "ol"
                {
                    let index = parent
                        .children
                        .borrow()
                        .iter()
                        .filter(|n| n.kind == Kind::Element)
                        .position(|n| Rc::ptr_eq(n, node))
                        .unwrap_or(0);
                    let start = if parent.attr("start").is_empty() {
                        1.
                    } else {
                        let raw = parent.attr("start");
                        let value = trim(&raw);
                        if value.is_empty() {
                            0.
                        } else {
                            value.parse::<f64>().unwrap_or(f64::NAN)
                        }
                    };
                    marker = format!("{}.  ", start + index as f64);
                }
                let suffix = if content.ends_with('\n') { "\n" } else { "" };
                let content = format!("{}{suffix}", trim_newlines(&content))
                    .replace('\n', &format!("\n{}", " ".repeat(marker.len())));
                format!(
                    "{marker}{content}{}",
                    if Node::siblings(node).1.is_some() {
                        "\n"
                    } else {
                        ""
                    }
                )
            }
            "pre"
                if node
                    .children
                    .borrow()
                    .first()
                    .is_some_and(|n| n.tag() == "code") =>
            {
                let code_node = node.children.borrow()[0].clone();
                let raw = text(&code_node);
                let class = code_node.attr("class");
                let language = class
                    .find("language-")
                    .map(|i| class[i + 9..].split_whitespace().next().unwrap_or(""))
                    .unwrap_or("");
                let fence = "`".repeat(
                    raw.lines()
                        .map(|l| l.chars().take_while(|c| *c == '`').count())
                        .filter(|n| *n >= 3)
                        .max()
                        .map_or(3, |n| n + 1),
                );
                format!(
                    "\n\n{fence}{language}\n{}\n{fence}\n\n",
                    raw.strip_suffix('\n').unwrap_or(&raw)
                )
            }
            "hr" => "\n\n---\n\n".into(),
            "a" if !node.attr("href").is_empty() => {
                let title = collapse_attribute(&node.attr("title")).replace('"', "\\\"");
                format!(
                    "[{content}]({}{})",
                    link(&node.attr("href")),
                    if title.is_empty() {
                        String::new()
                    } else {
                        format!(" \"{title}\"")
                    }
                )
            }
            "em" | "i" => {
                if trim(&content).is_empty() {
                    String::new()
                } else {
                    format!("*{content}*")
                }
            }
            "strong" | "b" => {
                if trim(&content).is_empty() {
                    String::new()
                } else {
                    format!("**{content}**")
                }
            }
            "code"
                if !(node
                    .parent
                    .borrow()
                    .upgrade()
                    .is_some_and(|p| p.tag() == "pre")
                    && {
                        let (a, b) = Node::siblings(node);
                        a.is_none() && b.is_none()
                    }) =>
            {
                let raw = content.replace("\r\n", " ").replace(['\r', '\n'], " ");
                if raw.is_empty() {
                    String::new()
                } else {
                    let pad = raw.starts_with('`')
                        || raw.ends_with('`')
                        || (raw.starts_with(' ')
                            && raw.ends_with(' ')
                            && raw.chars().any(|c| c != ' '));
                    let runs = raw
                        .split(|c| c != '`')
                        .filter(|s| !s.is_empty())
                        .map(str::len)
                        .collect::<Vec<_>>();
                    let mut count = 1;
                    while runs.contains(&count) {
                        count += 1;
                    }
                    let fence = "`".repeat(count);
                    let pad = if pad { " " } else { "" };
                    format!("{fence}{pad}{raw}{pad}{fence}")
                }
            }
            "img" => {
                let src = node.attr("src");
                if src.is_empty() {
                    String::new()
                } else {
                    let title = collapse_attribute(&node.attr("title")).replace('"', "\\\"");
                    format!(
                        "![{}]({}{})",
                        escape(&collapse_attribute(&node.attr("alt"))),
                        link(&src),
                        if title.is_empty() {
                            String::new()
                        } else {
                            format!(" \"{title}\"")
                        }
                    )
                }
            }
            _ => {
                if block(node) {
                    format!("\n\n{content}\n\n")
                } else {
                    content
                }
            }
        }
    };
    if replacement.len() > 8 * 1024 * 1024 {
        return Err(Failure::ComplexHtml);
    }
    Ok(format!("{leading}{replacement}{trailing}"))
}
pub fn markdown(html: &str) -> Result<String, Failure> {
    if html.len() > 5 * 1024 * 1024 || html.bytes().filter(|b| *b == b'<').count() > 50_000 {
        return Err(Failure::ComplexHtml);
    }
    let dom = Dom::parse(html);
    if !dom.bounded() {
        return Err(Failure::ComplexHtml);
    }
    let Some(root) = dom.root() else {
        return Ok(String::new());
    };
    collapse(&root);
    Ok(render(&root, false)?
        .trim_start_matches(['\t', '\r', '\n'])
        .trim_end_matches(|c: char| trim(c.encode_utf8(&mut [0; 4])).is_empty())
        .to_owned())
}
pub fn plain(html: &str) -> String {
    static HIDDEN: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            &["script", "style", "noscript"]
                .iter()
                .map(|name| format!(r"(?s:<(?i-u:{name})(?-u:\b)[^>]*>.*?</(?i-u:{name})>)"))
                .collect::<Vec<_>>()
                .join("|"),
        )
        .unwrap()
    });
    static END: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"</(?i-u:p|div|br|h[1-6]|li|tr|blockquote|pre|section|article|header|footer|nav|aside|main|figure|figcaption|details|summary)>").unwrap()
    });
    static BR: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"<(?i-u:br)[\t\n\x{000b}\x{000c}\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*/?>").unwrap()
    });
    static TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^>]+>").unwrap());
    static ENTITY: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)&(?:amp|gt|lt|nbsp|quot|#39|#x27|#x2f);").unwrap());
    static SPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[ \t]+").unwrap());
    static LINES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n{3,}").unwrap());
    let source = HIDDEN.replace_all(html, "");
    let source = END.replace_all(&source, "\n");
    let source = BR.replace_all(&source, "\n");
    let source = TAG.replace_all(&source, "");
    let source = ENTITY.replace_all(&source, |c: &Captures| {
        match c[0].to_ascii_lowercase().as_str() {
            "&amp;" => "&".into(),
            "&gt;" => ">".into(),
            "&lt;" => "<".into(),
            "&nbsp;" => " ".into(),
            "&quot;" => "\"".into(),
            "&#39;" | "&#x27;" => "'".into(),
            _ => c[0].to_owned(),
        }
    });
    let source = source
        .split('\n')
        .map(|s| trim(&SPACE.replace_all(s, " ")).to_owned())
        .collect::<Vec<_>>()
        .join("\n");
    trim(&LINES.replace_all(&source, "\n\n")).to_owned()
}
