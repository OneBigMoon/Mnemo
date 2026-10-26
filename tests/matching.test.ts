import assert from "node:assert/strict";
import test from "node:test";
import { episodeMarkers, matchResource } from "../server/matching.js";
import type { MediaInfo, SearchResult } from "../shared/types.js";

function resource(title: string): SearchResult {
  return {
    id: "upstream-id",
    title,
    url: "https://fixture.invalid/video.mp4",
    kind: "direct",
    source: "fixture",
  };
}
const movie: MediaInfo = { type: "movie", title: "Dune", year: 2021 };
const tv: MediaInfo = {
  type: "tv",
  title: "The Last of Us",
  year: 2023,
  season: 1,
  episode: 2,
};

test("same-name years and full multiword titles are checked without prefix matching", () => {
  assert.equal(
    matchResource(resource("Dune.2021.1080p.mkv"), movie).match,
    "matched",
  );
  assert.equal(
    matchResource(resource("Dune.1984.1080p.mkv"), movie).match,
    "mismatch",
  );
  assert.equal(
    matchResource(resource("Dune Part Two 2021 1080p"), movie).match,
    "mismatch",
  );
  assert.equal(
    matchResource(resource("The Matrix Reloaded 1999"), {
      type: "movie",
      title: "The Matrix",
      year: 1999,
    }).match,
    "mismatch",
  );
  assert.equal(
    matchResource(resource("The.Matrix.1999.1080p"), {
      type: "movie",
      title: "The Matrix",
      year: 1999,
    }).match,
    "matched",
  );
  assert.equal(
    matchResource(resource("Upstream 2009"), {
      type: "movie",
      title: "Up",
      year: 2009,
    }).match,
    "mismatch",
  );
  assert.equal(matchResource(resource("Dune 1080p"), movie).match, "uncertain");
  assert.equal(matchResource(resource("资源"), movie).match, "uncertain");
  assert.equal(
    matchResource(resource("1080p WEB-DL"), movie).match,
    "uncertain",
  );
});

test("original titles and years contained in a movie name keep their identity", () => {
  assert.equal(
    matchResource(resource("Dune 2021 1080p"), {
      ...movie,
      title: "沙丘",
      originalTitle: "Dune",
    }).match,
    "matched",
  );
  assert.equal(
    matchResource(resource("沙丘 Dune 2021 1080p"), {
      ...movie,
      title: "沙丘",
      originalTitle: "Dune",
    }).match,
    "matched",
  );
  assert.equal(
    matchResource(resource("Blade.Runner.2049.2017.1080p"), {
      type: "movie",
      title: "Blade Runner 2049",
      year: 2017,
    }).match,
    "matched",
  );
  assert.equal(
    matchResource(resource("1917 2019 1080p"), {
      type: "movie",
      title: "1917",
      year: 2019,
    }).match,
    "matched",
  );
});

test("TV evidence checks type, season, episode and whole-season packages", () => {
  assert.equal(
    matchResource(resource("The.Last.of.Us.2023.S01E02.1080p"), tv).match,
    "matched",
  );
  assert.equal(
    matchResource(resource("The.Last.of.Us.2023.S02E02.1080p"), tv).match,
    "mismatch",
  );
  assert.equal(
    matchResource(resource("The.Last.of.Us.2023.S01E03.1080p"), tv).match,
    "mismatch",
  );
  assert.equal(
    matchResource(resource("The.Last.of.Us.2023.S01.Complete"), tv).match,
    "mismatch",
  );
  assert.equal(
    matchResource(resource("The.Last.of.Us.2023.S01E01-E10"), tv).match,
    "mismatch",
  );
  assert.equal(
    matchResource(resource("The.Last.of.Us.2023.S01E02E03"), tv).match,
    "mismatch",
  );
  assert.equal(
    matchResource(resource("Dune 2021 S01E01"), movie).match,
    "mismatch",
  );
  assert.equal(
    matchResource(resource("The Last of Us 2023 movie"), tv).match,
    "mismatch",
  );
  assert.equal(
    matchResource(resource("[电影] The Last of Us 2023 S01E02"), tv).match,
    "mismatch",
  );
  assert.equal(
    matchResource(resource("The Last of Us 2023 E02"), tv).match,
    "uncertain",
  );
  const { episode, ...season } = tv;
  const single = matchResource(resource("The Last of Us 2023 S01E07"), season);
  assert.equal(single.match, "matched");
  assert.equal(single.media?.episode, 7);
  assert.equal(
    matchResource(resource("The Last of Us 2023 S01 Complete"), season).match,
    "uncertain",
  );
});

