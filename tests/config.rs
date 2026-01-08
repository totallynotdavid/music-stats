use music_stats::config::load;
use std::env;

fn clear_env() {
    unsafe {
        env::remove_var("GIST_ID");
        env::remove_var("GH_TOKEN");
        env::remove_var("LASTFM_API_KEY");
        env::remove_var("LASTFM_USERNAME");
        env::remove_var("YOUTUBE_COOKIE");
        env::remove_var("DAYS");
        env::remove_var("TOP_N");
    }
}

fn set_required_env() {
    unsafe {
        env::set_var("GIST_ID", "test_gist_id");
        env::set_var("GH_TOKEN", "test_token");
    }
}

#[test]
fn fails_without_gist_id() {
    clear_env();
    unsafe {
        env::set_var("GH_TOKEN", "token");
        env::set_var("LASTFM_API_KEY", "key");
        env::set_var("LASTFM_USERNAME", "user");
    }

    let result = load();
    assert!(result.is_err());
    assert!(format!("{}", result.unwrap_err()).contains("GIST_ID"));
}

#[test]
fn fails_without_github_token() {
    clear_env();
    unsafe {
        env::set_var("GIST_ID", "gist");
        env::set_var("LASTFM_API_KEY", "key");
        env::set_var("LASTFM_USERNAME", "user");
    }

    let result = load();
    assert!(result.is_err());
    assert!(format!("{}", result.unwrap_err()).contains("GH_TOKEN"));
}

#[test]
fn fails_without_any_provider() {
    clear_env();
    set_required_env();

    let result = load();
    assert!(result.is_err());
    assert!(format!("{}", result.unwrap_err()).contains("No music providers"));
}

#[test]
fn loads_with_lastfm_provider() {
    clear_env();
    set_required_env();
    unsafe {
        env::set_var("LASTFM_API_KEY", "key");
        env::set_var("LASTFM_USERNAME", "user");
    }

    let result = load();
    assert!(result.is_ok());

    let config = result.unwrap();
    assert!(config.provider.lastfm().is_some());
    assert!(config.provider.youtube_cookie().is_none());
}

#[test]
fn loads_with_youtube_provider() {
    clear_env();
    set_required_env();
    unsafe {
        env::set_var("YOUTUBE_COOKIE", "cookie_data");
    }

    let result = load();
    assert!(result.is_ok());

    let config = result.unwrap();
    assert!(config.provider.lastfm().is_none());
    assert!(config.provider.youtube_cookie().is_some());
}

#[test]
fn loads_with_both_providers() {
    clear_env();
    set_required_env();
    unsafe {
        env::set_var("LASTFM_API_KEY", "key");
        env::set_var("LASTFM_USERNAME", "user");
        env::set_var("YOUTUBE_COOKIE", "cookie");
    }

    let result = load();
    assert!(result.is_ok());

    let config = result.unwrap();
    assert!(config.provider.lastfm().is_some());
    assert!(config.provider.youtube_cookie().is_some());
}

#[test]
fn uses_default_days() {
    clear_env();
    set_required_env();
    unsafe {
        env::set_var("LASTFM_API_KEY", "key");
        env::set_var("LASTFM_USERNAME", "user");
    }

    let config = load().unwrap();
    assert_eq!(config.days, 7);
}

#[test]
fn uses_default_top_n() {
    clear_env();
    set_required_env();
    unsafe {
        env::set_var("LASTFM_API_KEY", "key");
        env::set_var("LASTFM_USERNAME", "user");
    }

    let config = load().unwrap();
    assert_eq!(config.top_n, 5);
}

#[test]
fn parses_custom_days() {
    clear_env();
    set_required_env();
    unsafe {
        env::set_var("LASTFM_API_KEY", "key");
        env::set_var("LASTFM_USERNAME", "user");
        env::set_var("DAYS", "30");
    }

    let config = load().unwrap();
    assert_eq!(config.days, 30);
}

#[test]
fn parses_custom_top_n() {
    clear_env();
    set_required_env();
    unsafe {
        env::set_var("LASTFM_API_KEY", "key");
        env::set_var("LASTFM_USERNAME", "user");
        env::set_var("TOP_N", "20");
    }

    let config = load().unwrap();
    assert_eq!(config.top_n, 20);
}

#[test]
fn fails_with_zero_days() {
    clear_env();
    set_required_env();
    unsafe {
        env::set_var("LASTFM_API_KEY", "key");
        env::set_var("LASTFM_USERNAME", "user");
        env::set_var("DAYS", "0");
    }

    let result = load();
    assert!(result.is_err());
    assert!(format!("{}", result.unwrap_err()).contains("DAYS"));
}

#[test]
fn fails_with_zero_top_n() {
    clear_env();
    set_required_env();
    unsafe {
        env::set_var("LASTFM_API_KEY", "key");
        env::set_var("LASTFM_USERNAME", "user");
        env::set_var("TOP_N", "0");
    }

    let result = load();
    assert!(result.is_err());
    assert!(format!("{}", result.unwrap_err()).contains("TOP_N"));
}

#[test]
fn fails_with_invalid_days_format() {
    clear_env();
    set_required_env();
    unsafe {
        env::set_var("LASTFM_API_KEY", "key");
        env::set_var("LASTFM_USERNAME", "user");
        env::set_var("DAYS", "not_a_number");
    }

    let result = load();
    assert!(result.is_err());
}

#[test]
fn ignores_empty_string_values() {
    clear_env();
    set_required_env();
    unsafe {
        env::set_var("LASTFM_API_KEY", "key");
        env::set_var("LASTFM_USERNAME", "user");
        env::set_var("YOUTUBE_COOKIE", "   ");
    }

    let config = load().unwrap();
    assert!(config.provider.youtube_cookie().is_none());
}

#[test]
fn ignores_partial_lastfm_config() {
    clear_env();
    set_required_env();
    unsafe {
        env::set_var("LASTFM_API_KEY", "key");
        env::set_var("YOUTUBE_COOKIE", "cookie");
    }

    let config = load().unwrap();
    assert!(config.provider.lastfm().is_none());
    assert!(config.provider.youtube_cookie().is_some());
}
