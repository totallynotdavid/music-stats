use crate::errors::Error;
use serde::Serialize;
use std::collections::HashMap;

const GIST_FILENAME: &str = "lastfm-recent-tracks";
const GIST_DESCRIPTION: &str = "What I've been listening to";

pub async fn upload_gist(
    client: &reqwest::Client,
    gist_id: &str,
    token: &str,
    content: &str,
) -> Result<(), Error> {
    let url = format!("https://api.github.com/gists/{}", gist_id);
    let payload = build_payload(content);

    let response = client
        .patch(&url)
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .json(&payload)
        .send()
        .await
        .map_err(|e| Error::Network {
            url: url.clone(),
            source: e,
        })?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        return Err(Error::Gist {
            gist_id: gist_id.to_string(),
            status,
            body,
        });
    }

    Ok(())
}

fn build_payload(content: &str) -> GistUpdate {
    let mut files = HashMap::new();
    files.insert(
        GIST_FILENAME.to_string(),
        GistFile {
            content: content.to_string(),
        },
    );

    GistUpdate {
        description: GIST_DESCRIPTION.to_string(),
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
