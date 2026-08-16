//! Bidirectional ProseMirror JSON ↔ markdown+HTML for git export.
//!
//! The `.md` file is the source of truth. Serialization is deterministic;
//! parsing inverts this serializer (and accepts ordinary human edits).
//! TipTap-only nodes (resource embeds, notes, colors, mentions, tables)
//! are written as HTML so they survive a round-trip.

use serde_json::{json, Map, Value};

/// Normalize loro-prosemirror `{nodeName, children, attributes}` and
/// ProseMirror `{type, content, attrs}` into the latter.
pub fn normalize_pm_json(node: &Value) -> Value {
    match node {
        Value::String(s) => json!({ "type": "text", "text": s }),
        Value::Array(arr) => Value::Array(arr.iter().map(normalize_pm_json).collect()),
        Value::Object(obj) => {
            if let Some(Value::String(text)) = obj.get("text") {
                if obj.get("type").and_then(|t| t.as_str()) == Some("text")
                    || obj.get("nodeName").and_then(|t| t.as_str()) == Some("text")
                    || (!obj.contains_key("type") && !obj.contains_key("nodeName"))
                {
                    let mut out = Map::new();
                    out.insert("type".into(), json!("text"));
                    out.insert("text".into(), json!(text));
                    if let Some(marks) = obj.get("marks") {
                        out.insert("marks".into(), normalize_marks(marks));
                    }
                    return Value::Object(out);
                }
            }

            let node_type = obj
                .get("type")
                .or_else(|| obj.get("nodeName"))
                .and_then(|t| t.as_str())
                .unwrap_or("doc");

            let mut out = Map::new();
            out.insert("type".into(), json!(node_type));

            if let Some(attrs) = obj.get("attrs").or_else(|| obj.get("attributes")) {
                if !is_empty_object(attrs) {
                    out.insert("attrs".into(), attrs.clone());
                }
            }

            if let Some(marks) = obj.get("marks") {
                out.insert("marks".into(), normalize_marks(marks));
            }

            if let Some(children) = obj.get("content").or_else(|| obj.get("children")) {
                let content = match children {
                    Value::Array(arr) => Value::Array(arr.iter().map(normalize_pm_json).collect()),
                    other => Value::Array(vec![normalize_pm_json(other)]),
                };
                if !content.as_array().is_some_and(|a| a.is_empty()) {
                    out.insert("content".into(), content);
                }
            }

            Value::Object(out)
        }
        other => other.clone(),
    }
}

