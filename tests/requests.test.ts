import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Requests } from "../server/requests.js";
import { Store } from "../server/store.js";
import type {
  AgentDeps,
  DownloadTask,
  MediaInfo,
  MediaService,
  RequestSelection,
  SearchResult,
  Subscription,
} from "../shared/types.js";

const modern: MediaInfo = {
  type: "movie",
  title: "Dune",
  year: 2021,
  tmdbId: 438631,
};
const classic: MediaInfo = {
  type: "movie",
  title: "Dune",
  year: 1984,
  tmdbId: 841,
};
function results(...titles: string[]): SearchResult[] {
  return titles.map((title, index) => ({
    id: `upstream-${index}`,
    title,
    url: `https://fixture.invalid/${index}.mp4`,
    source: "fixture",
    kind: "direct",
  }));
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(
  t: TestContext,
  service: Pick<MediaService, "identify" | "search">,
) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mori-requests-"));
  const state = {
    directory,
    store: new Store(directory, path.join(directory, "files")),
    taskCalls: 0,
    subscriptionCalls: 0,
    requests: undefined as unknown as Requests,
  };
  const actions = {
    addTask(input: Parameters<AgentDeps["addTask"]>[0]): DownloadTask {
      state.taskCalls++;
      const now = new Date().toISOString();
      const task: DownloadTask = {
        id: randomUUID(),
        title: input.title,
        url: input.url,
        kind: input.kind || "direct",
        media: input.media!,
        profile: "emby",
        status:
          input.kind === "share" || input.kind === "telegram"
            ? "needs_attention"
            : "queued",
        progress: 0,
        bytes: 0,
        total: 0,
        createdAt: now,
        updatedAt: now,
      };
      state.store.put("task", task);
      return task;
    },
    subscribe(
      query: string,
      media: MediaInfo,
      startEpisode?: number,
    ): Subscription {
      state.subscriptionCalls++;
      const subscription: Subscription = {
        id: randomUUID(),
        title: media.title,
        query,
        enabled: true,
        autoDownload: true,
        seen: [],
        createdAt: new Date().toISOString(),
        media,
        ...(startEpisode !== undefined ? { startEpisode } : {}),
      };
      state.store.put("subscription", subscription);
      return subscription;
    },
  };
  const open = () => new Requests(state.store, service, actions);
  state.requests = open();
  t.after(async () => {
    await state.requests.close();
    state.store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { state, actions, open };
}

test("same-name requests persist server-bound choices, block mismatches and isolate owners", async (t) => {
  const { state } = fixture(t, {
    identify: async () => [classic, modern],
    search: async () => results("Dune 1984 1080p", "Dune 2021 1080p"),
  });
  let request = await state.requests.begin("web:admin", "Dune", "search");
  const originalCandidate = request.candidates.find(
    ({ media }) => media.year === 2021,
  )!.id;
  assert.equal(request.stage, "media");
  assert.equal(state.taskCalls, 0);
  assert.notEqual(request.candidates[0].id, String(classic.tmdbId));
  await assert.rejects(
    state.requests.select("web:admin", request.id, {
      expectedRevision: request.revision,
      candidateId: "upstream-0",
    }),
    /候选/,
  );
  request = await state.requests.select("web:admin", request.id, {
    expectedRevision: request.revision,
    candidateId: request.candidates.find(({ media }) => media.year === 2021)!
      .id,
  });
  assert.equal(request.stage, "resource");
  assert.equal(state.taskCalls, 0);
  assert.equal(request.resources[0].match, "mismatch");
  await assert.rejects(
    state.requests.select("web:admin", request.id, {
      expectedRevision: request.revision,
      candidateId: originalCandidate,
    }),
    /字段/,
  );
  await assert.rejects(
    state.requests.select("web:admin", request.id, {
      expectedRevision: request.revision,
      resourceId: request.resources[0].id,
      confirmUncertain: true,
    }),
    /不匹配/,
  );
  const choice = {
    expectedRevision: request.revision,
    resourceId: request.resources[1].id,
  };
  const completed = await state.requests.select(
    "web:admin",
    request.id,
    choice,
  );
  assert.equal(completed.stage, "completed");
  assert.equal(state.store.list<DownloadTask>("task")[0].media.year, 2021);
  assert.equal(
    (await state.requests.select("web:admin", request.id, choice)).taskId,
    completed.taskId,
  );
  assert.equal(state.taskCalls, 1);
  assert.throws(
    () => state.requests.get("telegram:other", request.id),
    /无权|不存在/,
  );
  await assert.rejects(
    state.requests.select("telegram:other", request.id, choice),
    /无权|不存在/,
  );
  assert.deepEqual(state.requests.list("telegram:other"), []);
  assert.equal(state.requests.latest("web:admin")?.id, request.id);
});

test("explicit year downloads only a unique matched resource and search never downloads automatically", async (t) => {
  const { state } = fixture(t, {
    identify: async () => [classic, modern],
    search: async () => results("Dune 2021 1080p"),
  });
  const request = await state.requests.begin(
    "admin",
    "Dune (2021)",
    "download",
  );
  assert.equal(request.stage, "completed");
  assert.equal(request.selected?.year, 2021);
  assert.equal(state.taskCalls, 1);
  assert.equal(
    (
      await state.requests.select("admin", request.id, {
        expectedRevision: request.revision,
        resourceId: request.resources[0].id,
      })
    ).taskId,
    request.taskId,
  );
  const search = await state.requests.begin("admin", "Dune (2021)", "search");
  assert.equal(search.stage, "resource");
  assert.equal(state.taskCalls, 1);
});

test("TV requests require season and episode for downloads, while subscriptions target a season and optional start", async (t) => {
  const series: MediaInfo = {
    type: "tv",
    title: "三体",
    year: 2023,
    tmdbId: 100,
  };
  const { state } = fixture(t, {
    identify: async () => [series],
    search: async () =>
      results("三体 2023 第一季 第三集", "三体 2023 第二季 第三集"),
  });
  let request = await state.requests.begin("admin", "三体", "download");
  assert.equal(request.stage, "details");
  request = await state.requests.select("admin", request.id, {
    expectedRevision: request.revision,
    season: 2,
  });
  assert.equal(request.stage, "details");
  assert.equal(state.taskCalls, 0);
  request = await state.requests.select("admin", request.id, {
    expectedRevision: request.revision,
    episode: 3,
  });
  assert.equal(request.stage, "completed");
  assert.equal(state.store.list<DownloadTask>("task")[0].media.season, 2);
  assert.equal(state.store.list<DownloadTask>("task")[0].media.episode, 3);
  let subscription = await state.requests.begin("admin", "三体", "subscribe");
  assert.equal(subscription.stage, "details");
  const subscriptionChoice = {
    expectedRevision: subscription.revision,
    season: 2,
    episode: 5,
  };
  subscription = await state.requests.select(
    "admin",
    subscription.id,
    subscriptionChoice,
  );
  const stored = state.store.list<Subscription>("subscription")[0];
  assert.equal(stored.autoDownload, true);
  assert.equal(stored.media?.season, 2);
  assert.equal(stored.media?.episode, undefined);
  assert.equal(stored.startEpisode, 5);
  assert.equal(stored.query, "三体");
  assert.equal(
    (await state.requests.select("admin", subscription.id, subscriptionChoice))
      .subscriptionId,
    subscription.subscriptionId,
  );
  assert.equal(state.subscriptionCalls, 1);
  const fromQuery = await state.requests.begin(
    "admin",
    "三体 S01E05",
    "subscribe",
  );
  assert.equal(fromQuery.stage, "completed");
  assert.equal(
    state.store.list<Subscription>("subscription")[0].query,
    "三体 S01E05",
  );
  assert.equal(
    state.store.list<Subscription>("subscription")[0].startEpisode,
    5,
  );
});

test("manual metadata accepts only identity fields and uncertain resources require explicit confirmation", async (t) => {
  const { state } = fixture(t, {
    identify: async () => {
      throw new Error("provider unavailable");
    },
    search: async () => results("The Matrix 1080p"),
  });
  let request = await state.requests.begin("admin", "The Matrix", "download");
  assert.equal(request.stage, "details");
  const attempts: unknown[] = [
    {
      media: {
        type: "movie",
        title: "The Matrix",
        year: 1999,
        posterUrl: "https://other.invalid/image.jpg",
      },
    },
    { media: { type: "movie", title: "The Matrix", year: "1999" } },
    {
      media: { type: "movie", title: "The Matrix", year: 1999 },
      url: "https://other.invalid/video.mp4",
    },
    { owner: "someone-else", media: { type: "movie", title: "The Matrix" } },
  ];
  for (const attempt of attempts)
    await assert.rejects(
      state.requests.select("admin", request.id, {
        expectedRevision: request.revision,
        ...(attempt as object),
      } as RequestSelection),
    );
  request = await state.requests.select("admin", request.id, {
    expectedRevision: request.revision,
    media: { type: "movie", title: "The Matrix", year: 1999 },
  });
  assert.equal(request.stage, "resource");
  assert.equal(request.resources[0].match, "uncertain");
  assert.equal(state.taskCalls, 0);
  await assert.rejects(
    state.requests.select("admin", request.id, {
      expectedRevision: request.revision,
      resourceId: request.resources[0].id,
    }),
    /不确定/,
  );
  await assert.rejects(
    state.requests.select("admin", request.id, {
      expectedRevision: request.revision,
      resourceId: request.resources[0].id,
      url: "https://other.invalid/video.mp4",
    } as RequestSelection),
    /字段/,
  );
  request = await state.requests.select("admin", request.id, {
    expectedRevision: request.revision,
    resourceId: request.resources[0].id,
    confirmUncertain: true,
  });
  assert.equal(request.stage, "completed");
  assert.equal(state.taskCalls, 1);
  assert.equal(
    state.store.list<DownloadTask>("task")[0].url,
    "https://fixture.invalid/0.mp4",
  );
  await assert.rejects(
    state.requests.select("admin", request.id, {
      expectedRevision: request.revision,
      resourceId: request.resources[0].id,
      confirmUncertain: true,
      posterUrl: "https://other.invalid/poster",
    } as RequestSelection),
    /字段/,
  );
});

test("restart retains the exact choices and idempotent completion receipt", async (t) => {
  const { state, open } = fixture(t, {
    identify: async () => [modern],
    search: async () => results("Dune 2021 1080p", "Dune 2021 2160p"),
  });
  let request = await state.requests.begin("admin", "Dune", "download");
  assert.equal(request.stage, "resource");
  const ids = request.resources.map(({ id }) => id);
  const choice = { expectedRevision: request.revision, resourceId: ids[1] };
  state.store.close();
  state.store = new Store(state.directory);
  state.requests = open();
  assert.deepEqual(
    state.requests.get("admin", request.id).resources.map(({ id }) => id),
    ids,
  );
  request = await state.requests.select("admin", request.id, choice);
  state.store.close();
  state.store = new Store(state.directory);
  state.requests = open();
  assert.equal(
    (await state.requests.select("admin", request.id, choice)).taskId,
    request.taskId,
  );
  assert.equal(state.taskCalls, 1);
  await assert.rejects(
    state.requests.select("admin", request.id, {
      expectedRevision: request.revision,
      resourceId: ids[0],
    }),
    /结束/,
  );
  await assert.rejects(
    state.requests.select("admin", request.id, {
      expectedRevision: request.revision,
      candidateId: request.candidates[0].id,
    }),
    /结束/,
  );
});

test("concurrent choices have one side effect across request handlers", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { state, open } = fixture(t, {
    identify: async () => [classic, modern],
    search: async () => {
      await gate;
      return results("Dune 2021 1080p");
    },
  });
  const request = await state.requests.begin("admin", "Dune", "download");
  const choice = {
    expectedRevision: request.revision,
    candidateId: request.candidates.find(({ media }) => media.year === 2021)!
      .id,
  };
  const first = state.requests.select("admin", request.id, choice);
  const duplicate = state.requests.select("admin", request.id, choice);
  await assert.rejects(
    state.requests.select("admin", request.id, {
      expectedRevision: request.revision,
      candidateId: request.candidates.find(({ media }) => media.year === 1984)!
        .id,
    }),
    /正在处理/,
  );
  const concurrentHandler = open().select("admin", request.id, choice);
  release();
  const completed = await Promise.all([first, duplicate, concurrentHandler]);
  assert.equal(state.taskCalls, 1);
  assert.equal(new Set(completed.map(({ taskId }) => taskId)).size, 1);
});

test("failed synchronous side effects roll back with the completion record", async (t) => {
  const { state, actions } = fixture(t, {
    identify: async () => [modern],
    search: async () => results("Dune 2021 1080p"),
  });
  const request = await state.requests.begin("admin", "Dune", "search");
  const action = actions.addTask;
  actions.addTask = (input) => {
    action(input);
    throw new Error("fixture write failure");
  };
  await assert.rejects(
    state.requests.select("admin", request.id, {
      expectedRevision: request.revision,
      resourceId: request.resources[0].id,
    }),
    /fixture write failure/,
  );
  assert.equal(state.store.list<DownloadTask>("task").length, 0);
  assert.equal(state.requests.get("admin", request.id).stage, "resource");
  actions.addTask = action;
  assert.equal(
    (
      await state.requests.select("admin", request.id, {
        expectedRevision: request.revision,
        resourceId: request.resources[0].id,
      })
    ).stage,
    "completed",
  );
  assert.equal(state.store.list<DownloadTask>("task").length, 1);
});

test("share and Telegram results remain unresolved and never become automatic direct downloads", async (t) => {
  const { state } = fixture(t, {
    identify: async () => [modern],
    search: async () => [
      {
        ...results("Dune 2021 1080p")[0],
        kind: "share",
        url: "https://pan.baidu.com/s/fixture",
      },
    ],
  });
  let request = await state.requests.begin("admin", "Dune", "download");
  assert.equal(request.stage, "resource");
  assert.equal(state.taskCalls, 0);
  request = await state.requests.select("admin", request.id, {
    expectedRevision: request.revision,
    resourceId: request.resources[0].id,
  });
  assert.match(request.message, /尚未解析/);
  assert.equal(state.store.list<DownloadTask>("task")[0].kind, "share");
  assert.equal(
    state.store.list<DownloadTask>("task")[0].status,
    "needs_attention",
  );
});

test("expired choices and bounded owner capacity reject without starting new work", async (t) => {
  const { state } = fixture(t, {
    identify: async () => [],
    search: async () => [],
  });
  const expired = await state.requests.begin("expired", "Dune", "search");
  state.store.put("request", {
    ...state.store.record<any>("request", expired.id),
    expiresAt: new Date(Date.now() - 1).toISOString(),
  });
  assert.throws(() => state.requests.get("expired", expired.id), /到期/);
  await assert.rejects(
    state.requests.select("expired", expired.id, {
      expectedRevision: expired.revision,
      media: { type: "movie", title: "Dune", year: 2021 },
    }),
    /到期/,
  );
  assert.deepEqual(state.requests.list("expired"), []);
  for (let i = 0; i < 100; i++)
    await state.requests.begin("admin", `Movie ${i}`, "search");
  await assert.rejects(
    state.requests.begin("admin", "Movie overflow", "search"),
    /上限/,
  );
  assert.equal(state.requests.list("admin").length, 100);
  assert.equal(state.store.record("request", expired.id), undefined);
});

test("old details cannot supply an episode after another view changes the season", async (t) => {
  let searchCalls = 0;
  const { state } = fixture(t, {
    identify: async () => [{ type: "tv", title: "The Last of Us", year: 2023 }],
    search: async () => {
      searchCalls++;
      return results("The Last of Us 2023 S02E03 1080p");
    },
  });
  let current = await state.requests.begin(
    "admin",
    "The Last of Us",
    "download",
  );
  assert.equal(
    current.revision,
    state.requests.get("admin", current.id).revision,
  );
  await assert.rejects(
    state.requests.select("admin", current.id, {
      season: 1,
    } as RequestSelection),
    /版本/,
  );
  current = await state.requests.select("admin", current.id, {
    expectedRevision: current.revision,
    season: 1,
  });
  const oldView = current;
  current = await state.requests.select("admin", current.id, {
    expectedRevision: current.revision,
    season: 2,
  });
  assert.equal(current.stage, "details");
  assert.ok(current.revision > oldView.revision);
  const stale = { expectedRevision: oldView.revision, episode: 3 };
  await assert.rejects(
    state.requests.select("admin", current.id, stale),
    (error: any) => error.status === 409,
  );
  assert.equal(searchCalls, 0);
  assert.equal(state.taskCalls, 0);
  assert.equal(
    state.requests.get("admin", current.id).selected?.episode,
    undefined,
  );
  const choice = { expectedRevision: current.revision, episode: 3 };
  const completed = await state.requests.select("admin", current.id, choice);
  assert.equal(state.store.list<DownloadTask>("task")[0].media.season, 2);
  assert.equal(state.store.list<DownloadTask>("task")[0].media.episode, 3);
  assert.equal(
    (await state.requests.select("admin", current.id, choice)).taskId,
    completed.taskId,
  );
  await assert.rejects(
    state.requests.select("admin", current.id, { ...choice, episode: 4 }),
    (error: any) => error.status === 409,
  );
  assert.equal(state.taskCalls, 1);
});

test("media and resource views reject stale versions while an identical completed payload replays", async (t) => {
  const { state } = fixture(t, {
    identify: async () => [classic, modern],
    search: async () => results("Dune 2021 1080p", "Dune 2021 2160p"),
  });
  const original = await state.requests.begin("admin", "Dune", "search");
  const mediaChoice = {
    expectedRevision: original.revision,
    candidateId: original.candidates.find(({ media }) => media.year === 2021)!
      .id,
  };
  const current = await state.requests.select(
    "admin",
    original.id,
    mediaChoice,
  );
  assert.equal(current.stage, "resource");
  await assert.rejects(
    state.requests.select("admin", original.id, mediaChoice),
    (error: any) => error.status === 409,
  );
  await assert.rejects(
    state.requests.select("admin", current.id, {
      expectedRevision: original.revision,
      resourceId: current.resources[0].id,
    }),
    (error: any) => error.status === 409,
  );
  assert.equal(state.taskCalls, 0);
  const resourceChoice = {
    expectedRevision: current.revision,
    resourceId: current.resources[0].id,
  };
  const completed = await state.requests.select(
    "admin",
    current.id,
    resourceChoice,
  );
  assert.equal(
    (await state.requests.select("admin", current.id, resourceChoice)).taskId,
    completed.taskId,
  );
  await assert.rejects(
    state.requests.select("admin", current.id, {
      ...resourceChoice,
      resourceId: current.resources[1].id,
    }),
    (error: any) => error.status === 409,
  );
  assert.equal(state.taskCalls, 1);
});

test("a concurrent view changing during search is checked again inside the transaction", async (t) => {
  let release!: (value: SearchResult[]) => void;
  const gate = new Promise<SearchResult[]>((resolve) => {
    release = resolve;
  });
  const { state, open } = fixture(t, {
    identify: async () => [classic, modern],
    search: async () => gate,
  });
  const request = await state.requests.begin("admin", "Dune", "download");
  const firstChoice = {
    expectedRevision: request.revision,
    candidateId: request.candidates.find(({ media }) => media.year === 2021)!
      .id,
  };
  const competingChoice = {
    expectedRevision: request.revision,
    candidateId: request.candidates.find(({ media }) => media.year === 1984)!
      .id,
  };
  const first = state.requests.select("admin", request.id, firstChoice);
  const competing = open().select("admin", request.id, competingChoice);
  release(results("Dune 2021 1080p"));
  assert.equal((await first).stage, "completed");
  await assert.rejects(competing, (error: any) => error.status === 409);
  assert.equal(state.taskCalls, 1);
});

test("cancelled identification cannot commit candidates, fall back to manual metadata or create automatic actions", async (t) => {
  for (const intent of ["download", "subscribe"] as const) {
    for (const outcome of ["resolve", "reject"] as const) {
      let resolve!: (value: MediaInfo[]) => void,
        reject!: (error: Error) => void;
      const gate = new Promise<MediaInfo[]>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      let searchCalls = 0;
      const { state } = fixture(t, {
        identify: async () => gate,
        search: async () => {
          searchCalls++;
          return results("Dune 2021 1080p");
        },
      });
      const controller = new AbortController();
      const pending = state.requests.begin(
        "admin",
        "Dune",
        intent,
        controller.signal,
      );
      const before = state.requests.latest("admin")!;
      controller.abort();
      if (outcome === "resolve") resolve([modern]);
      else reject(new Error("fixture stopped"));
      await assert.rejects(pending, { name: "AbortError" });
      assert.deepEqual(state.requests.get("admin", before.id), before);
      assert.equal(searchCalls, 0);
      assert.equal(state.taskCalls, 0);
      assert.equal(state.subscriptionCalls, 0);
    }
  }
});

test("begin passes cancellation into search and discards results returned after cancellation", async (t) => {
  let started!: () => void, release!: (value: SearchResult[]) => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<SearchResult[]>((resolve) => {
    release = resolve;
  });
  let searchSignal: AbortSignal | undefined;
  const { state } = fixture(t, {
    identify: async () => [modern],
    search: async (_query, signal) => {
      searchSignal = signal;
      started();
      return gate;
    },
  });
  const controller = new AbortController();
  const pending = state.requests.begin(
    "admin",
    "Dune",
    "download",
    controller.signal,
  );
  await entered;
  const before = state.requests.latest("admin")!;
  controller.abort();
  assert.equal(searchSignal?.aborted, true);
  release(results("Dune 2021 1080p"));
  await assert.rejects(pending, { name: "AbortError" });
  assert.deepEqual(state.requests.get("admin", before.id), before);
  assert.equal(state.taskCalls, 0);
});

test("select cancellation prevents later search commits and automatic tasks on both resolution and failure", async (t) => {
  for (const outcome of ["resolve", "reject"] as const) {
    let started!: () => void,
      resolve!: (value: SearchResult[]) => void,
      reject!: (error: Error) => void;
    const entered = new Promise<void>((yes) => {
      started = yes;
    });
    const gate = new Promise<SearchResult[]>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    let searchSignal: AbortSignal | undefined;
    const { state } = fixture(t, {
      identify: async () => [classic, modern],
      search: async (_query, signal) => {
        searchSignal = signal;
        started();
        return gate;
      },
    });
    const request = await state.requests.begin("admin", "Dune", "download");
    const choice = {
      expectedRevision: request.revision,
      candidateId: request.candidates.find(({ media }) => media.year === 2021)!
        .id,
    };
    const controller = new AbortController();
    const pending = state.requests.select(
      "admin",
      request.id,
      choice,
      controller.signal,
    );
    await entered;
    const before = state.requests.get("admin", request.id);
    controller.abort();
    assert.equal(searchSignal?.aborted, true);
    if (outcome === "resolve") resolve(results("Dune 2021 1080p"));
    else reject(new Error("fixture stopped"));
    await assert.rejects(pending, { name: "AbortError" });
    assert.deepEqual(state.requests.get("admin", request.id), before);
    assert.equal(state.taskCalls, 0);
  }
});

test("already cancelled begin and resource confirmations perform no writes", async (t) => {
  const { state } = fixture(t, {
    identify: async () => [modern],
    search: async () => results("Dune 2021 1080p"),
  });
  const request = await state.requests.begin("admin", "Dune", "search");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    state.requests.begin("admin", "Dune", "subscribe", controller.signal),
    { name: "AbortError" },
  );
  await assert.rejects(
    state.requests.select(
      "admin",
      request.id,
      {
        expectedRevision: request.revision,
        resourceId: request.resources[0].id,
      },
      controller.signal,
    ),
    { name: "AbortError" },
  );
  assert.deepEqual(state.requests.get("admin", request.id), request);
  assert.equal(state.requests.list("admin").length, 1);
  assert.equal(state.taskCalls, 0);
  assert.equal(state.subscriptionCalls, 0);
});

