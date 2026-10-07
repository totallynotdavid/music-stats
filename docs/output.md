# Output

`music-stats` replaces the content of one file in the Gist. It sends a `PATCH`
request to `https://api.github.com/gists/<GIST_ID>`
([`src/output/github.rs`](../src/output/github.rs)), and sets:

- The file `music-stats`, created if the Gist lacks it. Other files in the Gist
  are left alone.
- The Gist description `What I've been listening to`.

The file name is the same for every provider. Earlier versions wrote
`lastfm-recent-tracks`. A Gist that has that file keeps it next to the new file.
Delete it by hand, or create a new Gist.

## Format

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
