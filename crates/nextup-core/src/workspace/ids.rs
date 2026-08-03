//! Sequential id allocation shared by every `PREFIX-0001`-style id family
//! (tasks `T-`, milestones `M-`, lessons `L-`). One rule, one place: the next
//! id is always max(existing) + 1, so ids never recycle even after deletions.
//!
//! Cross-workspace identifiers (workspace identity, teams, delivery
//! envelopes — D48) live here too as [`uuid_v4`]: sequential families are
//! only unique inside one workspace (every workspace has a T-0001), so
//! anything that flows between workspaces needs global uniqueness.

/// Allocate the next id for `prefix` (e.g. `"T-"`) given every existing id
/// (or file stem) in the family. Non-matching entries are ignored.
pub fn next_seq_id<'a>(prefix: &str, existing: impl IntoIterator<Item = &'a str>) -> String {
    let max = existing
        .into_iter()
        .filter_map(|id| id.strip_prefix(prefix))
        .filter_map(|digits| digits.parse::<u32>().ok())
        .max()
        .unwrap_or(0);
    format!("{prefix}{:04}", max + 1)
}

/// Shared slug rule for ids that become file or directory names — custom
/// template ids (D43) and spec capability names (D79). One rule, one place:
/// lowercase keeps hand-typed ids portable across the case-insensitive
/// filesystems Windows/macOS default to (01 invariant 13).
pub const SLUG_RULE: &str =
    "1-64 chars of lowercase letters, digits, '-' or '_', starting with a letter or digit";

/// True if `id` satisfies [`SLUG_RULE`].
pub fn is_valid_slug(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// Random version-4 UUID (lowercase hyphenated hex), generated from the
/// crate's existing `rand` dependency — no uuid crate needed for one format.
pub fn uuid_v4() -> String {
    use rand::RngCore;
    let mut b = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
    let hex: Vec<String> = b.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        hex[0..4].join(""),
        hex[4..6].join(""),
        hex[6..8].join(""),
        hex[8..10].join(""),
        hex[10..16].join("")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allocates_from_max_never_recycling() {
        assert_eq!(next_seq_id("T-", []), "T-0001");
        assert_eq!(next_seq_id("T-", ["T-0001", "T-0007", "T-0003"]), "T-0008");
        // Gaps (deletions) do not get refilled.
        assert_eq!(next_seq_id("M-", ["M-0002"]), "M-0003");
        // Foreign or malformed ids are ignored.
        assert_eq!(next_seq_id("L-", ["T-0009", "L-x", "L-0004"]), "L-0005");
    }

    #[test]
    fn uuid_v4_has_rfc_shape_and_is_unique() {
        let a = uuid_v4();
        let b = uuid_v4();
        assert_ne!(a, b);
        assert_eq!(a.len(), 36);
        let groups: Vec<usize> = a.split('-').map(str::len).collect();
        assert_eq!(groups, vec![8, 4, 4, 4, 12]);
        assert!(a.chars().all(|c| c == '-' || c.is_ascii_hexdigit()));
        assert_eq!(&a[14..15], "4", "version nibble");
        assert!(matches!(&a[19..20], "8" | "9" | "a" | "b"), "variant nibble");
    }
}