test("close waits for every owned identification and rejects late success and fallback writes", async (t) => {
  const gates = [deferred<MediaInfo[]>(), deferred<MediaInfo[]>(), deferred<MediaInfo[]>()];
  const signals: AbortSignal[] = [];
  let identifies = 0, searches = 0;
  const { state } = fixture(t, {
    identify: async (_query, _type, signal) => { signals.push(signal!); return gates[identifies++].promise; },
    search: async () => { searches++; return results("Dune 2021 1080p"); },
  });
  const operations = ["download", "subscribe", "search"].map((intent) => state.requests.begin("admin", "Dune", intent as "download" | "subscribe" | "search"));
  const rejected = operations.map((operation) => assert.rejects(operation, { name: "AbortError" }));
  const before = state.requests.list("admin");
  const closing = state.requests.close();
  assert.equal(state.requests.close(), closing);
  assert.ok(signals.every((signal) => signal.aborted));
  let drained = false;
  void closing.then(() => { drained = true; });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(drained, false);
    gates[0].resolve([modern]);
    gates[1].resolve([modern]);
    await Promise.all(rejected.slice(0, 2));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(drained, false);
    assert.equal(searches, 0);
    assert.equal(state.taskCalls, 0);
    assert.equal(state.subscriptionCalls, 0);
  } finally {
    gates[0].resolve([modern]); gates[1].resolve([modern]); gates[2].reject(new Error("fixture late identification failure"));
  }
  await Promise.all([...rejected, closing]);
  assert.equal(drained, true);
  assert.deepEqual(state.requests.list("admin"), before);
  await assert.rejects(state.requests.begin("admin", "Dune", "search"), /已关闭/u);
  await assert.rejects(state.requests.select("admin", before[0].id, { expectedRevision: before[0].revision, media: { type: "movie", title: "Dune", year: 2021 } }), /已关闭/u);
  assert.equal(state.requests.close(), closing);
});

