use reqwest::blocking::Client;

use crate::services::url_indexing::pipeline::PipelineOutput;

pub fn fetch_default_web(url: &str) -> Result<PipelineOutput, String> {
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|error| error.to_string())?;

    let response = client.get(url).send().map_err(|error| error.to_string())?;
    let final_url = response.url().to_string();
    let html = response.text().map_err(|error| error.to_string())?;

    Ok(PipelineOutput {
        title: extract_title(&html).or_else(|| extract_meta_content(&html, "property", "og:title")),
        description: extract_meta_content(&html, "name", "description")
            .or_else(|| extract_meta_content(&html, "property", "og:description")),
        preview_text: extract_preview_text(&html),
        canonical_url: extract_link_href(&html, "canonical").or(Some(final_url)),
        html,
    })
}

fn extract_title(html: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let start = lower.find("<title>")?;
    let end = lower[start + 7..].find("</title>")?;
    let raw = &html[start + 7..start + 7 + end];
    let title = collapse_whitespace(raw);
    (!title.is_empty()).then_some(title)
}

fn extract_meta_content(html: &str, attribute: &str, value: &str) -> Option<String> {
    for (index, _) in html.match_indices("<meta") {
        let after = &html[index..];
        let end = after.find('>')?;
        let tag_content = &after[..=end];
        if !contains_attribute(tag_content, attribute, value) {
            continue;
        }
        if let Some(content) = extract_attribute(tag_content, "content") {
            let collapsed = collapse_whitespace(&content);
            if !collapsed.is_empty() {
                return Some(collapsed);
            }
        }
    }
    None
}

fn extract_link_href(html: &str, rel_value: &str) -> Option<String> {
    for (index, _) in html.match_indices("<link") {
        let after = &html[index..];
        let end = after.find('>')?;
        let tag_content = &after[..=end];
        if !contains_attribute(tag_content, "rel", rel_value) {
            continue;
        }
        if let Some(href) = extract_attribute(tag_content, "href") {
            if !href.trim().is_empty() {
                return Some(href);
            }
        }
    }
    None
}

fn contains_attribute(tag_content: &str, attribute: &str, expected_value: &str) -> bool {
    extract_attribute(tag_content, attribute)
        .map(|value| value.eq_ignore_ascii_case(expected_value))
        .unwrap_or(false)
}

fn extract_attribute(tag_content: &str, attribute: &str) -> Option<String> {
    let lower = tag_content.to_lowercase();
    let pattern = format!("{attribute}=");
    let start = lower.find(&pattern)?;
    let raw = &tag_content[start + pattern.len()..];
    let mut chars = raw.chars();
    let quote = chars.next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let raw_body = chars.as_str();
    let end = raw_body.find(quote)?;
    Some(raw_body[..end].to_string())
}

fn extract_preview_text(html: &str) -> String {
    let without_scripts = strip_block(html, "script");
    let without_styles = strip_block(&without_scripts, "style");
    let mut text = String::with_capacity(without_styles.len());
    let mut inside_tag = false;

    for ch in without_styles.chars() {
        match ch {
            '<' => inside_tag = true,
            '>' => {
                inside_tag = false;
                text.push(' ');
            }
            _ if !inside_tag => text.push(ch),
            _ => {}
        }
    }

    collapse_whitespace(&text).chars().take(320).collect()
}

fn strip_block(html: &str, tag: &str) -> String {
    let mut output = html.to_string();
    loop {
        let lower = output.to_lowercase();
        let start = match lower.find(&format!("<{tag}")) {
            Some(start) => start,
            None => break,
        };
        let end_pattern = format!("</{tag}>");
        let end = match lower[start..].find(&end_pattern) {
            Some(offset) => start + offset + end_pattern.len(),
            None => break,
        };
        output.replace_range(start..end, " ");
    }
    output
}

fn collapse_whitespace(input: &str) -> String {
    input.split_whitespace().collect::<Vec<_>>().join(" ")
}
