const base = 1767744000;

const track = (index: number, uts: number) => ({
  artist: { mbid: "", "#text": `Fixture Artist ${index % 23}` },
  streamable: "0",
  image: ["small", "medium", "large", "extralarge"].map((size) => ({
    size,
    "#text": `https://lastfm.freetls.fastly.net/i/u/64s/fixture-${index}.png`,
  })),
  mbid:
    index % 3 === 0
      ? `00000000-0000-4000-8000-${`${index}`.padStart(12, "0")}`
      : "",
  album: { mbid: "", "#text": `Fixture Album ${index % 17}` },
  name: `Fixture Track ${index}`,
  url: `https://www.last.fm/music/Fixture+Artist+${index % 23}/_/Fixture+Track+${index}`,
  date: { uts: String(uts), "#text": "synthetic" },
});

const nowPlaying = {
  artist: { mbid: "", "#text": "Fixture Artist 0" },
  streamable: "0",
  image: [
    {
      size: "small",
      "#text": "https://lastfm.freetls.fastly.net/i/u/34s/fixture-np.png",
    },
  ],
  mbid: "",
  album: { mbid: "", "#text": "Fixture Album 0" },
  name: "Fixture Track Now Playing",
  url: "https://www.last.fm/music/Fixture+Artist+0/_/Fixture+Track+Now+Playing",
  "@attr": { nowplaying: "true" },
};

export default {
  recenttracks: {
    track: [
      nowPlaying,
      ...Array.from({ length: 200 }, (_, index) =>
        track(index, base - index * 173),
      ),
    ],
    "@attr": {
      user: "fixture",
      page: "1",
      perPage: "200",
      totalPages: "3",
      total: "431",
    },
  },
};
