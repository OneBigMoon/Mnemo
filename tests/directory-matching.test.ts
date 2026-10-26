import assert from "node:assert/strict";
import test from "node:test";
import { matchDirectoryResource, matchResource } from "../server/matching.js";
import type { MediaInfo, SearchResult } from "../shared/types.js";

const series: MediaInfo = {
  type: "tv", title: "The Last of Us", year: 2023, season: 1,
};
const roots = ["The Last of Us (2023)"];
function resource(title: string): SearchResult {
  return {
    id: "trusted-directory-file", title, source: "115", kind: "cloud",
    url: `mori-share:${"a".repeat(64)}`,
  };
}

test("a bound directory supplies missing identity while the filename supplies its episode", () => {
  for (const name of ["S01E03.mkv", "第3集.mp4", "E03.mp4", "03.mp4", "003.ts"]) {
    const matched = matchDirectoryResource(resource(name), series, roots);
    assert.equal(matched.match, "matched", name);
    assert.deepEqual(matched.media, { ...series, episode: 3 }, name);
    assert.notEqual(matchResource(resource(name), series).match, "matched", name);
  }
  assert.equal(matchDirectoryResource(
    resource("The.Last.of.Us.S01E03.1080p.mkv"), series, roots,
  ).match, "matched");
});

test("trusted directory season context can fill a missing season without treating collection folders as file packs", () => {
  const withoutSeason = { ...series, season: undefined };
  for (const directories of [
    [...roots, "Season 01"],
    [...roots, "全集", "第一季", "合集"],
    ["The Last of Us (2023) 全集", "S01"],
    [...roots, "S01E01-E10"],
  ]) {
    const matched = matchDirectoryResource(resource("E03.mp4"), withoutSeason, directories);
    assert.equal(matched.match, "matched", directories.join("/"));
    assert.equal(matched.media?.season, 1);
    assert.equal(matched.media?.episode, 3);
  }
  const chinese: MediaInfo = { type: "tv", title: "三体", year: 2023 };
  assert.equal(matchDirectoryResource(resource("第3集.mp4"), chinese, ["三体2023全集", "第一季"]).match, "matched");
  assert.equal(matchDirectoryResource(resource("S01E03.mp4"), withoutSeason, roots).media?.season, 1);
});

test("directory conflicts are rejected even when the complete filename strictly matches", () => {
  const file = resource("The.Last.of.Us.2023.S01E03.1080p.mkv");
  assert.equal(matchResource(file, series).match, "matched");
  for (const directories of [
    [...roots, "Season 2"],
    ["The Last of Us (2024)", "Season 1"],
    ["Other Show (2023)", "Season 1"],
    ["The Last of Us Part Two (2023)", "Season 1"],
    [...roots, "Season 1", "Season 2"],
    [...roots, "S02E01-E10"],
    [...roots, "2x01-10"],
    ["The Last of Us 2023 2024", "Season 1"],
    [...roots, "花絮"],
    [...roots, "Extras"],
    [...roots, "第2集"],
  ]) assert.equal(matchDirectoryResource(file, series, directories).match, "mismatch", directories.join("/"));
});

test("directory fallback cannot overwrite explicit file title, year, season or episode conflicts", () => {
  for (const name of [
    "Other.Show.2023.S01E03.mkv",
    "The.Last.of.Us.Part.Two.2023.S01E03.mkv",
    "The.Last.of.Us.2024.S01E03.mkv",
    "The.Last.of.Us.2023.S02E03.mkv",
    "S02E03.mkv",
    "E03.2024.mp4",
  ]) assert.equal(matchDirectoryResource(resource(name), series, roots).match, "mismatch", name);
  assert.equal(matchDirectoryResource(resource("03.mp4"), { ...series, episode: 2 }, roots).match, "mismatch");
});

test("packs, extra content and nonmedia files never become an automatic episode match", () => {
  for (const name of [
    "S01E01-E10.mkv", "S01E01E02.mkv", "S01E01+02.mkv",
    "The.Last.of.Us.2023.S01.Complete.mkv", "全3集.mp4",
    "S01E03.Trailer.mkv", "第3集.花絮.mp4", "E03.字幕.mp4",
    "The.Last.of.Us.2023.S01E03.Behind.the.Scenes.mp4",
    "S01E03.srt", "第3集.ass", "S01E03.zip", "S01E03.txt",
  ]) assert.notEqual(matchDirectoryResource(resource(name), series, roots).match, "matched", name);
  assert.notEqual(matchDirectoryResource({ ...resource("S01E03.mp4"), navigation: "folder" }, series, roots).match, "matched");
});

