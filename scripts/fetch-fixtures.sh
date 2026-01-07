#!/usr/bin/env bash
set -euo pipefail

FIXTURES_DIR="tests/fixtures"

mkdir -p "$FIXTURES_DIR"

if [ -n "${YOUTUBE_COOKIE:-}" ]; then
    SAPISID=$(echo "$YOUTUBE_COOKIE" | grep -oP '__Secure-3PAPISID=\K[^;]+' || echo "")
    if [ -z "$SAPISID" ]; then
        echo "Error: Could not extract SAPISID from cookie"
        exit 1
    fi
    
    TIMESTAMP=$(date +%s)
    HASH=$(echo -n "$TIMESTAMP $SAPISID https://music.youtube.com" | sha1sum | awk '{print $1}')
    AUTH="SAPISIDHASH ${TIMESTAMP}_${HASH}"
    
    COOKIE=$(echo "$YOUTUBE_COOKIE" | sed 's/[\x80-\xFF]//g' | tr -s ' ')
    [[ ! "$COOKIE" =~ SOCS= ]] && COOKIE="$COOKIE; SOCS=CAI"
    
    curl -sS \
        -H "User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" \
        -H "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" \
        -H "Accept-Language: en-US,en;q=0.5" \
        -H "Cookie: $COOKIE" \
        -H "Authorization: $AUTH" \
        "https://music.youtube.com/history" \
        -o "$FIXTURES_DIR/history.html"
    
    if [ ! -s "$FIXTURES_DIR/history.html" ]; then
        echo "Error: Failed to fetch YouTube history"
        exit 1
    fi
fi

if [ -n "${LASTFM_API_KEY:-}" ] && [ -n "${LASTFM_USERNAME:-}" ]; then
    FROM=$(date -d "7 days ago" +%s 2>/dev/null || date -v-7d +%s)
    
    curl -sS "https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=$LASTFM_USERNAME&api_key=$LASTFM_API_KEY&limit=200&from=$FROM&page=1&format=json" \
        -o "$FIXTURES_DIR/recent_tracks.json"
    
    if [ ! -s "$FIXTURES_DIR/recent_tracks.json" ]; then
        echo "Error: Failed to fetch Last.fm data"
        exit 1
    fi
    
    if grep -q '"error"' "$FIXTURES_DIR/recent_tracks.json"; then
        echo "Error: Last.fm API returned an error"
        cat "$FIXTURES_DIR/recent_tracks.json"
        exit 1
    fi
fi