test("Chinese season and episode markers are concrete identity evidence", () => {
  const expected: MediaInfo = {
    type: "tv",
    title: "三体",
    year: 2023,
    season: 2,
    episode: 12,
  };
  const result = matchResource(
    resource("三体 2023 第二季 第十二集 1080p"),
    expected,
  );
  assert.equal(result.match, "matched");
  assert.equal(result.media?.episode, 12);
  assert.equal(
    matchResource(resource("三体 2023 第一季 第十二集"), expected).match,
    "mismatch",
  );
  assert.equal(
    matchResource(resource("三体 2023 第二季 全30集"), expected).match,
    "mismatch",
  );
});

test("movie collection markers cannot match a single film", () => {
  const expected: MediaInfo = { type: "movie", title: "Star Wars", year: 1977 };
  assert.equal(
    matchResource(resource("Star Wars 1977 1080p.mkv"), expected).match,
    "matched",
  );
  assert.equal(
    matchResource(
      resource("Star Wars 1977 Complete Collection 1080p.mkv"),
      expected,
    ).match,
    "mismatch",
  );
  assert.equal(
    matchResource(resource("Star Wars 1977 合集 1080p.mkv"), expected).match,
    "mismatch",
  );
  assert.notEqual(
    matchResource(resource("Star Wars 1977 S01E02.5 1080p.mkv"), expected)
      .match,
    "matched",
  );
  assert.equal(
    matchResource(resource("The Collection 2012 1080p.mkv"), {
      type: "movie",
      title: "The Collection",
      year: 2012,
    }).match,
    "matched",
  );
  assert.equal(
    matchResource(resource("A Complete Unknown 2024 1080p.mkv"), {
      type: "movie",
      title: "A Complete Unknown",
      year: 2024,
    }).match,
    "matched",
  );
});

test("episode ranges and fractional numbers do not become a complete single-episode token", () => {
  for (const marker of [
    "1x02-03",
    "S01E02.5",
    "S01E02.5.1080p.mkv",
    "S01E02bonus",
    "第1季 第2-3集",
    "第1季 第2.5集",
  ]) {
    assert.notEqual(
      matchResource(resource(`The Last of Us 2023 ${marker}`), tv).match,
      "matched",
      marker,
    );
    assert.deepEqual(episodeMarkers(marker).episodes, [], marker);
  }
  for (const marker of [
    "S01E02.1080p.mkv",
    "1x02.1080p.mkv",
    "S01E02 720p",
    "第1季 第2集",
  ]) {
    assert.equal(
      matchResource(resource(`The Last of Us 2023 ${marker}`), tv).match,
      "matched",
      marker,
    );
    assert.deepEqual(episodeMarkers(marker).episodes, [2], marker);
  }
  assert.equal(episodeMarkers("1x02-03").pack, true);
});

test("season-prefixed ranges remain packs even when their last episode would otherwise match", () => {
  const expected = { ...tv, episode: 10 };
  for (const marker of [
    "S01E01-E10", "S01E01-10", "S01E01-S01E10", "S01.E01-E10",
    "S01E01+10", "E01/E10", "1x01-10", "第1-第10集",
  ]) {
    assert.equal(episodeMarkers(marker).pack, true, marker);
    if (/^(?:S|1x)/u.test(marker))
      assert.deepEqual(episodeMarkers(marker).seasons, [1], marker);
    assert.equal(matchResource(resource(`The.Last.of.Us.2023.${marker}.mkv`), expected).match, "mismatch", marker);
    assert.notEqual(matchResource(resource(`The.Last.of.Us.2023.${marker}.mkv`), { ...expected, episode: undefined }).match, "matched", marker);
  }
});

