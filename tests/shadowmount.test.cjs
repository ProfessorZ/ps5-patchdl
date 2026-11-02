const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");

function browser() {
  const context = vm.createContext({
    document: { addEventListener() {} },
    navigator: { languages: ["en"] },
  });
  vm.runInContext(read("web/i18n.js"), context);
  vm.runInContext(read("web/app.js"), context);
  return (code) => vm.runInContext(code, context);
}

test("ShadowMount offers downloads, resume and versions, never installation", () => {
  const run = browser();
  run("var game = { ...fallback.titles.find(g => g.source_type === 'shadowmount') }");
  assert.equal(run("state.config.install_after_download"), true);
  assert.equal(run("isDownloadAllowed(game)"), true);
  assert.equal(run("isInstallAllowed(game)"), false);
  assert.equal(run("gameCategory(game)"), "updates");
  assert.equal(run("primaryButton(game).action"), "download");
  assert.equal(run("primaryButton(game).label"), "Download");
  assert.equal(run("canPickVersion(game, '01.008.000')"), true);
  assert.doesNotMatch(run("statusPill(game)"), /Not supported/);
  assert.match(run("cardNotesHtml(game)"), /Download only/);

  run("game.resumable = true");
  assert.equal(run("primaryButton(game).label"), "Resume");
  assert.equal(run("canPickVersion(game, '01.008.000')"), false);
  run("game.resumable = false; game.downloaded = true");
  assert.equal(run("primaryButton(game)"), null);
  assert.equal(run("stopButton(game).action"), "cancel");

  run("game.downloaded = false; game.enabled = false");
  assert.equal(run("isDownloadAllowed(game)"), false);
  assert.equal(run("primaryButton(game)"), null);
  run("game.enabled = true; game.patch_title_match = false");
  assert.equal(run("isDownloadAllowed(game)"), false);
});

test("firmware fallback works for ShadowMount and blocked sources stay blocked", () => {
  const run = browser();
  run(`var game = {
    ...fallback.titles.find(g => g.source_type === "shadowmount"),
    compatible_version: null, status: "incompatible_fw",
    prospero_version: "01.008.000",
  }`);
  assert.equal(run("canGetOlderPatch(game)"), true);
  assert.equal(run("primaryButton(game).action"), "guide");
  run("game.saved_versions = [game.prospero_version]");
  assert.equal(run("primaryButton(game).action"), "saved");
  for (const source of ["unknown", "fake"]) {
    run(`game.source_type = "${source}"`);
    assert.equal(run("isDownloadAllowed(game)"), false);
    assert.equal(run("canPickVersion(game, '01.008.000')"), false);
    assert.equal(run("gameCategory(game)"), "blocked");
  }
});

test("completed ShadowMount downloads never auto-install; official updates still do", () => {
  const run = browser();
  run(`var installs = [];
    doInstall = game => installs.push(game.title_id);
    state.titles = [
      { ...fallback.titles.find(g => g.source_type === "shadowmount"), _wasActive: true },
      { ...fallback.titles.find(g => g.source_type === "official"), _wasActive: true },
    ];
    state.downloads = state.titles.map(g => ({ title_id: g.title_id, state: "done" }));
    reconcileFromJobs(state.downloads);`);
  assert.equal(run("state.titles[0].downloaded"), true);
  assert.equal(run("installs.length"), 1);
  assert.equal(run("installs[0]"), run("state.titles[1].title_id"));
});

test("Update all skips download-only games", async () => {
  const run = browser();
  await run(`var queued = [];
    doDownload = async game => queued.push(game.title_id);
    showToast = () => {};
    state.titles = fallback.titles.filter(g => g.status === "available");
    updateAll();`);
  assert.equal(run("queued.includes('PPSA90001_00')"), false);
  assert.equal(run("queued.length > 0"), true);
});

test("download-only completion text exists in every language", () => {
  const run = browser();
  assert.equal(run(`Object.values(I18N).every(dict =>
    Boolean(dict["guide.note.doneDownload"]) && Boolean(dict["source.shadowmount.desc"]))`), true);
});

test("the completed version guide does not suggest installing a ShadowMount update", async () => {
  const run = browser();
  await run(`var message = "";
    var game = fallback.titles.find(g => g.source_type === "shadowmount");
    guide.game = game;
    guide.started = true;
    guideStatus = (kind, text) => { message = text; };
    fetch = async () => ({ ok: true, json: async () => [
      { title_id: game.title_id, state: "done", bytes: 100, total_bytes: 100 }
    ] });
    guidePoll();`);
  assert.match(run("message"), /download folder/);
  assert.doesNotMatch(run("message"), /Press Install|Installing/);
});

