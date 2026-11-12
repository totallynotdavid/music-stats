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
    let gist = config.gist.as_ref().unwrap();
    assert_eq!(
        (
            gist.id.as_str(),
            gist.token.as_str(),
            lastfm.api_key.as_str(),
            lastfm.username.as_str(),
            config.provider.youtube_cookie().unwrap(),
        ),
        ("gist", "token", "key", "user", "cookie")
    );
}

#[test]
fn needs_at_least_one_output() {
    let cases = [
        (vec![("YOUTUBE_COOKIE", "c")], Some("No output configured")),
        (
            vec![("YOUTUBE_COOKIE", "c"), ("GIST_ID", "g"), ("GH_TOKEN", "t")],
            None,
        ),
        (
            vec![("YOUTUBE_COOKIE", "c"), ("UPLOAD_TOKEN", "msu_t")],
            None,
        ),
        (
            vec![("YOUTUBE_COOKIE", "c"), ("UPLOAD_TOKEN", "  ")],
            Some("No output configured"),
        ),
    ];

    for (pairs, message) in cases {
        match (load(&pairs), message) {
            (Ok(_), None) => {}
            (Err(error), Some(message)) => {
                assert!(error.contains(message), "{error:?} lacks {message:?}")
            }
            (other, _) => panic!("{pairs:?}: {other:?}"),
        }
    }
}

#[test]
fn the_gist_needs_both_its_settings() {
    let cases = [
        (
            ("GIST_ID", "g"),
            "Missing required environment variable: GH_TOKEN",
        ),
        (
            ("GH_TOKEN", "t"),
            "Missing required environment variable: GIST_ID",
        ),
    ];

    for (setting, message) in cases {
        let error =
            load(&[setting, ("YOUTUBE_COOKIE", "c"), ("UPLOAD_TOKEN", "msu_t")]).unwrap_err();

        assert!(error.contains(message), "{error:?} lacks {message:?}");
    }
}

#[test]
fn the_upload_defaults_to_the_hosted_service() {
    let base = [("YOUTUBE_COOKIE", "c"), ("UPLOAD_TOKEN", " msu_t\n")];
    let cases = [
        (vec![], "https://music.rising.sh"),
        (vec![("UPLOAD_URL", "")], "https://music.rising.sh"),
        (
            vec![("UPLOAD_URL", " http://127.0.0.1:8787 ")],
            "http://127.0.0.1:8787",
        ),
    ];

    for (extra, url) in cases {
        let mut pairs = base.to_vec();
        pairs.extend_from_slice(&extra);

        let upload = load(&pairs).unwrap().upload.unwrap();

        assert_eq!((upload.url.as_str(), upload.token.as_str()), (url, "msu_t"));
    }
}

#[test]
fn the_upload_needs_the_youtube_cookie() {
    let error = load(&[
        ("UPLOAD_TOKEN", "msu_t"),
        ("GIST_ID", "g"),
        ("GH_TOKEN", "t"),
    ])
    .unwrap_err();
    assert!(error.contains("No music providers"), "{error}");

    let mut pairs = with_lastfm(&[]);
    pairs.push(("UPLOAD_TOKEN", "msu_t"));
    let error = load(&pairs).unwrap_err();
    assert!(
        error.contains("Invalid UPLOAD_TOKEN") && error.contains("YOUTUBE_COOKIE"),
        "{error}"
    );
}

#[test]
fn reads_the_time_zone() {
    let cases = [
        (vec![], Ok("UTC")),
        (vec![("MUSIC_STATS_TZ", "  ")], Ok("UTC")),
        (
            vec![("MUSIC_STATS_TZ", " America/Lima ")],
            Ok("America/Lima"),
        ),
        (vec![("MUSIC_STATS_TZ", "Asia/Tokyo")], Ok("Asia/Tokyo")),
        (
            vec![("MUSIC_STATS_TZ", "Lima")],
            Err("Invalid MUSIC_STATS_TZ"),
        ),
    ];

    for (extra, expected) in cases {
        match (load(&with_lastfm(&extra)), expected) {
            (Ok(config), Ok(name)) => assert_eq!(config.timezone.name(), name, "{extra:?}"),
            (Err(error), Err(message)) => {
                assert!(error.contains(message), "{error:?} lacks {message:?}")
            }
            (other, _) => panic!("{extra:?}: {other:?}"),
        }
    }
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
