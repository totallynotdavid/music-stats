use crate::errors::Error;
use std::time::Duration;
use tokio::time::sleep;

pub fn build_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .build()
        .expect("Failed to build HTTP client")
}

pub async fn retry_on_transient<F, T>(operation: F) -> Result<T, Error>
where
    F: Fn() -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<T, Error>> + Send>>,
{
    let max_attempts = 3;
    let mut attempt = 0;
    
    loop {
        attempt += 1;
        
        match operation().await {
            Ok(result) => return Ok(result),
            Err(error) if error.is_transient() && attempt < max_attempts => {
                let delay = Duration::from_secs(2u64.pow(attempt));
                tracing::warn!(
                    "Attempt {}/{} failed: {}. Retrying in {:?}",
                    attempt,
                    max_attempts,
                    error,
                    delay
                );
                sleep(delay).await;
            }
            Err(error) => return Err(error),
        }
    }
}
