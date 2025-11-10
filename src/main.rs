use clap::Parser;
use dotenv::dotenv;

mod config;

use config::Config;

// i had to set specific short forms as it seems to take only the first
// letter of the env and that was conflicting with others
#[derive(Parser, Debug)]
struct Args {
    #[arg(short = 'g', long, env = "GIST_ID")]
    gist_id: String,

    #[arg(short = 't', long, env = "GH_TOKEN")]
    gh_token: String,

    #[arg(short = 'i', long, env = "SPOTIFY_CLIENT_ID")]
    spotify_client_id: String,

    #[arg(short = 's', long, env = "SPOTIFY_CLIENT_SECRET")]
    spotify_client_secret: String,

    #[arg(short = 'r', long, env = "SPOTIFY_REFRESH_TOKEN")]
    spotify_refresh_token: String,
}

fn main() {
    dotenv().ok();

    let args = Args::parse();

    let config = Config {
        gist_id: args.gist_id,
        gh_token: args.gh_token,
        spotify_client_id: args.spotify_client_id,
        spotify_client_secret: args.spotify_client_secret,
        spotify_refresh_token: args.spotify_refresh_token,
    };

    println!("Gist ID: {}", config.gist_id);
    println!("GH Token: {}", config.gh_token);
    println!("Spotify Client ID: {}", config.spotify_client_id);
    println!("Spotify Client Secret: {}", config.spotify_client_secret);
    println!("Spotify Refresh Token: {}", config.spotify_refresh_token);
}
