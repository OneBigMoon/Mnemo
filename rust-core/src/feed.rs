//! RSS/Atom parser copied from output/zcode-work/rust-core/src/feed.rs.
//! Valid item behavior is retained; the public entry rejects malformed documents.

use crate::{CoreError, MAX_RESULTS};
use quick_xml::events::Event;
use quick_xml::Reader;
use std::io::BufRead;

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct FeedItem {
    pub title: Option<String>,
    pub url: Option<String>,
    pub guid: Option<String>,
    pub published: Option<String>,
    pub description: Option<String>,
    /// RSS enclosure 的 length 属性（字节）；Atom 无此字段时为 None。
    pub size_bytes: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct Feed {
    pub kind: FeedKind,
    pub title: Option<String>,
    pub link: Option<String>,
    pub items: Vec<FeedItem>,
    /// 被跳过的畸形条目数（宽容解析，不致命）。
    pub skipped: u32,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FeedKind {
    #[default]
    Unknown,
    Rss,
    Atom,
}

pub type FeedError = CoreError;

fn local_name(name: &[u8]) -> String {
    // 去掉命名空间前缀：media:title / atom:link → title / link。
    let text = String::from_utf8_lossy(name);
    text.rsplit(':').next().unwrap_or("").to_ascii_lowercase()
}

fn nonempty(text: &str) -> Option<String> {
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn decode_text(bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(bytes);
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn item_text(event: &Event<'_>) -> Option<String> {
    match event {
        Event::Text(text) => text.unescape().ok().and_then(|value| nonempty(&value)),
        Event::CData(cdata) => decode_text(cdata.as_ref()),
        _ => None,
    }
}

fn xml_error() -> FeedError {
    CoreError::new("FEED_XML", "Feed XML is malformed or incomplete")
}

fn format_error() -> FeedError {
    CoreError::new("FEED_FORMAT", "Feed root must be rss or feed")
}

/// Validate before the reused parser so its tolerant item handling cannot hide broken XML.
pub fn parse_feed(payload: &str) -> Result<Feed, FeedError> {
    validate_xml(payload)?;
    parse_feed_stream(std::io::Cursor::new(payload.as_bytes()))
}

fn validate_xml(payload: &str) -> Result<(), FeedError> {
    let mut reader = Reader::from_str(payload);
    reader.config_mut().check_comments = true;
    let mut depth = 0usize;
    let mut root_seen = false;
    loop {
        let event = reader.read_event().map_err(|_| xml_error())?;
        match &event {
            Event::Start(tag) | Event::Empty(tag) => {
                if depth == 0 {
                    if root_seen {
                        return Err(xml_error());
                    }
                    if !matches!(local_name(tag.name().as_ref()).as_str(), "rss" | "feed") {
                        return Err(format_error());
                    }
                    root_seen = true;
                }
                for attribute in tag.attributes() {
                    attribute
                        .map_err(|_| xml_error())?
                        .unescape_value()
                        .map_err(|_| xml_error())?;
                }
                if matches!(&event, Event::Start(_)) {
                    depth += 1;
                }
            }
            Event::End(_) => {
                if depth == 0 {
                    return Err(xml_error());
                }
                depth -= 1;
            }
            Event::Text(text) => {
                let value = text.unescape().map_err(|_| xml_error())?;
                if depth == 0 && !value.trim().is_empty() {
                    return Err(if root_seen {
                        xml_error()
                    } else {
                        format_error()
                    });
                }
            }
            Event::CData(_) if depth == 0 => return Err(xml_error()),
            Event::Decl(_) | Event::DocType(_) if root_seen => return Err(xml_error()),
            Event::Eof => break,
            _ => {}
        }
    }
    if !root_seen {
        return Err(format_error());
    }
    if depth != 0 {
        return Err(xml_error());
    }
    Ok(())
}

fn record_item(feed: &mut Feed, item: Option<FeedItem>) -> Result<(), FeedError> {
    if let Some(item) = item {
        if feed.items.len() == MAX_RESULTS {
            return Err(CoreError::new("LIMIT", "Feed exceeds 1000 result items"));
        }
        feed.items.push(item);
    } else {
        feed.skipped += 1;
    }
    Ok(())
}

/// 从流式输入解析 RSS/Atom。
fn parse_feed_stream(input: impl BufRead) -> Result<Feed, FeedError> {
    let mut reader = Reader::from_reader(input);
    reader.config_mut().trim_text(true);
    let mut feed = Feed::default();
    let mut depth_root_seen = false;
    let mut buf = Vec::new();
    // Atom 的 feed 级 title 直接位于 <feed> 下（RSS 走 channel 头）。
    let mut atom_current: Option<String> = None;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref start)) => {
                let name = local_name(start.name().as_ref());
                if feed.kind == FeedKind::Atom && (name == "title" || name == "subtitle") {
                    atom_current = Some(name);
                    continue;
                }
                if feed.kind == FeedKind::Atom && name == "link" {
                    let mut href = None;
                    let mut is_alternate = false;
                    let mut has_rel = false;
                    for attribute in start.attributes().flatten() {
                        match attribute.key.as_ref() {
                            b"rel" => {
                                has_rel = true;
                                if let Ok(value) = attribute.unescape_value() {
                                    is_alternate = value.trim() == "alternate";
                                }
                            }
                            b"href" => {
                                if let Ok(value) = attribute.unescape_value() {
                                    href = Some(value.trim().to_string());
                                }
                            }
                            _ => {}
                        }
                    }
                    if feed.link.is_none() && (is_alternate || !has_rel) {
                        feed.link = href;
                    }
                    continue;
                }
                match name.as_str() {
                    "rss" => {
                        feed.kind = FeedKind::Rss;
                        depth_root_seen = true;
                    }
                    "feed" => {
                        feed.kind = FeedKind::Atom;
                        depth_root_seen = true;
                    }
                    "channel" if feed.kind == FeedKind::Rss => {
                        parse_channel_header(&mut reader, &mut feed)?;
                    }
                    "item" if feed.kind == FeedKind::Rss => {
                        record_item(&mut feed, parse_item(&mut reader))?
                    }
                    "entry" if feed.kind == FeedKind::Atom => {
                        record_item(&mut feed, parse_entry(&mut reader))?
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(ref text)) => {
                if let Some(name) = &atom_current {
                    let value = text.unescape().ok().and_then(|t| nonempty(&t));
                    if name == "title" {
                        feed.title = feed.title.take().or(value);
                    }
                }
                atom_current = None;
            }
            Ok(Event::CData(ref cdata)) => {
                if let Some(name) = &atom_current {
                    let value = decode_text(cdata.as_ref());
                    if name == "title" {
                        feed.title = feed.title.take().or(value);
                    }
                }
                atom_current = None;
            }
            Ok(Event::Eof) => break,
            Ok(Event::Empty(ref empty)) => {
                // Atom 顶层自闭合 <link href=... />（rel 缺省按 alternate 处理）。
                let name = local_name(empty.name().as_ref());
                if !depth_root_seen {
                    match name.as_str() {
                        "rss" => {
                            feed.kind = FeedKind::Rss;
                            depth_root_seen = true;
                        }
                        "feed" => {
                            feed.kind = FeedKind::Atom;
                            depth_root_seen = true;
                        }
                        _ => {}
                    }
                }
                if feed.kind == FeedKind::Atom && name == "link" && feed.link.is_none() {
                    let mut href = None;
                    let mut is_alternate = false;
                    let mut has_rel = false;
                    for attribute in empty.attributes().flatten() {
                        match attribute.key.as_ref() {
                            b"rel" => {
                                has_rel = true;
                                if let Ok(value) = attribute.unescape_value() {
                                    is_alternate = value.trim() == "alternate";
                                }
                            }
                            b"href" => {
                                if let Ok(value) = attribute.unescape_value() {
                                    href = Some(value.trim().to_string());
                                }
                            }
                            _ => {}
                        }
                    }
                    if is_alternate || !has_rel {
                        feed.link = href;
                    }
                }
            }
            Ok(_) => {}
            Err(_) => return Err(xml_error()),
        }
    }
    if !depth_root_seen {
        return Err(format_error());
    }
    Ok(feed)
}

fn parse_channel_header(
    reader: &mut Reader<impl BufRead>,
    feed: &mut Feed,
) -> Result<(), FeedError> {
    // channel 头部的 title/link 在第一个 item 之前。
    let mut current: Option<String> = None;
    let mut buf = Vec::new();
    loop {
        let event = reader.read_event_into(&mut buf).map_err(|_| xml_error())?;
        match event {
            Event::Start(ref start) => {
                let name = local_name(start.name().as_ref());
                if name == "item" {
                    // 头部结束；把位置留给外层循环处理条目。
                    // quick-xml 无法回退，这里直接就地解析该条目。
                    record_item(feed, parse_item(reader))?;
                    current = None;
                    continue;
                }
                current = Some(name);
            }
            Event::Text(ref text) => {
                if let Some(name) = &current {
                    let value = text.unescape().ok().and_then(|t| nonempty(&t));
                    match name.as_str() {
                        "title" => feed.title = feed.title.take().or(value),
                        "link" => feed.link = feed.link.take().or(value),
                        _ => {}
                    }
                }
                current = None;
            }
            Event::CData(ref cdata) => {
                if let Some(name) = &current {
                    let value = decode_text(cdata.as_ref());
                    if name.as_str() == "title" {
                        feed.title = feed.title.take().or(value)
                    }
                }
                current = None;
            }
            Event::Empty(ref empty) => {
                let name = local_name(empty.name().as_ref());
                if name == "link" {
                    for attribute in empty.attributes().flatten() {
                        if attribute.key.as_ref() == b"href" {
                            if let Ok(value) = attribute.unescape_value() {
                                if feed.link.is_none() && !value.trim().is_empty() {
                                    feed.link = Some(value.trim().to_string());
                                }
                            }
                        }
                    }
                }
                current = None;
            }
            Event::End(_) => current = None,
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(())
}

fn parse_item(reader: &mut Reader<impl BufRead>) -> Option<FeedItem> {
    let mut item = FeedItem::default();
    let mut current: Option<String> = None;
    let mut saw_any = false;
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(start)) => {
                saw_any = true;
                current = Some(local_name(start.name().as_ref()));
                if current.as_deref() == Some("enclosure") {
                    for attribute in start.attributes().flatten() {
                        match attribute.key.as_ref() {
                            b"url" => {
                                if let Ok(value) = attribute.unescape_value() {
                                    item.url = Some(value.trim().to_string());
                                }
                            }
                            b"length" => {
                                if let Ok(value) = attribute.unescape_value() {
                                    item.size_bytes = value.trim().parse::<u64>().ok();
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
            Ok(Event::Empty(empty)) => {
                saw_any = true;
                let name = local_name(empty.name().as_ref());
                if name == "enclosure" {
                    for attribute in empty.attributes().flatten() {
                        match attribute.key.as_ref() {
                            b"url" => {
                                if let Ok(value) = attribute.unescape_value() {
                                    item.url = Some(value.trim().to_string());
                                }
                            }
                            b"length" => {
                                if let Ok(value) = attribute.unescape_value() {
                                    item.size_bytes = value.trim().parse::<u64>().ok();
                                }
                            }
                            _ => {}
                        }
                    }
                }
                current = None;
            }
            Ok(event @ (Event::Text(_) | Event::CData(_))) => {
                if let Some(name) = &current {
                    let value = item_text(&event);
                    match name.as_str() {
                        "title" => item.title = value,
                        "link" => item.url = item.url.take().or(value),
                        "guid" => item.guid = value,
                        "pubdate" | "published" | "updated" => item.published = value,
                        "description" | "summary" | "content" => item.description = value,
                        _ => {}
                    }
                }
                current = None;
            }
            Ok(Event::End(end)) => {
                if local_name(end.name().as_ref()) == "item" {
                    // 没有任何可辨识字段的空 item 视为畸形。
                    let meaningful = item.title.is_some()
                        || item.url.is_some()
                        || item.guid.is_some()
                        || item.description.is_some();
                    return if meaningful || saw_any {
                        Some(item)
                    } else {
                        None
                    };
                }
                current = None;
            }
            Ok(Event::Eof) => return None, // 条目未闭合：按畸形处理
            Err(_) => return None,
            _ => {}
        }
    }
}

fn parse_entry(reader: &mut Reader<impl BufRead>) -> Option<FeedItem> {
    let mut item = FeedItem::default();
    let mut current: Option<String> = None;
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(start)) => {
                let name = local_name(start.name().as_ref());
                if name == "link" {
                    let mut href = None;
                    let mut is_enclosure = false;
                    let mut is_alternate = true;
                    for attribute in start.attributes().flatten() {
                        match attribute.key.as_ref() {
                            b"rel" => {
                                if let Ok(value) = attribute.unescape_value() {
                                    is_enclosure = value.trim() == "enclosure";
                                    is_alternate = value.trim() == "alternate";
                                }
                            }
                            b"href" => {
                                if let Ok(value) = attribute.unescape_value() {
                                    href = Some(value.trim().to_string());
                                }
                            }
                            _ => {}
                        }
                    }
                    if is_enclosure {
                        if let Some(url) = href {
                            item.url = Some(url);
                        }
                    } else if is_alternate && item.url.is_none() {
                        item.url = href;
                    }
                    current = None;
                    continue;
                }
                current = Some(name);
            }
            Ok(Event::Empty(empty)) => {
                let name = local_name(empty.name().as_ref());
                if name == "link" {
                    let mut href = None;
                    let mut is_enclosure = false;
                    let mut is_alternate = true;
                    for attribute in empty.attributes().flatten() {
                        match attribute.key.as_ref() {
                            b"rel" => {
                                if let Ok(value) = attribute.unescape_value() {
                                    is_enclosure = value.trim() == "enclosure";
                                    is_alternate = value.trim() == "alternate";
                                }
                            }
                            b"href" => {
                                if let Ok(value) = attribute.unescape_value() {
                                    href = Some(value.trim().to_string());
                                }
                            }
                            _ => {}
                        }
                    }
                    if is_enclosure && href.is_some() || is_alternate && item.url.is_none() {
                        item.url = href;
                    }
                }
                current = None;
            }
            Ok(event @ (Event::Text(_) | Event::CData(_))) => {
                if let Some(name) = &current {
                    let value = item_text(&event);
                    match name.as_str() {
                        "title" => item.title = value,
                        "id" => item.guid = value,
                        "published" | "updated" => item.published = value,
                        "summary" | "content" => item.description = value,
                        _ => {}
                    }
                }
                current = None;
            }
            Ok(Event::End(end)) => {
                if local_name(end.name().as_ref()) == "entry" {
                    let meaningful =
                        item.title.is_some() || item.url.is_some() || item.guid.is_some();
                    return if meaningful { Some(item) } else { None };
                }
                current = None;
            }
            Ok(Event::Eof) => return None,
            Err(_) => return None,
            _ => {}
        }
    }
}

#[cfg(test)]
mod chunked_reader {
    use std::io::Read;

    /// 以固定小块喂入，证明解析是真流式的。
    pub struct Chunked<'a> {
        data: &'a [u8],
        cursor: usize,
        chunk: usize,
    }

    impl<'a> Chunked<'a> {
        pub fn new(data: &'a [u8], chunk: usize) -> Self {
            Self {
                data,
                cursor: 0,
                chunk,
            }
        }
    }

    impl Read for Chunked<'_> {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            let remaining = &self.data[self.cursor..];
            let take = remaining.len().min(self.chunk).min(out.len());
            out[..take].copy_from_slice(&remaining[..take]);
            self.cursor += take;
            Ok(take)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::feed::chunked_reader::Chunked;
    use std::io::BufReader;

    const RSS: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title><![CDATA[Lucerna 订阅]]></title>
    <link>https://example.org/feed</link>
    <item>
      <title>三体 2023 S01E02 1080p</title>
      <link>https://example.org/items/1</link>
      <guid isPermaLink="false">lucerna-guid-1</guid>
      <pubDate>Tue, 24 Oct 2026 08:00:00 GMT</pubDate>
      <enclosure url="https://cdn.example.org/e02.mp4" length="1048576" type="video/mp4"/>
    </item>
    <item>
      <media:title>第二季 第一至第十二集</media:title>
      <link>https://example.org/items/2</link>
    </item>
    <item></item>
  </channel>
</rss>"#;

    const ATOM: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Lucerna Atom</title>
  <link href="https://example.org/atom"/>
  <entry>
    <title>沙丘 Part Two 1080p</title>
    <id>urn:uuid:1</id>
    <updated>2026-10-24T09:00:00Z</updated>
    <link rel="enclosure" type="video/mp4" href="https://cdn.example.org/dune.mp4"/>
    <summary>已完结</summary>
  </entry>
  <entry>
    <title>无链接条目</title>
    <id>urn:uuid:2</id>
  </entry>
</feed>"#;

    #[test]
    fn parses_rss_items_enclosures_and_skips_empty_items() {
        let feed = parse_feed_stream(BufReader::new(Chunked::new(RSS.as_bytes(), 7))).unwrap();
        assert_eq!(feed.kind, FeedKind::Rss);
        assert_eq!(feed.title.as_deref(), Some("Lucerna 订阅"));
        assert_eq!(feed.link.as_deref(), Some("https://example.org/feed"));
        assert_eq!(feed.skipped, 1); // 空 item
        assert_eq!(feed.items.len(), 2);
        assert_eq!(
            feed.items[0].title.as_deref(),
            Some("三体 2023 S01E02 1080p")
        );
        assert_eq!(
            feed.items[0].url.as_deref(),
            Some("https://cdn.example.org/e02.mp4")
        );
        assert_eq!(feed.items[0].size_bytes, Some(1_048_576));
        assert_eq!(feed.items[0].guid.as_deref(), Some("lucerna-guid-1"));
        // media: 前缀按本地名处理。
        assert_eq!(
            feed.items[1].title.as_deref(),
            Some("第二季 第一至第十二集")
        );
    }

    #[test]
    fn parses_atom_entries_with_enclosure_links() {
        let feed = parse_feed_stream(BufReader::new(Chunked::new(ATOM.as_bytes(), 5))).unwrap();
        assert_eq!(feed.kind, FeedKind::Atom);
        assert_eq!(feed.title.as_deref(), Some("Lucerna Atom"));
        assert_eq!(feed.items.len(), 2);
        assert_eq!(
            feed.items[0].url.as_deref(),
            Some("https://cdn.example.org/dune.mp4")
        );
        assert_eq!(feed.items[0].guid.as_deref(), Some("urn:uuid:1"));
        assert_eq!(feed.items[0].description.as_deref(), Some("已完结"));
        assert!(feed.items[1].url.is_none());
    }

    #[test]
    fn non_feed_input_is_rejected() {
        let error =
            parse_feed_stream(BufReader::new(Chunked::new(b"not xml at all", 4))).unwrap_err();
        assert_eq!(error.code, "FEED_FORMAT");
    }

    #[test]
    fn truncated_feed_is_rejected_instead_of_returning_partial_success() {
        let truncated = r#"<rss><channel><item><title>头部</title></item><item><title>未闭合"#;
        assert_eq!(parse_feed(truncated).unwrap_err().code, "FEED_XML");
    }
}
