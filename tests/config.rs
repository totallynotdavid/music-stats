use music_stats::config::{Config, load_from};
use std::collections::HashMap;

const LASTFM: [(&str, &str); 2] = [("LASTFM_API_KEY", "key"), ("LASTFM_USERNAME", "user")];

fn load(pairs: &[(&str, &str)]) -> Result<Config, String> {
    let env: HashMap<String, String> = pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    load_from(&env).map_err(|e| e.to_string())
}

fn with_lastfm<'a>(extra: &[(&'a str, &'a str)]) -> Vec<(&'a str, &'a str)> {
    let mut pairs = vec![("GIST_ID", "gist"), ("GH_TOKEN", "token")];
    pairs.extend(LASTFM);
    pairs.extend_from_slice(extra);
    pairs
}

#[test]
fn rejects_invalid_settings() {
    let cases = [
        (
            vec![("GH_TOKEN", "t"), ("YOUTUBE_COOKIE", "c")],
            "Missing required environment variable: GIST_ID",
        ),
        (
            vec![("GIST_ID", "g"), ("YOUTUBE_COOKIE", "c")],
            "Missing required environment variable: GH_TOKEN",
        ),
        (
            vec![("GIST_ID", "g"), ("GH_TOKEN", "t")],
            "No music providers",
        ),
        (
            with_lastfm(&[("DAYS", "0")]),
            "Invalid DAYS: must be greater than 0",
        ),
        (
            with_lastfm(&[("TOP_N", "0")]),
            "Invalid TOP_N: must be greater than 0",
        ),
        (with_lastfm(&[("DAYS", "not_a_number")]), "Invalid DAYS"),
    ];

    for (pairs, message) in cases {
        let error = load(&pairs).unwrap_err();

        assert!(error.contains(message), "{error:?} lacks {message:?}");
    }
}

#[test]
fn selects_providers_from_complete_settings() {
    let required = [("GIST_ID", "gist"), ("GH_TOKEN", "token")];
    let cases = [
        (LASTFM.to_vec(), true, false),
        (vec![("YOUTUBE_COOKIE", "cookie")], false, true),
        (
            vec![
                ("LASTFM_API_KEY", "key"),
                ("LASTFM_USERNAME", "user"),
                ("YOUTUBE_COOKIE", "cookie"),
            ],
            true,
            true,
        ),
        (
            vec![("LASTFM_API_KEY", "key"), ("YOUTUBE_COOKIE", "cookie")],
            false,
            true,
        ),
        (
            vec![
                ("LASTFM_API_KEY", "key"),
                ("LASTFM_USERNAME", "user"),
                ("YOUTUBE_COOKIE", "   "),
            ],
            true,
            false,
        ),
    ];

    for (providers, lastfm, youtube) in cases {
        let mut pairs = required.to_vec();
        pairs.extend_from_slice(&providers);

        let config = load(&pairs).unwrap();

        assert_eq!(config.provider.lastfm().is_some(), lastfm, "{providers:?}");
        assert_eq!(
            config.provider.youtube_cookie().is_some(),
            youtube,
            "{providers:?}"
        );
    }
}

#[test]
fn trims_whitespace_around_every_value() {
    let config = load(&[
        ("GIST_ID", " gist\n"),
        ("GH_TOKEN", "token\n"),
        ("LASTFM_API_KEY", "key "),
        ("LASTFM_USERNAME", " user"),
        ("YOUTUBE_COOKIE", "\tcookie \n"),
    ])
    .unwrap();

    let lastfm = config.provider.lastfm().unwrap();
    assert_eq!(
        (
            config.gist_id.as_str(),
            config.github_token.as_str(),
            lastfm.api_key.as_str(),
            lastfm.username.as_str(),
            config.provider.youtube_cookie().unwrap(),
        ),
        ("gist", "token", "key", "user", "cookie")
    );
}

#[test]
fn reads_days_and_top_n() {
    let cases = [
        (vec![], 7, 5),
        (vec![("DAYS", "30")], 30, 5),
        (vec![("TOP_N", "20")], 7, 20),
        (vec![("DAYS", ""), ("TOP_N", "  ")], 7, 5),
        (vec![("DAYS", " 30 ")], 30, 5),
    ];

    for (extra, days, top_n) in cases {
        let config = load(&with_lastfm(&extra)).unwrap();

        assert_eq!((config.days, config.top_n), (days, top_n), "{extra:?}");
    }
}
