//! Reading the lists YouTube's own site is built from: keyword search results, a channel's Videos
//! tab, a playlist. None of this needs an API key; it's the same data the website shows an anonymous
//! visitor, and (unlike the first page alone) it carries a continuation token, so a caller can keep
//! asking for the next page.
//!
//! YouTube serves the same kind of item in several shapes depending on the list and on which layout
//! it is rolling out (`videoRenderer`, `playlistVideoRenderer`, the newer `lockupViewModel`,
//! sometimes wrapped in a `richItemRenderer`), and a page's items are found in different places for
//! a first page and a continuation. Everything here is written to accept all of them, and to skip
//! whatever it doesn't recognize (Shorts shelves, ads, playlists) rather than fail.

use serde_json::Value;

use super::client::{extract_lockup_video_info, extract_playlist_video_info, extract_video_basic_info, is_live_or_upcoming};

/// One page of a list: its videos (as the JSON the UI's `Video` type reads) and, when there's more,
/// the token that asks for the next page.
#[derive(Debug, Default)]
pub struct Page {
    pub videos: Vec<Value>,
    pub continuation: Option<String>,
}

/// YouTube's own "Videos" tab of a channel, as the `params` of a browse request for the channel.
pub const CHANNEL_VIDEOS_TAB: &str = "EgZ2aWRlb3PyBgQKAjoA";

fn continuation_token(item: &Value) -> Option<String> {
    item["continuationItemRenderer"]["continuationEndpoint"]["continuationCommand"]["token"]
        .as_str()
        .map(str::to_string)
}

/// A finished, published video from any of the item shapes, or `None` for anything else (including
/// a stream that's live now or scheduled, which isn't a video yet).
fn video_from_item(item: &Value) -> Option<Value> {
    // A channel's grid wraps each item.
    let item = if item.get("richItemRenderer").is_some() { &item["richItemRenderer"]["content"] } else { item };
    if let Some(r) = item.get("videoRenderer") {
        return if is_live_or_upcoming(r) { None } else { extract_video_basic_info(r) };
    }
    if let Some(r) = item.get("playlistVideoRenderer") {
        return if is_live_or_upcoming(r) { None } else { extract_playlist_video_info(r) };
    }
    if let Some(l) = item.get("lockupViewModel") {
        return if is_live_or_upcoming(l) { None } else { extract_lockup_video_info(l) };
    }
    None
}

/// Reads a list of items, following the wrappers YouTube nests them in, collecting videos and the
/// continuation token (which sits in the list next to the items).
fn collect(items: &[Value], page: &mut Page) {
    for item in items {
        if let Some(token) = continuation_token(item) {
            page.continuation = Some(token);
        } else if let Some(inner) = item["itemSectionRenderer"]["contents"].as_array() {
            collect(inner, page);
        } else if let Some(inner) = item["playlistVideoListRenderer"]["contents"].as_array() {
            collect(inner, page);
        } else if let Some(v) = video_from_item(item) {
            page.videos.push(v);
        }
    }
}

/// The item lists in a continuation response (the same for search and browse).
fn continuation_lists(data: &Value) -> impl Iterator<Item = &Vec<Value>> {
    ["onResponseReceivedActions", "onResponseReceivedCommands"]
        .into_iter()
        .filter_map(|key| data[key].as_array())
        .flatten()
        .filter_map(|action| action["appendContinuationItemsAction"]["continuationItems"].as_array())
}

/// A page of keyword search results: the first page, or one asked for with a continuation token.
pub fn parse_search_page(data: &Value) -> Page {
    let mut page = Page::default();
    if let Some(sections) = data["contents"]["twoColumnSearchResultsRenderer"]["primaryContents"]["sectionListRenderer"]["contents"].as_array() {
        collect(sections, &mut page);
    }
    for list in continuation_lists(data) {
        collect(list, &mut page);
    }
    page
}

/// A page of a channel's Videos tab or of a playlist, first page or continuation.
pub fn parse_browse_page(data: &Value) -> Page {
    let mut page = Page::default();
    if let Some(tabs) = data["contents"]["twoColumnBrowseResultsRenderer"]["tabs"].as_array() {
        for tab in tabs {
            let content = &tab["tabRenderer"]["content"];
            if let Some(items) = content["richGridRenderer"]["contents"].as_array() {
                collect(items, &mut page);
            }
            if let Some(sections) = content["sectionListRenderer"]["contents"].as_array() {
                collect(sections, &mut page);
            }
        }
    }
    for list in continuation_lists(data) {
        collect(list, &mut page);
    }
    page
}

