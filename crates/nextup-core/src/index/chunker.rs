use serde::{Deserialize, Serialize};

/// Code files: fixed windows with a small overlap so a match near a window
/// boundary still lands in one chunk with its context.
const WINDOW_LINES: usize = 64;
const WINDOW_OVERLAP: usize = 8;
/// Markdown sections larger than this fall back to windowing.
const MAX_SECTION_LINES: usize = 120;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chunk {
    /// 1-based inclusive line range in the source file.
    pub start_line: u32,
    pub end_line: u32,
    pub content: String,
}

/// Language-agnostic chunking (by line count and headings). Markdown splits
/// at headings so a search hit maps to a human-meaningful section; other
/// text uses overlapping line windows.
pub fn chunk_text(text: &str, is_markdown: bool) -> Vec<Chunk> {
    let lines: Vec<&str> = text.lines().collect();
    if is_markdown {
        chunk_markdown(&lines)
    } else {
        chunk_windows(&lines, 0)
    }
}

fn chunk_markdown(lines: &[&str]) -> Vec<Chunk> {
    let mut sections: Vec<(usize, usize)> = Vec::new(); // 0-based [start, end)
    let mut start = 0usize;
    for (i, line) in lines.iter().enumerate() {
        if i > start && line.starts_with('#') {
            sections.push((start, i));
            start = i;
        }
    }
    if start < lines.len() {
        sections.push((start, lines.len()));
    }

    let mut chunks = Vec::new();
    for (s, e) in sections {
        if e - s > MAX_SECTION_LINES {
            chunks.extend(chunk_windows(&lines[s..e], s));
        } else if let Some(c) = make_chunk(lines, s, e) {
            chunks.push(c);
        }
    }
    chunks
}

fn chunk_windows(lines: &[&str], base: usize) -> Vec<Chunk> {
    let mut chunks = Vec::new();
    let step = WINDOW_LINES - WINDOW_OVERLAP;
    let mut s = 0usize;
    while s < lines.len() {
        let e = (s + WINDOW_LINES).min(lines.len());
        if let Some(c) = make_chunk_rel(lines, s, e, base) {
            chunks.push(c);
        }
        if e == lines.len() {
            break;
        }
        s += step;
    }
    chunks
}

fn make_chunk(all: &[&str], s: usize, e: usize) -> Option<Chunk> {
    make_chunk_rel(&all[s..e], 0, e - s, s)
}

/// `lines` is a slice starting at source line `base` (0-based); s/e are
/// offsets within it. Whitespace-only chunks are dropped.
fn make_chunk_rel(lines: &[&str], s: usize, e: usize, base: usize) -> Option<Chunk> {
    let body = lines[s..e].join("\n");
    if body.trim().is_empty() {
        return None;
    }
    Some(Chunk {
        start_line: (base + s + 1) as u32,
        end_line: (base + e) as u32,
        content: body,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_splits_at_headings_with_line_ranges() {
        let text = "# Title\nintro\n\n## Second\nbody one\nbody two\n\n## Third\ntail\n";
        let chunks = chunk_text(text, true);
        assert_eq!(chunks.len(), 3);
        assert!(chunks[0].content.starts_with("# Title"));
        assert_eq!(chunks[0].start_line, 1);
        assert_eq!(chunks[1].start_line, 4);
        assert!(chunks[1].content.contains("body two"));
        assert_eq!(chunks[2].end_line, 9);
    }

    #[test]
    fn code_uses_overlapping_windows() {
        let lines: Vec<String> = (1..=150).map(|i| format!("line {i}")).collect();
        let chunks = chunk_text(&lines.join("\n"), false);
        // 150 lines, window 64, step 56 -> starts at 1, 57, 113.
        assert_eq!(chunks.len(), 3);
        assert_eq!((chunks[0].start_line, chunks[0].end_line), (1, 64));
        assert_eq!((chunks[1].start_line, chunks[1].end_line), (57, 120));
        assert_eq!((chunks[2].start_line, chunks[2].end_line), (113, 150));
        // Overlap keeps boundary context inside both windows.
        assert!(chunks[0].content.contains("line 60"));
        assert!(chunks[1].content.contains("line 60"));
    }

    #[test]
    fn whitespace_only_input_yields_nothing() {
        assert!(chunk_text("\n\n   \n", false).is_empty());
        assert!(chunk_text("", true).is_empty());
    }

    #[test]
    fn oversized_markdown_section_falls_back_to_windows() {
        let mut text = String::from("# big\n");
        for i in 0..200 {
            text.push_str(&format!("row {i}\n"));
        }
        let chunks = chunk_text(&text, true);
        assert!(chunks.len() > 1);
        assert_eq!(chunks[0].start_line, 1);
    }
}