test("Chinese-number episode ranges are packs, not their last episode", () => {
  const expected: MediaInfo = {
    type: "tv",
    title: "三体",
    year: 2023,
    season: 1,
    episode: 12,
  };
  for (const marker of [
    "第一至第十二集",
    "第1至第十二集",
    "第一至12集",
    "第1至第12集",
    "第1至12集",
  ]) {
    assert.equal(episodeMarkers(marker).pack, true, marker);
    assert.equal(
      matchResource(resource(`三体 2023 第一季 ${marker} 1080p`), expected)
        .match,
      "mismatch",
      marker,
    );
  }
  const single = matchResource(
    resource("三体 2023 第一季 第十二集 1080p"),
    expected,
  );
  assert.equal(single.match, "matched");
  assert.equal(single.media?.episode, 12);
});

test("multi-season ranges record both endpoints and never satisfy a single season or episode", () => {
  const episode: MediaInfo = {
    type: "tv",
    title: "The Last of Us",
    year: 2023,
    season: 1,
    episode: 3,
  };
  const season = { ...episode, episode: undefined };
  for (const marker of [
    "Season 1-2",
    "Seasons 1&2",
    "Seasons 1, 2",
    "S01-S02",
    "S01-02",
    "第1-2季",
    "第1至2季",
    "第一、二季",
    "第１－２季",
  ]) {
    const markers = episodeMarkers(marker);
    assert.equal(markers.pack, true, marker);
    assert.ok(markers.seasons.includes(1), marker);
    assert.ok(markers.seasons.includes(2), marker);
    assert.equal(
      matchResource(resource(`The Last of Us 2023 ${marker}`), episode).match,
      "mismatch",
      marker,
    );
    assert.equal(
      matchResource(resource(`The Last of Us 2023 ${marker}`), season).match,
      "uncertain",
      marker,
    );
  }
  assert.equal(
    matchResource(
      resource("The Last of Us 2023 Season 2-3"),
      { ...episode, season: 2, episode: 4 },
    ).match,
    "mismatch",
  );
});

test("compound Chinese episode lists are packs even when the last number equals the choice", () => {
  const expected: MediaInfo = {
    type: "tv",
    title: "三体",
    year: 2023,
    season: 1,
    episode: 5,
  };
  for (const marker of [
    "第2、3、4集",
    "第2,3,4集",
    "第2，3，4集",
    "第2-4、6集",
    "第2到4集",
    "第2—4集",
    "第2～4集",
    "第2、3、4集 第5集",
  ]) {
    assert.equal(episodeMarkers(marker).pack, true, marker);
    assert.equal(
      matchResource(resource(`三体 2023 第一季 ${marker} 1080p`), expected)
        .match,
      "mismatch",
      marker,
    );
  }
  assert.equal(
    matchResource(resource("三体 2023 第一季 第5集 1080p"), expected).match,
    "matched",
  );
});

test("bare second episode numbers are packs while resolutions, years, versions and channels stay metadata", () => {
  const expected: MediaInfo = {
    type: "tv",
    title: "The Last of Us",
    year: 2023,
    season: 1,
    episode: 2,
  };
  for (const marker of ["S01E02 03", "E02 03", "S01E02 03 1080p"]) {
    assert.equal(episodeMarkers(marker).pack, true, marker);
    assert.equal(
      matchResource(resource(`The Last of Us 2023 ${marker}`), expected).match,
      "mismatch",
      marker,
    );
  }
  for (const marker of [
    "S01E02 1080p",
    "S01E02 2023",
    "S01E02 5.1",
    "S01E02 2ch",
    "S01E02 x264",
  ]) {
    assert.equal(episodeMarkers(marker).pack, false, marker);
    assert.deepEqual(episodeMarkers(marker).episodes, [2], marker);
  }
  assert.equal(
    matchResource(resource("The Last of Us 2023 S01E02 1080p"), expected)
      .match,
    "matched",
  );
});

test("fullwidth season and episode names are normalized before parsing", () => {
  const expected: MediaInfo = {
    type: "tv",
    title: "三体",
    year: 2023,
    season: 2,
    episode: 3,
  };
  assert.equal(
    matchResource(resource("三体 2023 第２季 第３集 1080p"), expected).match,
    "matched",
  );
  assert.equal(
    matchResource(
      resource("The Last of Us 2023 Ｓ０１Ｅ０２ 1080p"),
      {
        type: "tv",
        title: "The Last of Us",
        year: 2023,
        season: 1,
        episode: 2,
      },
    ).match,
    "matched",
  );
  assert.equal(episodeMarkers("第１－２季").pack, true);
  assert.equal(episodeMarkers("第２—４集").pack, true);
});