fn normalize_marks(marks: &Value) -> Value {
    match marks {
        Value::Array(arr) => Value::Array(
            arr.iter()
                .map(|mark| {
                    let Some(obj) = mark.as_object() else {
                        return mark.clone();
                    };
                    let mark_type = obj
                        .get("type")
                        .or_else(|| obj.get("name"))
                        .cloned()
                        .unwrap_or(json!(""));
                    let mut out = Map::new();
                    out.insert("type".into(), mark_type);
                    if let Some(attrs) = obj.get("attrs").or_else(|| obj.get("attributes")) {
                        if !is_empty_object(attrs) {
                            out.insert("attrs".into(), attrs.clone());
                        }
                    }
                    Value::Object(out)
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

fn is_empty_object(value: &Value) -> bool {
    value.as_object().is_some_and(|o| o.is_empty()) || value.is_null()
}

/// Convert normalized ProseMirror JSON to the loro-prosemirror map shape
/// (`nodeName` / `children` / `attributes`) written into the Loro `doc` root.
pub fn pm_to_loro_shape(node: &Value) -> Value {
    let node = normalize_pm_json(node);
    let Some(obj) = node.as_object() else {
        return node;
    };

    if obj.get("type").and_then(|t| t.as_str()) == Some("text") {
        if let Some(text) = obj.get("text").and_then(|t| t.as_str()) {
            if obj.get("marks").is_none() {
                return json!(text);
            }
        }
        let mut out = Map::new();
        out.insert("nodeName".into(), json!("text"));
        if let Some(text) = obj.get("text") {
            out.insert("text".into(), text.clone());
        }
        if let Some(marks) = obj.get("marks") {
            out.insert("marks".into(), marks.clone());
        }
        return Value::Object(out);
    }

    let mut out = Map::new();
    out.insert(
        "nodeName".into(),
        obj.get("type").cloned().unwrap_or(json!("doc")),
    );
    if let Some(attrs) = obj.get("attrs") {
        out.insert("attributes".into(), attrs.clone());
    }
    if let Some(Value::Array(content)) = obj.get("content") {
        out.insert(
            "children".into(),
            Value::Array(content.iter().map(pm_to_loro_shape).collect()),
        );
    }
    Value::Object(out)
}

/// Rewrite `href` / `subject` / mention `id` that match `rewrite`.
pub fn rewrite_pm_refs(node: &mut Value, rewrite: &dyn Fn(&str) -> Option<String>) {
    match node {
        Value::Array(arr) => {
            for child in arr {
                rewrite_pm_refs(child, rewrite);
            }
        }
        Value::Object(obj) => {
            if let Some(attrs) = obj.get_mut("attrs").and_then(|a| a.as_object_mut()) {
                for key in ["href", "subject", "src", "id"] {
                    if let Some(Value::String(s)) = attrs.get(key) {
                        if let Some(next) = rewrite(s) {
                            attrs.insert(key.to_string(), json!(next));
                        }
                    }
                }
            }
            if let Some(marks) = obj.get_mut("marks") {
                rewrite_pm_refs(marks, rewrite);
            }
            if let Some(content) = obj.get_mut("content") {
                rewrite_pm_refs(content, rewrite);
            }
        }
        _ => {}
    }
}

/// Serialize a ProseMirror doc (any shape) to deterministic markdown+HTML.
pub fn serialize(node: &Value) -> String {
    let node = normalize_pm_json(node);
    let mut out = serialize_block(&node, 0);
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

/// Parse markdown+HTML produced by [`serialize`] (or ordinary human markdown)
/// back into a ProseMirror `{type: doc, content: [...]}` tree.
pub fn parse(markdown: &str) -> Value {
    let blocks = parse_blocks(markdown.trim_end());
    json!({ "type": "doc", "content": blocks })
}

fn children_of(obj: &Map<String, Value>) -> &[Value] {
    obj.get("content")
        .and_then(|c| c.as_array())
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn serialize_block(node: &Value, list_indent: usize) -> String {
    let Some(obj) = node.as_object() else {
        return String::new();
    };
    let node_type = obj.get("type").and_then(|t| t.as_str()).unwrap_or("");
    let attrs = obj.get("attrs");
    let children = children_of(obj);

    match node_type {
        "doc" => children
            .iter()
            .map(|n| serialize_block(n, list_indent))
            .collect::<Vec<_>>()
            .join(""),
        "heading" => {
            let level = attr_u64(attrs, "level").unwrap_or(1).clamp(1, 6) as usize;
            format!("{} {}\n\n", "#".repeat(level), serialize_inlines(children))
        }
        "paragraph" => {
            let inline = serialize_inlines(children);
            let align = attr_str(attrs, "textAlign").unwrap_or("left");
            if align != "left" && !align.is_empty() {
                format!("<p style=\"text-align: {align}\">{inline}</p>\n\n")
            } else if inline.is_empty() {
                "\n".into()
            } else {
                format!("{inline}\n\n")
            }
        }
        "bulletList" | "bullet_list" => serialize_list(children, false, list_indent),
        "orderedList" | "ordered_list" => serialize_list(children, true, list_indent),
        "taskList" => serialize_task_list(children, list_indent),
        "listItem" | "list_item" | "taskItem" => children
            .iter()
            .map(|n| serialize_block(n, list_indent))
            .collect::<Vec<_>>()
            .join(""),
        "codeBlock" | "code_block" => {
            let lang = attr_str(attrs, "language")
                .or_else(|| attr_str(attrs, "lang"))
                .unwrap_or("");
            let body = serialize_plain_text(children);
            format!("```{lang}\n{}\n```\n\n", body.trim_end())
        }
        "blockquote" => {
            let inner = children
                .iter()
                .map(|n| serialize_block(n, 0))
                .collect::<Vec<_>>()
                .join("");
            let quoted = inner
                .trim_end()
                .lines()
                .map(|line| format!("> {line}"))
                .collect::<Vec<_>>()
                .join("\n");
            format!("{quoted}\n\n")
        }
        "horizontalRule" | "horizontal_rule" => "---\n\n".into(),
        "hardBreak" | "hard_break" => "<br>\n".into(),
        "image" => {
            let alt = attr_str(attrs, "alt").unwrap_or("");
            let src = attr_str(attrs, "src").unwrap_or("");
            let title = attr_str(attrs, "title").unwrap_or("");
            if title.is_empty() {
                format!("![{alt}]({src})\n\n")
            } else {
                format!("![{alt}]({src} \"{title}\")\n\n")
            }
        }
        "note-block" => {
            let inner = children
                .iter()
                .map(|n| serialize_block(n, 0))
                .collect::<Vec<_>>()
                .join("");
            format!("<note-block>\n{}</note-block>\n\n", inner.trim_start())
        }
        "atomic-data-resource" => {
            let href = attr_str(attrs, "subject")
                .or_else(|| attr_str(attrs, "href"))
                .unwrap_or("");
            let title = serialize_plain_text(children);
            format!(
                "<a data-type=\"resource-block\" href=\"{}\">{}</a>\n\n",
                escape_attr(href),
                escape_html(&title)
            )
        }
        "atomic-data-resource-inline" => {
            let href = attr_str(attrs, "subject")
                .or_else(|| attr_str(attrs, "href"))
                .unwrap_or("");
            let title = serialize_plain_text(children);
            format!(
                "<a data-type=\"resource-inline\" href=\"{}\">{}</a>",
                escape_attr(href),
                escape_html(&title)
            )
        }
        "table" => format!("{}\n\n", serialize_table(node)),
        "mention" => serialize_mention(attrs),
        "" => children
            .iter()
            .map(|n| serialize_block(n, list_indent))
            .collect::<Vec<_>>()
            .join(""),
        other => serialize_unknown_block(other, attrs, children),
    }
}

fn serialize_list(items: &[Value], ordered: bool, indent: usize) -> String {
    let pad = "  ".repeat(indent);
    let mut out = String::new();
    for (i, item) in items.iter().enumerate() {
        let marker = if ordered {
            format!("{}.", i + 1)
        } else {
            "-".into()
        };
        let body = serialize_block(item, indent + 1);
        let mut lines = body.trim_end().lines();
        let first = lines.next().unwrap_or("");
        out.push_str(&format!("{pad}{marker} {first}\n"));
        for line in lines {
            if line.is_empty() {
                out.push('\n');
            } else {
                out.push_str(&pad);
                out.push_str("  ");
                out.push_str(line);
                out.push('\n');
            }
        }
    }
    if indent == 0 {
        out.push('\n');
    }
    out
}

fn serialize_task_list(items: &[Value], indent: usize) -> String {
    let pad = "  ".repeat(indent);
    let mut out = String::new();
    for item in items {
        let checked = item
            .get("attrs")
            .and_then(|a| a.get("checked"))
            .and_then(|c| c.as_bool())
            .unwrap_or(false);
        let box_ = if checked { "[x]" } else { "[ ]" };
        let body = serialize_block(item, indent + 1);
        let mut lines = body.trim_end().lines();
        let first = lines.next().unwrap_or("");
        out.push_str(&format!("{pad}- {box_} {first}\n"));
        for line in lines {
            if !line.is_empty() {
                out.push_str(&pad);
                out.push_str("  ");
                out.push_str(line);
                out.push('\n');
            }
        }
    }
    if indent == 0 {
        out.push('\n');
    }
    out
}

fn serialize_table(node: &Value) -> String {
    let mut html = String::from("<table>");
    if let Some(rows) = node.get("content").and_then(|c| c.as_array()) {
        for row in rows {
            html.push_str("<tr>");
            if let Some(cells) = row.get("content").and_then(|c| c.as_array()) {
                for cell in cells {
                    let tag = match cell.get("type").and_then(|t| t.as_str()) {
                        Some("tableHeader") => "th",
                        _ => "td",
                    };
                    let inner = cell
                        .get("content")
                        .and_then(|c| c.as_array())
                        .map(|c| {
                            c.iter()
                                .map(|n| serialize_block(n, 0))
                                .collect::<Vec<_>>()
                                .join("")
                        })
                        .unwrap_or_default();
                    html.push_str(&format!("<{tag}>{}</{tag}>", inner.trim()));
                }
            }
            html.push_str("</tr>");
        }
    }
    html.push_str("</table>");
    html
}

fn serialize_unknown_block(node_type: &str, attrs: Option<&Value>, children: &[Value]) -> String {
    let attrs_json = attrs
        .map(|a| serde_json::to_string(a).unwrap_or_default())
        .unwrap_or_default();
    let inner = children
        .iter()
        .map(|n| serialize_block(n, 0))
        .collect::<Vec<_>>()
        .join("");
    format!(
        "<div data-pm-type=\"{}\" data-pm-attrs=\"{}\">{}</div>\n\n",
        escape_attr(node_type),
        escape_attr(&attrs_json),
        inner.trim()
    )
}

fn serialize_inlines(nodes: &[Value]) -> String {
    nodes.iter().map(serialize_inline).collect()
}

fn serialize_inline(node: &Value) -> String {
    let Some(obj) = node.as_object() else {
        return String::new();
    };
    let node_type = obj.get("type").and_then(|t| t.as_str()).unwrap_or("");
    match node_type {
        "text" => {
            let text = obj.get("text").and_then(|t| t.as_str()).unwrap_or("");
            apply_marks(escape_inline(text), obj.get("marks"))
        }
        "hardBreak" | "hard_break" => "<br>".into(),
        "image" => {
            let alt = attr_str(obj.get("attrs"), "alt").unwrap_or("");
            let src = attr_str(obj.get("attrs"), "src").unwrap_or("");
            format!("![{alt}]({src})")
        }
        "atomic-data-resource-inline" => serialize_block(node, 0).trim().to_string(),
        "mention" => serialize_mention(obj.get("attrs")),
        _ => {
            if let Some(content) = obj.get("content").and_then(|c| c.as_array()) {
                serialize_inlines(content)
            } else if let Some(text) = obj.get("text").and_then(|t| t.as_str()) {
                text.to_string()
            } else {
                String::new()
            }
        }
    }
}

fn serialize_mention(attrs: Option<&Value>) -> String {
    let id = attr_str(attrs, "id")
        .or_else(|| attr_str(attrs, "subject"))
        .unwrap_or("");
    let label = attr_str(attrs, "label").unwrap_or("");
    format!(
        "[@id=\"{}\" label=\"{}\"]",
        escape_attr(id),
        escape_attr(label)
    )
}

fn apply_marks(mut text: String, marks: Option<&Value>) -> String {
    let Some(Value::Array(marks)) = marks else {
        return text;
    };
    let mut ordered: Vec<&Value> = marks.iter().collect();
    ordered.sort_by_key(|m| mark_rank(mark_type(m)));
    for mark in ordered {
        let mark_type = mark_type(mark);
        let attrs = mark.get("attrs");
        text = match mark_type {
            "code" => format!("`{text}`"),
            "bold" | "strong" => format!("**{text}**"),
            "italic" | "em" => format!("*{text}*"),
            "strike" | "strikethrough" => format!("~~{text}~~"),
            "link" => {
                let href = attr_str(attrs, "href").unwrap_or("");
                format!("[{text}]({href})")
            }
            "textStyle" | "color" => {
                if let Some(color) = attr_str(attrs, "color") {
                    format!("<span style=\"color: {color}\">{text}</span>")
                } else {
                    text
                }
            }
            "highlight" | "backgroundColor" => {
                let color = attr_str(attrs, "color")
                    .or_else(|| attr_str(attrs, "backgroundColor"))
                    .unwrap_or("");
                if color.is_empty() {
                    text
                } else {
                    format!("<span style=\"background-color: {color}\">{text}</span>")
                }
            }
            "mention" => serialize_mention(attrs),
            _ => text,
        };
    }
    text
}

fn mark_type(mark: &Value) -> &str {
    mark.get("type")
        .or_else(|| mark.get("name"))
        .and_then(|t| t.as_str())
        .unwrap_or("")
}

fn mark_rank(mark_type: &str) -> u8 {
    match mark_type {
        "code" => 0,
        "bold" | "strong" => 1,
        "italic" | "em" => 2,
        "strike" | "strikethrough" => 3,
        "link" => 4,
        "textStyle" | "color" => 5,
        "highlight" | "backgroundColor" => 6,
        _ => 9,
    }
}

fn serialize_plain_text(nodes: &[Value]) -> String {
    nodes
        .iter()
        .map(|n| match n {
            Value::String(s) => s.clone(),
            Value::Object(obj) => {
                if let Some(t) = obj.get("text").and_then(|t| t.as_str()) {
                    t.to_string()
                } else if let Some(c) = obj.get("content").and_then(|c| c.as_array()) {
                    serialize_plain_text(c)
                } else {
                    String::new()
                }
            }
            _ => String::new(),
        })
        .collect()
}

fn attr_str<'a>(attrs: Option<&'a Value>, key: &str) -> Option<&'a str> {
    attrs.and_then(|a| a.get(key)).and_then(|v| v.as_str())
}

fn attr_u64(attrs: Option<&Value>, key: &str) -> Option<u64> {
    attrs.and_then(|a| a.get(key)).and_then(|v| {
        v.as_u64()
            .or_else(|| v.as_i64().map(|i| i as u64))
            .or_else(|| v.as_f64().map(|f| f as u64))
    })
}

fn escape_attr(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn escape_inline(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('*', "\\*")
        .replace('_', "\\_")
        .replace('`', "\\`")
}

fn unescape_inline(s: &str) -> String {
    let mut out = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(next) = chars.next() {
                out.push(next);
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn unescape_attr(s: &str) -> String {
    s.replace("&quot;", "\"")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

fn unescape_html(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

fn parse_blocks(input: &str) -> Vec<Value> {
    let mut blocks = Vec::new();
    let mut rest = input;
    while !rest.is_empty() {
        if rest.starts_with('\n') {
            rest = &rest[1..];
            continue;
        }
        if let Some((node, consumed)) = parse_one_block(rest) {
            blocks.push(node);
            rest = &rest[consumed..];
        } else {
            break;
        }
    }
    if blocks.is_empty() {
        blocks.push(json!({ "type": "paragraph" }));
    }
    blocks
}

fn parse_one_block(input: &str) -> Option<(Value, usize)> {
    let input = strip_leading_blank(input);
    if input.is_empty() {
        return None;
    }

    if let Some(v) = try_html_block(input) {
        return Some(v);
    }
    if let Some(v) = try_fence(input) {
        return Some(v);
    }
    if let Some(v) = try_heading(input) {
        return Some(v);
    }
    if let Some(v) = try_hr(input) {
        return Some(v);
    }
    if let Some(v) = try_blockquote(input) {
        return Some(v);
    }
    if let Some(v) = try_list(input) {
        return Some(v);
    }
    try_paragraph(input)
}

fn strip_leading_blank(input: &str) -> &str {
    let mut i = 0;
    let bytes = input.as_bytes();
    while i < bytes.len() && bytes[i] == b'\n' {
        i += 1;
    }
    &input[i..]
}

fn line_end(input: &str) -> usize {
    input.find('\n').unwrap_or(input.len())
}

fn try_heading(input: &str) -> Option<(Value, usize)> {
    let end = line_end(input);
    let line = input[..end].trim_end();
    let hashes = line.chars().take_while(|c| *c == '#').count();
    if !(1..=6).contains(&hashes) {
        return None;
    }
    if line.as_bytes().get(hashes) != Some(&b' ') && line.len() != hashes {
        return None;
    }
    let text = line[hashes..].trim();
    let consumed = if end < input.len() { end + 1 } else { end };
    Some((
        json!({
            "type": "heading",
            "attrs": { "level": hashes as u64 },
            "content": parse_inlines(text)
        }),
        consumed,
    ))
}

fn try_hr(input: &str) -> Option<(Value, usize)> {
    let end = line_end(input);
    let line = input[..end].trim();
    if line == "---" || line == "***" || line == "___" {
        let consumed = if end < input.len() { end + 1 } else { end };
        return Some((json!({ "type": "horizontalRule" }), consumed));
    }
    None
}

fn try_fence(input: &str) -> Option<(Value, usize)> {
    if !input.starts_with("```") {
        return None;
    }
    let first_end = line_end(input);
    let lang = input[3..first_end].trim().to_string();
    let after = if first_end < input.len() {
        &input[first_end + 1..]
    } else {
        ""
    };
    let close = after
        .find("\n```")
        .or_else(|| after.strip_suffix("```").map(|s| s.len()))?;
    let text = after[..close].trim_end_matches('\n');
    let after_fence = &after[close..];
    let fence_end = after_fence.find("```").map(|i| i + 3).unwrap_or(3);
    let mut consumed = first_end + 1 + close + fence_end;
    if after.get(close + fence_end..close + fence_end + 1) == Some("\n") {
        consumed += 1;
    }
    let consumed = consumed.min(input.len());
    let mut node = json!({
        "type": "codeBlock",
        "content": [{ "type": "text", "text": text }]
    });
    if !lang.is_empty() {
        node["attrs"] = json!({ "language": lang });
    }
    Some((node, consumed))
}

fn try_blockquote(input: &str) -> Option<(Value, usize)> {
    if !input.starts_with("> ") && input != ">" && !input.starts_with(">\n") {
        return None;
    }
    let mut inner = String::new();
    let mut consumed = 0;
    for line in input.split_inclusive('\n') {
        let raw = line.trim_end_matches('\n');
        if raw == ">" || raw.starts_with("> ") || raw == ">" {
            if !inner.is_empty() {
                inner.push('\n');
            }
            inner.push_str(
                raw.strip_prefix("> ")
                    .unwrap_or(raw.strip_prefix('>').unwrap_or("")),
            );
            consumed += line.len();
        } else {
            break;
        }
    }
    if consumed == 0 {
        return None;
    }
    Some((
        json!({
            "type": "blockquote",
            "content": parse_blocks(&inner)
        }),
        consumed,
    ))
}

fn try_list(input: &str) -> Option<(Value, usize)> {
    let first = input.lines().next()?;
    let trimmed = first.trim_start();
    let is_task = trimmed.starts_with("- [ ] ")
        || trimmed.starts_with("- [x] ")
        || trimmed.starts_with("- [X] ");
    let is_bullet = trimmed.starts_with("- ") && !is_task;
    let is_ordered = ordered_marker(trimmed).is_some();
    if !is_task && !is_bullet && !is_ordered {
        return None;
    }

    let mut items = Vec::new();
    let mut consumed = 0;
    let mut rest = input;
    loop {
        let line = rest.lines().next().unwrap_or("");
        if line.is_empty() && rest.starts_with('\n') {
            break;
        }
        let indent = line.chars().take_while(|c| *c == ' ').count();
        if indent > 0 {
            break;
        }
        let body_line = line.trim_start();
        let (marker_len, checked) = if body_line.starts_with("- [ ] ") {
            (6, Some(false))
        } else if body_line.starts_with("- [x] ") || body_line.starts_with("- [X] ") {
            (6, Some(true))
        } else if body_line.starts_with("- ") {
            (2, None)
        } else if let Some(n) = ordered_marker(body_line) {
            (n, None)
        } else {
            break;
        };
        let first_text = &body_line[marker_len..];
        let line_len = if rest.len() > line.len() {
            line.len() + 1
        } else {
            line.len()
        };
        rest = &rest[line_len..];
        consumed += line_len;

        let mut item_md = first_text.to_string();
        loop {
            let next = rest.lines().next().unwrap_or("");
            let next_indent = next.chars().take_while(|c| *c == ' ').count();
            if next_indent >= 2 && !next.trim().is_empty() {
                if !item_md.is_empty() {
                    item_md.push('\n');
                }
                item_md.push_str(next.get(2..).unwrap_or(next.trim_start()));
                let nlen = if rest.len() > next.len() {
                    next.len() + 1
                } else {
                    next.len()
                };
                rest = &rest[nlen..];
                consumed += nlen;
            } else {
                break;
            }
        }

        let content = parse_blocks(&item_md);
        let mut item = if checked.is_some() {
            json!({ "type": "taskItem", "content": content })
        } else {
            json!({ "type": "listItem", "content": content })
        };
        if let Some(c) = checked {
            item["attrs"] = json!({ "checked": c });
        }
        items.push(item);

        if rest.starts_with('\n') {
            break;
        }
    }

    if items.is_empty() {
        return None;
    }
    let list_type = if is_task {
        "taskList"
    } else if is_ordered {
        "orderedList"
    } else {
        "bulletList"
    };
    Some((json!({ "type": list_type, "content": items }), consumed))
}

fn ordered_marker(line: &str) -> Option<usize> {
    let digits = line.chars().take_while(|c| c.is_ascii_digit()).count();
    if digits == 0 {
        return None;
    }
    if line.as_bytes().get(digits) == Some(&b'.') && line.as_bytes().get(digits + 1) == Some(&b' ')
    {
        Some(digits + 2)
    } else {
        None
    }
}

fn try_html_block(input: &str) -> Option<(Value, usize)> {
    if input.starts_with("<a data-type=\"resource-block\"") {
        return parse_resource_block(input, "resource-block", "atomic-data-resource", true);
    }
    if input.starts_with("<note-block>") {
        return parse_wrapped_block(input, "<note-block>", "</note-block>", "note-block");
    }
    if input.starts_with("<table>") {
        return parse_table_block(input);
    }
    if input.starts_with("<p style=\"text-align:") {
        return parse_aligned_paragraph(input);
    }
    if input.starts_with("<div data-pm-type=\"") {
        return parse_unknown_block(input);
    }
    None
}

fn parse_resource_block(
    input: &str,
    data_type: &str,
    node_type: &str,
    block: bool,
) -> Option<(Value, usize)> {
    let needle = format!("data-type=\"{data_type}\"");
    if !input.contains(&needle) {
        return None;
    }
    let href = attr_from_tag(input, "href")?;
    let close = input.find("</a>")?;
    let inner_start = input.find('>')? + 1;
    let title = unescape_html(&input[inner_start..close]);
    let after = close + 4;
    let consumed = if input.get(after..after + 1) == Some("\n") {
        after + 1
    } else {
        after
    };
    let mut node = json!({
        "type": node_type,
        "attrs": { "subject": unescape_attr(&href) }
    });
    if !title.is_empty() {
        node["content"] = json!([{ "type": "text", "text": title }]);
    }
    let _ = block;
    Some((node, consumed))
}

fn parse_wrapped_block(
    input: &str,
    open: &str,
    close: &str,
    node_type: &str,
) -> Option<(Value, usize)> {
    if !input.starts_with(open) {
        return None;
    }
    let end = input.find(close)?;
    let inner = input[open.len()..end].trim();
    let consumed = end + close.len();
    let consumed = if input.get(consumed..consumed + 1) == Some("\n") {
        consumed + 1
    } else {
        consumed
    };
    Some((
        json!({
            "type": node_type,
            "content": parse_blocks(inner)
        }),
        consumed,
    ))
}

fn parse_aligned_paragraph(input: &str) -> Option<(Value, usize)> {
    let close = input.find("</p>")?;
    let style_start = input.find("text-align: ")? + "text-align: ".len();
    let style_end = input[style_start..].find('"')?;
    let align = &input[style_start..style_start + style_end];
    let inner_start = input.find('>')? + 1;
    let inner = &input[inner_start..close];
    let consumed = close + 4;
    let consumed = if input.get(consumed..consumed + 1) == Some("\n") {
        consumed + 1
    } else {
        consumed
    };
    Some((
        json!({
            "type": "paragraph",
            "attrs": { "textAlign": align },
            "content": parse_inlines(inner)
        }),
        consumed,
    ))
}

fn parse_unknown_block(input: &str) -> Option<(Value, usize)> {
    let ty = attr_from_tag(input, "data-pm-type")?;
    let attrs_raw = attr_from_tag(input, "data-pm-attrs").unwrap_or_default();
    let close = input.find("</div>")?;
    let inner_start = input.find('>')? + 1;
    let inner = input[inner_start..close].trim();
    let consumed = close + 6;
    let consumed = if input.get(consumed..consumed + 1) == Some("\n") {
        consumed + 1
    } else {
        consumed
    };
    let mut node = json!({ "type": unescape_attr(&ty) });
    if !attrs_raw.is_empty() && attrs_raw != "{}" {
        if let Ok(attrs) = serde_json::from_str::<Value>(&unescape_attr(&attrs_raw)) {
            node["attrs"] = attrs;
        }
    }
    if !inner.is_empty() {
        node["content"] = json!(parse_blocks(inner));
    }
    Some((node, consumed))
}

fn parse_table_block(input: &str) -> Option<(Value, usize)> {
    let close = input.find("</table>")?;
    let inner = &input["<table>".len()..close];
    let mut rows = Vec::new();
    let mut rest = inner;
    while let Some(tr_start) = rest.find("<tr>") {
        rest = &rest[tr_start + 4..];
        let tr_end = rest.find("</tr>")?;
        let row_html = &rest[..tr_end];
        rest = &rest[tr_end + 5..];
        let mut cells = Vec::new();
        let mut cell_rest = row_html;
        loop {
            let th = cell_rest.find("<th>");
            let td = cell_rest.find("<td>");
            let (tag, start, close_tag, cell_type) = match (th, td) {
                (Some(h), Some(d)) if h < d => ("<th>", h, "</th>", "tableHeader"),
                (Some(h), None) => ("<th>", h, "</th>", "tableHeader"),
                (_, Some(d)) => ("<td>", d, "</td>", "tableCell"),
                _ => break,
            };
            cell_rest = &cell_rest[start + tag.len()..];
            let end = cell_rest.find(close_tag)?;
            let cell_inner = cell_rest[..end].trim();
            cell_rest = &cell_rest[end + close_tag.len()..];
            cells.push(json!({
                "type": cell_type,
                "content": parse_blocks(cell_inner)
            }));
        }
        rows.push(json!({ "type": "tableRow", "content": cells }));
    }
    let consumed = close + 8;
    let consumed = if input.get(consumed..consumed + 1) == Some("\n") {
        consumed + 1
    } else {
        consumed
    };
    Some((json!({ "type": "table", "content": rows }), consumed))
}

fn attr_from_tag(tag: &str, name: &str) -> Option<String> {
    let prefix = format!("{name}=\"");
    let start = tag.find(&prefix)? + prefix.len();
    let end = tag[start..].find('"')?;
    Some(tag[start..start + end].to_string())
}

fn try_paragraph(input: &str) -> Option<(Value, usize)> {
    let mut consumed = 0;
    let mut lines = Vec::new();
    for line in input.split_inclusive('\n') {
        let raw = line.trim_end_matches('\n');
        if raw.is_empty() {
            consumed += line.len();
            break;
        }
        if looks_like_block_start(raw) && !lines.is_empty() {
            break;
        }
        if !lines.is_empty() {
            lines.push("\n".into());
        }
        lines.push(raw.to_string());
        consumed += line.len();
        if line.ends_with('\n') && input[consumed..].starts_with('\n') {
            break;
        }
    }
    if lines.is_empty() {
        return None;
    }
    let text = lines.concat();
    if text == "<br>" {
        return Some((
            json!({
                "type": "paragraph",
                "content": [{ "type": "hardBreak" }]
            }),
            consumed,
        ));
    }
    Some((
        json!({
            "type": "paragraph",
            "content": parse_inlines(&text)
        }),
        consumed,
    ))
}

fn looks_like_block_start(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with('#')
        || t.starts_with("```")
        || t.starts_with("---")
        || t.starts_with("> ")
        || t.starts_with("- ")
        || ordered_marker(t).is_some()
        || t.starts_with("<a data-type=")
        || t.starts_with("<note-block")
        || t.starts_with("<table")
        || t.starts_with("<div data-pm-type=")
        || t.starts_with("<p style=")
}

fn parse_inlines(input: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let mut rest = input;
    while !rest.is_empty() {
        if rest.starts_with("<br>") {
            out.push(json!({ "type": "hardBreak" }));
            rest = &rest[4..];
            continue;
        }
        if rest.starts_with("<a data-type=\"resource-inline\"") {
            if let Some((node, n)) = parse_resource_block(
                rest,
                "resource-inline",
                "atomic-data-resource-inline",
                false,
            ) {
                out.push(node);
                rest = &rest[n..];
                continue;
            }
        }
        if rest.starts_with("[@id=\"") {
            if let Some((node, n)) = parse_mention(rest) {
                out.push(node);
                rest = &rest[n..];
                continue;
            }
        }
        if rest.starts_with("![") {
            if let Some((node, n)) = parse_image(rest) {
                out.push(node);
                rest = &rest[n..];
                continue;
            }
        }
        if let Some((node, n)) = parse_marked(rest) {
            out.push(node);
            rest = &rest[n..];
            continue;
        }
        let next_special = rest
            .char_indices()
            .find(|(_, c)| matches!(c, '*' | '`' | '~' | '[' | '<' | '\\' | '!'))
            .map(|(i, _)| i)
            .unwrap_or(rest.len());
        let take = if next_special == 0 { 1 } else { next_special };
        let chunk = &rest[..take];
        push_text(&mut out, &unescape_inline(chunk));
        rest = &rest[take..];
    }
    out
}

fn push_text(out: &mut Vec<Value>, text: &str) {
    if text.is_empty() {
        return;
    }
    if let Some(Value::Object(last)) = out.last_mut() {
        if last.get("type").and_then(|t| t.as_str()) == Some("text") && last.get("marks").is_none()
        {
            if let Some(Value::String(existing)) = last.get_mut("text") {
                existing.push_str(text);
                return;
            }
        }
    }
    out.push(json!({ "type": "text", "text": text }));
}

fn parse_mention(input: &str) -> Option<(Value, usize)> {
    if !input.starts_with("[@id=\"") {
        return None;
    }
    let end = input.find(']')?;
    let inner = &input[1..end];
    let id = capture_quoted(inner, "id=")?;
    let label = capture_quoted(inner, "label=").unwrap_or_default();
    Some((
        json!({
            "type": "mention",
            "attrs": { "id": unescape_attr(&id), "label": unescape_attr(&label) }
        }),
        end + 1,
    ))
}

fn capture_quoted(input: &str, key: &str) -> Option<String> {
    let start = input.find(key)? + key.len();
    if !input[start..].starts_with('"') {
        return None;
    }
    let rest = &input[start + 1..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

fn parse_image(input: &str) -> Option<(Value, usize)> {
    if !input.starts_with("![") {
        return None;
    }
    let alt_end = input.find("](")?;
    let alt = &input[2..alt_end];
    let rest = &input[alt_end + 2..];
    let src_end = rest.find(')')?;
    let src = &rest[..src_end];
    Some((
        json!({
            "type": "image",
            "attrs": { "alt": alt, "src": src }
        }),
        alt_end + 2 + src_end + 1,
    ))
}

fn parse_marked(input: &str) -> Option<(Value, usize)> {
    if input.starts_with("<span style=\"") {
        return parse_styled_span(input);
    }
    if input.starts_with("**") {
        return wrap_delimited(input, "**", "bold");
    }
    if input.starts_with("~~") {
        return wrap_delimited(input, "~~", "strike");
    }
    if input.starts_with('*') {
        return wrap_delimited(input, "*", "italic");
    }
    if input.starts_with('`') {
        return wrap_delimited(input, "`", "code");
    }
    if input.starts_with('[') && !input.starts_with("[@") {
        return parse_link(input);
    }
    None
}

fn wrap_delimited(input: &str, delim: &str, mark: &str) -> Option<(Value, usize)> {
    if !input.starts_with(delim) {
        return None;
    }
    let rest = &input[delim.len()..];
    let end = rest.find(delim)?;
    let inner = &rest[..end];
    let mut nodes = parse_inlines(inner);
    apply_mark_to_nodes(&mut nodes, mark, None);
    let node = if nodes.len() == 1 {
        nodes.pop().unwrap()
    } else {
        json!({ "type": "text", "text": inner, "marks": [{ "type": mark }] })
    };
    Some((node, delim.len() * 2 + end))
}

fn apply_mark_to_nodes(nodes: &mut [Value], mark: &str, attrs: Option<Value>) {
    for node in nodes {
        if let Value::Object(obj) = node {
            if obj.get("type").and_then(|t| t.as_str()) == Some("text") {
                let mut marks = obj
                    .get("marks")
                    .and_then(|m| m.as_array())
                    .cloned()
                    .unwrap_or_default();
                let mut m = json!({ "type": mark });
                if let Some(attrs) = attrs.clone() {
                    m["attrs"] = attrs;
                }
                marks.insert(0, m);
                obj.insert("marks".into(), Value::Array(marks));
            }
        }
    }
}

fn parse_link(input: &str) -> Option<(Value, usize)> {
    if !input.starts_with('[') {
        return None;
    }
    let text_end = input.find("](")?;
    let text = &input[1..text_end];
    let rest = &input[text_end + 2..];
    let href_end = rest.find(')')?;
    let href = &rest[..href_end];
    let mut nodes = parse_inlines(text);
    apply_mark_to_nodes(&mut nodes, "link", Some(json!({ "href": href })));
    let node = if nodes.len() == 1 {
        nodes.pop().unwrap()
    } else {
        json!({
            "type": "text",
            "text": text,
            "marks": [{ "type": "link", "attrs": { "href": href } }]
        })
    };
    Some((node, text_end + 2 + href_end + 1))
}

fn parse_styled_span(input: &str) -> Option<(Value, usize)> {
    if !input.starts_with("<span style=\"") {
        return None;
    }
    let style_end = input.find("\">")?;
    let style = &input["<span style=\"".len()..style_end];
    let rest = &input[style_end + 2..];
    let close = rest.find("</span>")?;
    let inner = &rest[..close];
    let mut nodes = parse_inlines(inner);
    if let Some(color) = style.strip_prefix("color: ") {
        apply_mark_to_nodes(
            &mut nodes,
            "textStyle",
            Some(json!({ "color": color.trim() })),
        );
    } else if let Some(color) = style.strip_prefix("background-color: ") {
        apply_mark_to_nodes(
            &mut nodes,
            "highlight",
            Some(json!({ "color": color.trim() })),
        );
    }
    let node = nodes.pop()?;
    Some((node, style_end + 2 + close + 7))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip(doc: Value) -> Value {
        let md = serialize(&doc);
        parse(&md)
    }

    fn text(s: &str) -> Value {
        json!({ "type": "text", "text": s })
    }

    fn marked(s: &str, mark: &str) -> Value {
        json!({ "type": "text", "text": s, "marks": [{ "type": mark }] })
    }

    #[test]
    fn heading_marks_list_roundtrip() {
        let doc = json!({
            "type": "doc",
            "content": [
                {
                    "type": "heading",
                    "attrs": { "level": 1 },
                    "content": [text("Hello from Atomic")]
                },
                {
                    "type": "paragraph",
                    "content": [
                        marked("bold", "bold"),
                        text(" and "),
                        marked("italic", "italic")
                    ]
                },
                {
                    "type": "bulletList",
                    "content": [{
                        "type": "listItem",
                        "content": [{
                            "type": "paragraph",
                            "content": [text("one")]
                        }]
                    }]
                }
            ]
        });
        let md = serialize(&doc);
        assert!(md.contains("# Hello from Atomic"), "{md}");
        assert!(md.contains("**bold**"), "{md}");
        assert!(md.contains("*italic*"), "{md}");
        assert!(md.contains("- one"), "{md}");
        let back = parse(&md);
        assert_eq!(back["content"][0]["type"], "heading");
        assert_eq!(back["content"][0]["attrs"]["level"], 1);
        assert_eq!(back["content"][1]["content"][0]["marks"][0]["type"], "bold");
        assert_eq!(back["content"][2]["type"], "bulletList");
    }

    #[test]
    fn resource_block_roundtrip() {
        let doc = json!({
            "type": "doc",
            "content": [{
                "type": "atomic-data-resource",
                "attrs": { "subject": "Atomic Data.json" }
            }]
        });
        let md = serialize(&doc);
        assert!(
            md.contains("<a data-type=\"resource-block\" href=\"Atomic Data.json\">"),
            "{md}"
        );
        let back = parse(&md);
        assert_eq!(back["content"][0]["type"], "atomic-data-resource");
        assert_eq!(back["content"][0]["attrs"]["subject"], "Atomic Data.json");
    }

    #[test]
    fn mention_and_code_roundtrip() {
        let doc = json!({
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [{
                        "type": "mention",
                        "attrs": { "id": "did:ad:agent:abc", "label": "Ada" }
                    }]
                },
                {
                    "type": "codeBlock",
                    "attrs": { "language": "rs" },
                    "content": [text("fn main() {}")]
                }
            ]
        });
        let md = serialize(&doc);
        assert!(
            md.contains("[@id=\"did:ad:agent:abc\" label=\"Ada\"]"),
            "{md}"
        );
        assert!(md.contains("```rs"), "{md}");
        let back = parse(&md);
        assert_eq!(back["content"][0]["content"][0]["type"], "mention");
        assert_eq!(back["content"][1]["type"], "codeBlock");
        assert_eq!(back["content"][1]["attrs"]["language"], "rs");
    }

    #[test]
    fn rewrite_resource_subject() {
        let mut doc = json!({
            "type": "doc",
            "content": [{
                "type": "atomic-data-resource",
                "attrs": { "subject": "old" }
            }]
        });
        rewrite_pm_refs(&mut doc, &|s| {
            if s == "old" {
                Some("new".into())
            } else {
                None
            }
        });
        assert_eq!(doc["content"][0]["attrs"]["subject"], "new");
    }

    #[test]
    fn normalize_loro_shape() {
        let loro = json!({
            "nodeName": "doc",
            "children": [{
                "nodeName": "paragraph",
                "children": ["Hi"]
            }]
        });
        let pm = normalize_pm_json(&loro);
        assert_eq!(pm["type"], "doc");
        assert_eq!(pm["content"][0]["type"], "paragraph");
        assert_eq!(pm["content"][0]["content"][0]["text"], "Hi");
    }

    #[test]
    fn serialize_parse_is_stable() {
        let doc = json!({
            "type": "doc",
            "content": [
                {
                    "type": "heading",
                    "attrs": { "level": 2 },
                    "content": [text("Title")]
                },
                {
                    "type": "paragraph",
                    "content": [text("Hello")]
                }
            ]
        });
        let once = serialize(&doc);
        let twice = serialize(&roundtrip(doc));
        assert_eq!(once, twice);
    }
}
