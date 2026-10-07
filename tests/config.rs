use music_stats::config::load_from;
use std::collections::HashMap;

fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

fn required() -> Vec<(&'static str, &'static str)> {
    vec![("GIST_ID", "test_gist_id"), ("GH_TOKEN", "test_token")]
}

fn with_required(extra: &[(&str, &str)]) -> HashMap<String, String> {
    let mut pairs = required();
    pairs.extend_from_slice(extra);
    env(&pairs)
}

#[test]
fn fails_without_gist_id() {
    let env = env(&[
        ("GH_TOKEN", "token"),
        ("LASTFM_API_KEY", "key"),
        ("LASTFM_USERNAME", "user"),
    ]);

    let result = load_from(&env);
    assert!(result.is_err());
    assert!(format!("{}", result.unwrap_err()).contains("GIST_ID"));
}

#[test]
fn fails_without_github_token() {
    let env = env(&[
        ("GIST_ID", "gist"),
        ("LASTFM_API_KEY", "key"),
        ("LASTFM_USERNAME", "user"),
    ]);

    let result = load_from(&env);
    assert!(result.is_err());
    assert!(format!("{}", result.unwrap_err()).contains("GH_TOKEN"));
}

#[test]
fn fails_without_any_provider() {
    let env = with_required(&[]);

    let result = load_from(&env);
    assert!(result.is_err());
    assert!(format!("{}", result.unwrap_err()).contains("No music providers"));
}

#[test]
fn loads_with_lastfm_provider() {
    let env = with_required(&[("LASTFM_API_KEY", "key"), ("LASTFM_USERNAME", "user")]);

    let result = load_from(&env);
    assert!(result.is_ok());

    let config = result.unwrap();
    assert!(config.provider.lastfm().is_some());
    assert!(config.provider.youtube_cookie().is_none());
}

#[test]
fn loads_with_youtube_provider() {
    let env = with_required(&[("YOUTUBE_COOKIE", "cookie_data")]);

    let result = load_from(&env);
    assert!(result.is_ok());

    let config = result.unwrap();
    assert!(config.provider.lastfm().is_none());
    assert!(config.provider.youtube_cookie().is_some());
}

#[test]
fn loads_with_both_providers() {
    let env = with_required(&[
        ("LASTFM_API_KEY", "key"),
        ("LASTFM_USERNAME", "user"),
        ("YOUTUBE_COOKIE", "cookie"),
    ]);

    let result = load_from(&env);
    assert!(result.is_ok());

    let config = result.unwrap();
    assert!(config.provider.lastfm().is_some());
    assert!(config.provider.youtube_cookie().is_some());
}

#[test]
fn uses_default_days() {
    let env = with_required(&[("LASTFM_API_KEY", "key"), ("LASTFM_USERNAME", "user")]);

    let config = load_from(&env).unwrap();
    assert_eq!(config.days, 7);
}

#[test]
fn uses_default_top_n() {
    let env = with_required(&[("LASTFM_API_KEY", "key"), ("LASTFM_USERNAME", "user")]);

    let config = load_from(&env).unwrap();
    assert_eq!(config.top_n, 5);
}

#[test]
fn parses_custom_days() {
    let env = with_required(&[
        ("LASTFM_API_KEY", "key"),
        ("LASTFM_USERNAME", "user"),
        ("DAYS", "30"),
    ]);

    let config = load_from(&env).unwrap();
    assert_eq!(config.days, 30);
}

#[test]
fn parses_custom_top_n() {
    let env = with_required(&[
        ("LASTFM_API_KEY", "key"),
        ("LASTFM_USERNAME", "user"),
        ("TOP_N", "20"),
    ]);

    let config = load_from(&env).unwrap();
    assert_eq!(config.top_n, 20);
}

#[test]
fn fails_with_zero_days() {
    let env = with_required(&[
        ("LASTFM_API_KEY", "key"),
        ("LASTFM_USERNAME", "user"),
        ("DAYS", "0"),
    ]);

    let result = load_from(&env);
    assert!(result.is_err());
    assert!(format!("{}", result.unwrap_err()).contains("DAYS"));
}

#[test]
fn fails_with_zero_top_n() {
    let env = with_required(&[
        ("LASTFM_API_KEY", "key"),
        ("LASTFM_USERNAME", "user"),
        ("TOP_N", "0"),
    ]);

    let result = load_from(&env);
    assert!(result.is_err());
    assert!(format!("{}", result.unwrap_err()).contains("TOP_N"));
}

#[test]
fn fails_with_invalid_days_format() {
    let env = with_required(&[
        ("LASTFM_API_KEY", "key"),
        ("LASTFM_USERNAME", "user"),
        ("DAYS", "not_a_number"),
    ]);

    let result = load_from(&env);
    assert!(result.is_err());
}

#[test]
fn ignores_empty_string_values() {
    let env = with_required(&[
        ("LASTFM_API_KEY", "key"),
        ("LASTFM_USERNAME", "user"),
        ("YOUTUBE_COOKIE", "   "),
    ]);

    let config = load_from(&env).unwrap();
    assert!(config.provider.youtube_cookie().is_none());
}

#[test]
fn ignores_partial_lastfm_config() {
    let env = with_required(&[("LASTFM_API_KEY", "key"), ("YOUTUBE_COOKIE", "cookie")]);

    let config = load_from(&env).unwrap();
    assert!(config.provider.lastfm().is_none());
    assert!(config.provider.youtube_cookie().is_some());
}

#[test]
fn blank_days_and_top_n_use_defaults() {
    let env = with_required(&[
        ("LASTFM_API_KEY", "key"),
        ("LASTFM_USERNAME", "user"),
        ("DAYS", ""),
        ("TOP_N", "  "),
    ]);

    let config = load_from(&env).unwrap();
    assert_eq!(config.days, 7);
    assert_eq!(config.top_n, 5);
}

#[test]
fn parses_days_with_surrounding_whitespace() {
    let env = with_required(&[
        ("LASTFM_API_KEY", "key"),
        ("LASTFM_USERNAME", "user"),
        ("DAYS", " 30 "),
    ]);

    assert_eq!(load_from(&env).unwrap().days, 30);
}
