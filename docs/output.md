# Output

`music-stats` has two outputs. The Gist output is on when `GIST_ID` and
`GH_TOKEN` are set, and the [upload](#upload) is on when `UPLOAD_TOKEN` is set.

## Gist

`music-stats` replaces the content of one file in the Gist. It sends a `PATCH`
request to `https://api.github.com/gists/<GIST_ID>`
([`src/output/github.rs`](../src/output/github.rs)), and sets:

- The file `music-stats`, created if the Gist lacks it. Other files in the Gist
  are left alone.
- The Gist description `What I've been listening to`.

The file name is the same for every provider.

### Format

[`src/output/format.rs`](../src/output/format.rs) writes one line per track,
most played first. The tracks are the top `TOP_N` by play count. Tracks with the
same count are ordered by artist, then by title, in plain string order, so the
file is the same from run to run.

```text
Weird Fishes/ Arpeggi                   Radiohead (4×)
Motion Sickness                         Phoebe Bridgers (3×)
I Was Here                              Beyoncé
```

- The title comes first, padded with spaces so the artist starts at column 41.
- A track played once shows no count. A track played more than once ends with
  ` (N×)`.
- A title longer than 35 columns and an artist longer than 25 columns are cut
  and end with `…`, so the result fits the limit. East Asian wide characters
  count as two columns.
- With no plays in the period, the file holds `No tracks played recently`.

## Upload

The upload sends the plays of the YouTube Music history page to a service that
keeps them. It posts to `<UPLOAD_URL>/api/v1/upload`
([`src/output/upload.rs`](../src/output/upload.rs)) with the header
`Authorization: Bearer <UPLOAD_TOKEN>`. [Web app](web-app.md#3-upload-api)
describes the request and the service's replies.

```json
{
  "client": "music-stats/<version>",
  "plays": [
    {
      "day": "2026-11-11",
      "artist": "Radiohead",
      "title": "Weird Fishes/ Arpeggi",
      "video_id": "rSvTmvpx0JI"
    }
  ]
}
```

- `plays` lists the page newest first. The service reads the order.
- A play is sent only when it sits under a heading that names one day (`Today`,
  `Yesterday` or a `YYYY-MM-DD` date) and has a video ID. The week and month
  headings cover several days, so their plays are left out.
- `DAYS` does not apply. The upload sends every such play of the page.
- `MUSIC_STATS_TZ` decides which day `Today` and `Yesterday` mean. The page does
  not say which zone its headings use, so keep the value the same on every run.
- A page of more than 1,000 plays is cut to its newest 1,000. An artist or title
  longer than 512 characters is cut to 512.
- The cookie is never sent. The body has no field for it.

The log reports how many plays were sent and what the service inserted. It warns
when the service reports a gap, or plays of repeated songs it could not tell
apart. [Configuration](configuration.md#errors) lists the errors.