test("server reports ShadowMount availability and preserves source restrictions", () => {
  const source = read("src/patchdl_websrv.c");
  const config = source.slice(source.indexOf("static const char config_tail_json[]"),
    source.indexOf("/* tiny JSON lookups"));
  const json = config.match(/"(?:\\.|[^"\\])*"/g).map(s => JSON.parse(s)).join("");
  const policy = JSON.parse("{" + json).source_policy;
  assert.equal(policy.shadowmount.allow_download, true);
  assert.equal(policy.shadowmount.allow_install, false);

  const functions = source.slice(source.indexOf("static const char *\ntitle_status_str"),
    source.indexOf("static char *\nbuild_titles_json"));
  const downloadStart = source.indexOf("    if (!enabled)", source.indexOf(
    "do_download_locked(struct MHD_Connection *conn", source.indexOf("do_download(struct")));
  const downloadGuards = source.slice(downloadStart, source.indexOf("    if (!patch_url[0])", downloadStart));
  const installStart = source.indexOf("    if (!enabled)", source.indexOf("do_install("));
  const installGuards = source.slice(installStart, source.indexOf("    if (!patch_url[0]", installStart));
  const manualStart = source.indexOf("    if (src == PATCHDL_SOURCE_UNKNOWN", source.indexOf("handle_download_url("));
  const manualGuards = source.slice(manualStart, source.indexOf("    /* older than installed", manualStart));
  assert.ok(downloadGuards.length > 0 && installGuards.length > 0 && manualGuards.length > 0);

  const dir = mkdtempSync(path.join(tmpdir(), "patchdl-shadowmount-"));
  try {
    writeFileSync(path.join(dir, "test.c"), `
      #include <assert.h>
      #include <string.h>
      #include "patchdl_scan.h"
      #define MHD_HTTP_FORBIDDEN 403
      #define queue_json(conn, status, body) status
      ${functions}
      static int download(patchdl_source_t src, int enabled) {
        ${downloadGuards}
    return 202;
      }
      static int install(patchdl_source_t src, int enabled) {
        ${installGuards}
    return 202;
      }
      static int manual_download(patchdl_source_t src) {
        ${manualGuards}
    return 202;
      }
      int main(void) {
        patchdl_title_t t = { .source_type = PATCHDL_SOURCE_SHADOWMOUNT };
        assert(!strcmp(title_status_str(&t), "checking"));
        t.verxml_done = 1;
        assert(!strcmp(title_status_str(&t), "no_update"));
        strcpy(t.installed_version, "01.000.000");
        strcpy(t.compatible_version, "01.001.000");
        assert(!strcmp(title_status_str(&t), "available"));
        strcpy(t.installed_version, t.compatible_version);
        assert(!strcmp(title_status_str(&t), "up_to_date"));
        strcpy(t.latest_version, "01.002.000");
        assert(!strcmp(title_status_str(&t), "incompatible_fw"));
        assert(!strcmp(title_mode_str(t.source_type), "download_only"));
        for (int src = PATCHDL_SOURCE_OFFICIAL; src <= PATCHDL_SOURCE_FAKE; src++) {
          assert(download(src, 1) == (src <= PATCHDL_SOURCE_SHADOWMOUNT ? 202 : 403));
          assert(install(src, 1) == (src <= PATCHDL_SOURCE_EXTERNAL ? 202 : 403));
          assert(manual_download(src) == (src <= PATCHDL_SOURCE_SHADOWMOUNT ? 202 : 403));
          assert(download(src, 0) == 403);
          assert(install(src, 0) == 403);
        }
        t.source_type = PATCHDL_SOURCE_FAKE;
        assert(!strcmp(title_status_str(&t), "blocked"));
        t.source_type = PATCHDL_SOURCE_UNKNOWN;
        assert(!strcmp(title_status_str(&t), "blocked"));
      }
    `);
    execFileSync("cc", ["-std=c11", "-Wall", "-Wextra", "-Werror",
      "-I", path.join(root, "src"), path.join(dir, "test.c"), "-o", path.join(dir, "test")]);
    execFileSync(path.join(dir, "test"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
