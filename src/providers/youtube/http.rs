use crate::errors::Error;
use regex::Regex;
use sha1::{Digest, Sha1};

pub async fn fetch_history_html(cookie: &str) -> Result<String, Error> {
    let sapisid = extract_sapisid(cookie)?;
    let auth_header = build_auth_header(&sapisid);
    let sanitized_cookie = sanitize_cookie(cookie);
    
    let client = crate::http::build_client();
    let http_response = client
        .get("https://music.youtube.com/history")
        .header("Cookie", sanitized_cookie)
        .header("Authorization", auth_header)
        .send()
        .await
        .map_err(|source| Error::Network {
            url: "youtube.com/history".to_string(),
            source,
        })?;
    
    if !http_response.status().is_success() {
        return Err(Error::YouTubeAuth {
            reason: format!("HTTP {}", http_response.status()),
        });
    }
    
    http_response.text().await.map_err(|error| {
        Error::YouTubeScraping {
            detail: format!("Failed to read response: {}", error),
        }
    })
}

pub fn extract_sapisid(cookie: &str) -> Result<String, Error> {
    let pattern = Regex::new(r"__Secure-3PAPISID=([^;]+)").unwrap();
    let captures = pattern.captures(cookie).ok_or_else(|| Error::YouTubeAuth {
        reason: "Cookie missing __Secure-3PAPISID".to_string(),
    })?;
    
    Ok(captures[1].to_string())
}

pub fn build_auth_header(sapisid: &str) -> String {
    let timestamp = chrono::Utc::now().timestamp();
    let hash_input = format!("{} {} https://music.youtube.com", timestamp, sapisid);
    let hash = sha1_hash(&hash_input);
    format!("SAPISIDHASH {}_{}", timestamp, hash)
}

fn sanitize_cookie(cookie: &str) -> String {
    let without_unicode = Regex::new(r"[\u{0100}-\u{FFFF}]")
        .unwrap()
        .replace_all(cookie, "");
    
    let normalized = Regex::new(r"\s+")
        .unwrap()
        .replace_all(&without_unicode, " ");
    
    let trimmed = normalized.trim();
    
    if trimmed.contains("SOCS=") {
        trimmed.to_string()
    } else {
        format!("{}; SOCS=CAI", trimmed)
    }
}

fn sha1_hash(input: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(input.as_bytes());
    format!("{:x}", hasher.finalize())
}
