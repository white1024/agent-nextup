use std::io::BufRead;

use crate::error::Result;

/// Walk a Server-Sent-Events byte stream and hand every non-empty `data:`
/// payload to `on_data`. `event:`/`id:`/comment/blank lines are skipped —
/// every provider we target puts the whole payload in `data:` fields.
/// Sentinel payloads (OpenAI's `[DONE]`) are passed through for the caller
/// to interpret.
pub fn for_each_sse_data<R: BufRead>(
    mut reader: R,
    on_data: &mut dyn FnMut(&str) -> Result<()>,
) -> Result<()> {
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            return Ok(());
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if let Some(data) = trimmed.strip_prefix("data:") {
            let data = data.strip_prefix(' ').unwrap_or(data);
            if !data.is_empty() {
                on_data(data)?;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn collect(input: &str) -> Vec<String> {
        let mut out = Vec::new();
        for_each_sse_data(Cursor::new(input), &mut |d| {
            out.push(d.to_string());
            Ok(())
        })
        .unwrap();
        out
    }

    #[test]
    fn extracts_data_lines_and_skips_the_rest() {
        let input = "event: message_start\ndata: {\"a\":1}\n\n: comment\nid: 7\ndata: {\"b\":2}\n\n";
        assert_eq!(collect(input), vec!["{\"a\":1}", "{\"b\":2}"]);
    }

    #[test]
    fn handles_crlf_and_missing_space() {
        let input = "data:{\"x\":1}\r\ndata: [DONE]\r\n";
        assert_eq!(collect(input), vec!["{\"x\":1}", "[DONE]"]);
    }

    #[test]
    fn empty_stream_is_ok() {
        assert!(collect("").is_empty());
    }

    #[test]
    fn callback_error_stops_iteration() {
        let mut n = 0;
        let err = for_each_sse_data(Cursor::new("data: a\ndata: b\n"), &mut |_| {
            n += 1;
            Err(crate::error::NextUpError::Provider("stop".into()))
        })
        .unwrap_err();
        assert_eq!(err.kind(), "provider");
        assert_eq!(n, 1);
    }
}