test("close aborts and drains both begin and select searches without admitting their late results", async (t) => {
  const gates = [deferred<SearchResult[]>(), deferred<SearchResult[]>()];
  const entered = deferred<void>();
  const signals: AbortSignal[] = [];
  const { state } = fixture(t, {
    identify: async () => [classic, modern],
    search: async (_query, signal) => {
      const index = signals.length;
      signals.push(signal!);
      if (signals.length === 2) entered.resolve();
      return gates[index].promise;
    },
  });
  const media = await state.requests.begin("admin", "Dune", "download");
  const choice = { expectedRevision: media.revision, candidateId: media.candidates.find(({ media }) => media.year === 2021)!.id };
  const selection = state.requests.select("admin", media.id, choice);
  const duplicate = state.requests.select("admin", media.id, choice);
  const beginning = state.requests.begin("admin", "Dune (2021)", "download");
  const rejected = [selection, duplicate, beginning].map((operation) => assert.rejects(operation, { name: "AbortError" }));
  await entered.promise;
  const before = state.requests.list("admin");
  const closing = state.requests.close();
  let drained = false;
  void closing.then(() => { drained = true; });
  try {
    assert.equal(signals.length, 2);
    assert.ok(signals.every((signal) => signal.aborted));
    gates[0].resolve(results("Dune 2021 1080p"));
    await Promise.all(rejected.slice(0, 2));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(drained, false);
  } finally {
    gates[0].resolve(results("Dune 2021 1080p"));
    gates[1].reject(new Error("fixture late search failure"));
  }
  await Promise.all([...rejected, closing]);
  assert.deepEqual(state.requests.list("admin"), before);
  assert.equal(state.taskCalls, 0);
  assert.equal(state.subscriptionCalls, 0);
  await assert.rejects(state.requests.select("admin", media.id, choice), /已关闭/u);
});