test("missing confirmed year, file episode, or trusted season remains uncertain", () => {
  assert.equal(matchDirectoryResource(
    resource("The.Last.of.Us.2023.S01E03.mkv"), { ...series, year: undefined }, roots,
  ).match, "uncertain");
  for (const name of ["The.Last.of.Us.2023.mkv", "video.mp4", "1080p.mkv", "2023.mp4", "S01E03.5.mkv", "S01E03.DirectorsCut.mkv"]) {
    assert.equal(matchDirectoryResource(resource(name), series, roots).match, "uncertain", name);
  }
  assert.equal(matchDirectoryResource(resource("E03.mp4"), { ...series, season: undefined }, roots).match, "uncertain");
  assert.equal(matchDirectoryResource(resource("video.mp4"), series, [...roots, "第3集"]).match, "uncertain");
});

test("movie directories preserve strict full-name matching and never promote bare filenames", () => {
  for (const expected of [
    { type: "movie", title: "Dune", year: 2021 },
    { type: "movie", title: "The Collection", year: 2012 },
    { type: "movie", title: "A Complete Unknown", year: 2024 },
    { type: "movie", title: "Blade Runner 2049", year: 2017 },
  ] satisfies MediaInfo[]) {
    const directories = [`${expected.title} (${expected.year}) 合集`];
    const file = resource(`${expected.title}.${expected.year}.1080p.mkv`);
    assert.equal(matchDirectoryResource(file, expected, directories).match, "matched", expected.title);
    assert.notEqual(matchDirectoryResource(resource("03.mp4"), expected, directories).match, "matched");
    assert.equal(matchDirectoryResource(resource(`${expected.title}.mkv`), expected, directories).match, "uncertain");
  }
});

test("numeric titles are not reinterpreted as conflicting years and other original-language titles remain conflicts", () => {
  const expected: MediaInfo = { type: "tv", title: "1899", originalTitle: "Dark Oceans", year: 2022, season: 1 };
  const directories = ["1899 (2022) 全集", "Season 1"];
  assert.equal(matchDirectoryResource(resource("1899.2022.S01E03.mkv"), expected, directories).match, "matched");
  assert.equal(matchDirectoryResource(resource("Dark.Oceans.2022.S01E03.mkv"), expected, directories).match, "matched");
  assert.equal(matchDirectoryResource(resource("Dark.Oceans.Reloaded.2022.S01E03.mkv"), expected, directories).match, "mismatch");
});

test("Chinese multi-episode range files stay packs inside trusted directories", () => {
  const expected: MediaInfo = {
    type: "tv",
    title: "三体",
    year: 2023,
    season: 1,
    episode: 12,
  };
  assert.equal(
    matchDirectoryResource(
      resource("三体.2023.第一季.第一至第十二集.1080p.mkv"),
      expected,
      ["三体 (2023)"],
    ).match,
    "mismatch",
  );
  const single = matchDirectoryResource(
    resource("三体.2023.第一季.第十二集.1080p.mkv"),
    expected,
    ["三体 (2023)"],
  );
  assert.equal(single.match, "matched");
  assert.deepEqual(single.media, { ...expected });
  // Range-named directories stay unverifiable, same as the Arabic 第1-第10集 form.
  for (const directory of ["第一至第十二集", "第1-第10集"]) {
    assert.equal(
      matchDirectoryResource(
        resource("第3集.mp4"),
        { type: "tv", title: "三体", year: 2023, season: 1 },
        ["三体 (2023)", directory],
      ).match,
      "mismatch",
      directory,
    );
  }
});

test("bare resolution filenames are never promoted to episode numbers", () => {
  for (const name of [
    "360.mp4",
    "480.mp4",
    "576.mp4",
    "720.mp4",
    "1080.mp4",
    "1440.mp4",
    "2160.mp4",
    "4320.mp4",
    "1080p.mp4",
  ]) {
    const result = matchDirectoryResource(resource(name), series, roots);
    assert.equal(result.match, "uncertain", name);
    assert.equal(result.media?.episode, undefined, name);
  }
  const matched = matchDirectoryResource(resource("003.mp4"), series, roots);
  assert.equal(matched.match, "matched");
  assert.deepEqual(matched.media, { ...series, episode: 3 });
});

test("multi-season ranges in directories and files cannot authorize one selected season or episode", () => {
  for (const directory of [
    "Season 1-2",
    "Seasons 1&2",
    "S01-S02",
    "第1-2季",
    "第一、二季",
  ]) {
    assert.equal(
      matchDirectoryResource(resource("S01E03.mkv"), series, [
        ...roots,
        directory,
      ]).match,
      "mismatch",
      directory,
    );
  }
  for (const name of [
    "The.Last.of.Us.2023.S01E01-E03.mkv",
    "The.Last.of.Us.2023.S01-S02.mkv",
    "The.Last.of.Us.2023.第2、3、4集.mkv",
  ]) {
    assert.equal(
      matchDirectoryResource(resource(name), series, roots).match,
      "mismatch",
      name,
    );
  }
});
