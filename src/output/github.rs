use crate::errors::Error;
use serde::Serialize;
use std::collections::HashMap;

pub async fn upload_to_gist(
    gist_id: &str,
    github_token: &str,
    content: &str,
) -> Result<(), Error> {
    let client = crate::http::build_client();
    let url = format!("https://api.github.com/gists/{}", gist_id);
    let update_payload = build_gist_update(content);
    
    let http_response = client
        .patch(&url)
        .bearer_auth(github_token)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .json(&update_payload)
        .send()
        .await
        .map_err(|source| Error::Network {
            url: url.clone(),
            source,
        })?;
    
    if !http_response.status().is_success() {
        let status = http_response.status().as_u16();
        let body = http_response.text().await.unwrap_or_default();
        return Err(Error::GistUpdate {
            gist_id: gist_id.to_string(),
            status,
            body,
        });
    }
    
    Ok(())
}

fn build_gist_update(content: &str) -> GistUpdate {
    let mut files = HashMap::new();
    files.insert(
        "lastfm-recent-tracks".to_string(),
        GistFile {
            content: content.to_string(),
        },
    );
    
    GistUpdate {
        description: "What I've been listening to".to_string(),
        files,
    }
}

#[derive(Serialize)]
struct GistUpdate {
    description: String,
    files: HashMap<String, GistFile>,
}

#[derive(Serialize)]
struct GistFile {
    content: String,
}