test("closing during a synchronous admission rolls back the task and completion together", async (t) => {
  const { state, actions } = fixture(t, { identify: async () => [modern], search: async () => results("Dune 2021 1080p") });
  const request = await state.requests.begin("admin", "Dune", "search");
  const add = actions.addTask;
  let closing: Promise<void> | undefined;
  actions.addTask = (input) => { const task = add(input); closing = state.requests.close(); return task; };
  await assert.rejects(state.requests.select("admin", request.id, { expectedRevision: request.revision, resourceId: request.resources[0].id }), { name: "AbortError" });
  await closing;
  assert.equal(state.store.list("task").length, 0);
  assert.deepEqual(state.requests.get("admin", request.id), request);
  await assert.rejects(state.requests.begin("admin", "Dune", "download"), /已关闭/u);
});

test("ambiguous season queries stop before providers and resource packs cannot bypass confirmation", async (t) => {
  let identifyCalls = 0;
  let searchCalls = 0;
  let found = results();
  const { state } = fixture(t, {
    identify: async () => {
      identifyCalls++;
      return [{ type: "tv", title: "The Last of Us", year: 2023 }];
    },
    search: async () => {
      searchCalls++;
      return found;
    },
  });
  for (const query of [
    "The Last of Us S01-S02",
    "The Last of Us Season 1-2",
    "The Last of Us 第1-2季",
    "The Last of Us S01E02 03",
    "The Last of Us 第2、3、4集",
  ]) {
    await assert.rejects(
      state.requests.begin("admin", query, "download"),
      /一次指定/u,
    );
  }
  assert.equal(identifyCalls, 0);
  assert.equal(searchCalls, 0);
  assert.deepEqual(state.requests.list("admin"), []);
  assert.equal(state.taskCalls, 0);

  found = results(
    "The.Last.of.Us.2023.S01E03.1080p",
    "The.Last.of.Us.2023.S02E01-E03.1080p",
    "The.Last.of.Us.2023.S02.1080p",
    "The.Last.of.Us.S02E03.1080p",
  );
  const request = await state.requests.begin(
    "admin",
    "The Last of Us S02E03",
    "download",
  );
  assert.equal(request.stage, "resource");
  assert.equal(state.taskCalls, 0);
  const resource = (title: string) => {
    const item = request.resources.find(
      (candidate) => candidate.title === title,
    );
    assert.ok(item, title);
    return item;
  };
  const wrongSeason = resource("The.Last.of.Us.2023.S01E03.1080p");
  const pack = resource("The.Last.of.Us.2023.S02E01-E03.1080p");
  const seasonOnly = resource("The.Last.of.Us.2023.S02.1080p");
  const missingYear = resource("The.Last.of.Us.S02E03.1080p");
  assert.equal(wrongSeason.match, "mismatch");
  assert.equal(pack.match, "mismatch");
  assert.equal(seasonOnly.match, "uncertain");
  assert.equal(missingYear.match, "uncertain");
  for (const item of [wrongSeason, pack]) {
    await assert.rejects(
      state.requests.select("admin", request.id, {
        expectedRevision: request.revision,
        resourceId: item.id,
        confirmUncertain: true,
      }),
      /不匹配/u,
    );
  }
  assert.equal(state.taskCalls, 0);
  const pending = state.requests.get("admin", request.id);
  assert.equal(pending.stage, "resource");
  await assert.rejects(
    state.requests.select("admin", request.id, {
      expectedRevision: pending.revision,
      resourceId: missingYear.id,
    }),
    /不确定/u,
  );
  assert.equal(state.taskCalls, 0);
  const completed = await state.requests.select("admin", request.id, {
    expectedRevision: pending.revision,
    resourceId: missingYear.id,
    confirmUncertain: true,
  });
  assert.equal(completed.stage, "completed");
  assert.equal(state.taskCalls, 1);
  const task = state.store.list<DownloadTask>("task")[0];
  assert.equal(task.media.year, 2023);
  assert.equal(task.media.season, 2);
  assert.equal(task.media.episode, 3);
  assert.equal(task.url, "https://fixture.invalid/3.mp4");

  found = results("The.Last.of.Us.2023.S02E03.1080p");
  const automatic = await state.requests.begin(
    "admin",
    "The.Last.of.Us S02E03",
    "download",
  );
  assert.equal(automatic.stage, "completed");
  assert.equal(state.taskCalls, 2);
  assert.equal(
    state.store.list<DownloadTask>("task")[1].media.episode,
    3,
  );
});