/// A message for a response YouTube sent back as an error (or as nothing usable), so the person sees
/// why nothing came back rather than an empty list.
pub fn response_problem(data: &Value) -> Option<String> {
    if let Some(msg) = data["error"]["message"].as_str() {
        return Some(format!("YouTube returned an error: {msg}"));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Shapes trimmed from real responses (a search for "freebird", a channel's Videos tab and its
    // uploads playlist), with the huge fields (tracking params, menus, thumbnails) left out.

    fn video_renderer(id: &str, title: &str) -> Value {
        json!({"videoRenderer": {
            "videoId": id,
            "title": {"runs": [{"text": title}]},
            "thumbnail": {"thumbnails": [{"url": "https://i.ytimg.com/vi/x/hq.jpg"}]},
            "lengthText": {"simpleText": "9:11"},
            "viewCountText": {"simpleText": "80,197,928 views"},
            "publishedTimeText": {"simpleText": "3 years ago"},
            "ownerText": {"runs": [{"text": "Lynyrd Skynyrd"}]},
            "thumbnailOverlays": [{"thumbnailOverlayTimeStatusRenderer": {"style": "DEFAULT"}}]
        }})
    }

    fn lockup(id: &str, title: &str, length: &str) -> Value {
        json!({"lockupViewModel": {
            "contentType": "LOCKUP_CONTENT_TYPE_VIDEO",
            "contentId": id,
            "contentImage": {"thumbnailViewModel": {
                "image": {"sources": [{"url": "https://i.ytimg.com/vi/x/hq720.jpg"}]},
                "overlays": [{"thumbnailBottomOverlayViewModel": {"badges": [
                    {"thumbnailBadgeViewModel": {"text": length, "badgeStyle": "THUMBNAIL_OVERLAY_BADGE_STYLE_DEFAULT"}}
                ]}}]
            }},
            "metadata": {"lockupMetadataViewModel": {"title": {"content": title}, "metadata": {"contentMetadataViewModel": {"metadataRows": [
                {"metadataParts": [{"text": {"content": "Marques Brownlee"}}]},
                {"metadataParts": [{"text": {"content": "2.4M views"}}, {"text": {"content": "2 days ago"}}]}
            ]}}}}
        }})
    }

    fn continuation(token: &str) -> Value {
        json!({"continuationItemRenderer": {"continuationEndpoint": {"continuationCommand": {"token": token}}}})
    }

    #[test]
    fn a_first_page_of_search_results_yields_its_videos_and_the_next_page_token() {
        let data = json!({"contents": {"twoColumnSearchResultsRenderer": {"primaryContents": {"sectionListRenderer": {"contents": [
            {"itemSectionRenderer": {"contents": [
                video_renderer("a1", "Lynyrd Skynyrd - Free Bird (Audio)"),
                // A shelf of Shorts and a playlist: not videos to list.
                {"gridShelfViewModel": {"contents": [{"shortsLockupViewModel": {"entityId": "shorts-shelf-item-x"}}]}},
                {"lockupViewModel": {"contentType": "LOCKUP_CONTENT_TYPE_PLAYLIST", "contentId": "PLxyz"}},
                video_renderer("a2", "Free Bird solo"),
            ]}},
            continuation("NEXT-PAGE"),
        ]}}}}});
        let page = parse_search_page(&data);
        let ids: Vec<&str> = page.videos.iter().map(|v| v["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["a1", "a2"]);
        assert_eq!(page.continuation.as_deref(), Some("NEXT-PAGE"));
        // Length, views and date come along, so the list can hide Shorts and sort without a key.
        assert_eq!(page.videos[0]["lengthSeconds"], 551);
        assert_eq!(page.videos[0]["viewCount"], "80,197,928 views");
    }

    #[test]
    fn a_continuation_page_of_search_results_is_read_from_the_append_action() {
        let data = json!({"onResponseReceivedCommands": [{"appendContinuationItemsAction": {"continuationItems": [
            {"itemSectionRenderer": {"contents": [video_renderer("b1", "More"), video_renderer("b2", "Even more")]}},
            continuation("PAGE-3"),
        ]}}]});
        let page = parse_search_page(&data);
        assert_eq!(page.videos.len(), 2);
        assert_eq!(page.continuation.as_deref(), Some("PAGE-3"));
    }

    #[test]
    fn the_last_page_has_no_token() {
        let data = json!({"onResponseReceivedCommands": [{"appendContinuationItemsAction": {"continuationItems": [
            {"itemSectionRenderer": {"contents": [video_renderer("z", "Last")]}},
        ]}}]});
        assert_eq!(parse_search_page(&data).continuation, None);
    }

    #[test]
    fn a_channels_videos_tab_reads_wrapped_items_and_paginates() {
        let first = json!({"contents": {"twoColumnBrowseResultsRenderer": {"tabs": [{"tabRenderer": {"selected": true, "title": "Videos", "content": {"richGridRenderer": {"contents": [
            {"richItemRenderer": {"content": lockup("c1", "New phone review", "16:36")}},
            {"richItemRenderer": {"content": lockup("c2", "Studio tour", "1:02:03")}},
            continuation("TAB-2"),
        ]}}}}]}}});
        let page = parse_browse_page(&first);
        assert_eq!(page.videos.iter().map(|v| v["id"].as_str().unwrap()).collect::<Vec<_>>(), vec!["c1", "c2"]);
        assert_eq!(page.videos[0]["lengthSeconds"], 16 * 60 + 36);
        assert_eq!(page.videos[1]["lengthSeconds"], 3723);
        assert_eq!(page.continuation.as_deref(), Some("TAB-2"));

        let next = json!({"onResponseReceivedActions": [{"appendContinuationItemsAction": {"continuationItems": [
            {"richItemRenderer": {"content": lockup("c3", "Older video", "8:00")}},
            continuation("TAB-3"),
        ]}}]});
        let page = parse_browse_page(&next);
        assert_eq!(page.videos.len(), 1);
        assert_eq!(page.continuation.as_deref(), Some("TAB-3"));
    }

    #[test]
    fn a_playlist_in_either_layout_is_read() {
        // Older: a playlistVideoListRenderer inside an item section.
        let old = json!({"contents": {"twoColumnBrowseResultsRenderer": {"tabs": [{"tabRenderer": {"content": {"sectionListRenderer": {"contents": [
            {"itemSectionRenderer": {"contents": [{"playlistVideoListRenderer": {"contents": [
                {"playlistVideoRenderer": {
                    "videoId": "p1", "title": {"runs": [{"text": "Track one"}]},
                    "thumbnail": {"thumbnails": [{"url": "u"}]}, "lengthSeconds": "245",
                    "shortBylineText": {"runs": [{"text": "Some Channel"}]}
                }},
                continuation("PL-2"),
            ]}}]}}
        ]}}}}]}}});
        let page = parse_browse_page(&old);
        assert_eq!(page.videos.len(), 1);
        assert_eq!(page.videos[0]["lengthSeconds"], 245);
        assert_eq!(page.continuation.as_deref(), Some("PL-2"));

        // Newer: lockups straight in the section, with the token next to them.
        let new = json!({"contents": {"twoColumnBrowseResultsRenderer": {"tabs": [{"tabRenderer": {"content": {"sectionListRenderer": {"contents": [
            {"itemSectionRenderer": {"contents": [lockup("p2", "Two", "3:00"), continuation("PL-3")]}}
        ]}}}}]}}});
        let page = parse_browse_page(&new);
        assert_eq!(page.videos.len(), 1);
        assert_eq!(page.continuation.as_deref(), Some("PL-3"));
    }

    #[test]
    fn live_and_scheduled_streams_are_left_out() {
        let data = json!({"contents": {"twoColumnSearchResultsRenderer": {"primaryContents": {"sectionListRenderer": {"contents": [
            {"itemSectionRenderer": {"contents": [
                {"videoRenderer": {"videoId": "live", "title": {"runs": [{"text": "LIVE now"}]},
                    "thumbnailOverlays": [{"thumbnailOverlayTimeStatusRenderer": {"style": "LIVE"}}]}},
                video_renderer("ok", "A normal video"),
            ]}}
        ]}}}}});
        let ids: Vec<String> = parse_search_page(&data).videos.iter().map(|v| v["id"].as_str().unwrap().to_string()).collect();
        assert_eq!(ids, vec!["ok"]);
    }

    #[test]
    fn junk_and_errors_produce_an_empty_page_and_a_reason() {
        assert!(parse_search_page(&json!({})).videos.is_empty());
        assert!(parse_browse_page(&json!({"contents": 5})).videos.is_empty());
        let err = json!({"error": {"code": 500, "message": "Internal error encountered."}});
        assert_eq!(response_problem(&err).as_deref(), Some("YouTube returned an error: Internal error encountered."));
        assert_eq!(response_problem(&json!({"contents": {}})), None);
    }

    /// Not a check that runs by default: `cargo test --lib live_ -- --ignored --nocapture` asks YouTube.
    #[tokio::test]
    #[ignore]
    async fn live_keyless_search_channel_and_pagination() {
        use crate::youtube::{ClientType, YouTubeClient};
        let client = YouTubeClient::new(ClientType::Web);

        let first = parse_search_page(&client.search("freebird", None).await.unwrap());
        println!("search page 1: {} videos, next={}", first.videos.len(), first.continuation.is_some());
        assert!(first.videos.len() >= 10, "expected a full first page");
        assert!(first.videos.iter().all(|v| v["lengthSeconds"].is_number()), "every result has a length");
        let second = parse_search_page(&client.search("freebird", first.continuation.as_deref()).await.unwrap());
        println!("search page 2: {} videos, next={}", second.videos.len(), second.continuation.is_some());
        assert!(!second.videos.is_empty());
        let firsts: std::collections::HashSet<&str> = first.videos.iter().map(|v| v["id"].as_str().unwrap()).collect();
        assert!(second.videos.iter().any(|v| !firsts.contains(v["id"].as_str().unwrap())), "page 2 has new videos");

        let channel = crate::youtube::extract_channel_id("@mkbhd").await.unwrap().expect("channel id");
        let mut page = parse_browse_page(&client.browse_tab(&channel, CHANNEL_VIDEOS_TAB).await.unwrap());
        let mut total = page.videos.len();
        println!("channel page 1: {} videos", total);
        assert!(total >= 20);
        for n in 2..=8 {
            let Some(token) = page.continuation.clone() else { break };
            page = parse_browse_page(&client.browse_continuation(&token).await.unwrap());
            total += page.videos.len();
            println!("channel page {n}: {} videos (total {total})", page.videos.len());
        }
        assert!(total > 200, "the Videos tab goes past 200 videos, got {total}");
    }
}
