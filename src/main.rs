use tracing_subscriber::EnvFilter;

mod app;
mod config;
mod domain;
mod errors;
mod http;
mod output;
mod providers;

#[tokio::main]
async fn main() {
    dotenv::dotenv().ok();
    
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info"))
        )
        .init();

    match run().await {
        Ok(()) => {}
        Err(error) => {
            eprintln!("Error: {}", error);
            std::process::exit(1);
        }
    }
}

async fn run() -> Result<(), errors::Error> {
    let config = config::load()?;
    app::run(&config).await
}
