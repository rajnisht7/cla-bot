/**
 * End-to-end smoke tests for the CLI entrypoint.
 *
 * Every other test file requires src/cla-bot.js as a module, which never
 * exercises main() or the `if (require.main === module)` guard at the
 * bottom of the file (see the comment there - the whole point is that
 * requiring the file must NOT auto-run it). Those lines were previously
 * 100% uncovered.
 *
 * This file instead spawns `node src/cla-bot.js` as a real subprocess -
 * the same way the GitHub Actions runner invokes it - pointed at a local
 * HTTP server via GITHUB_API_URL (an existing, real override the code
 * already supports; see `const GITHUB_API = process.env.GITHUB_API_URL ||
 * ...`) instead of the real GitHub API.
 */

const assert = require("node:assert");
const http = require("node:http");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(REPO_ROOT, "src", "cla-bot.js");

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS: ${name}`);
  } catch (e) {
    process.exitCode = 1;
    console.error(`FAIL: ${name}\n${e && e.stack ? e.stack : e}`);
  }
}

function writeTempEventFile(payload) {
  const file = path.join(
    os.tmpdir(),
    `cla-bot-e2e-event-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  fs.writeFileSync(file, JSON.stringify(payload));
  return file;
}

function runScript(env, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`script did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// A minimal fake GitHub API, just enough to let a full run complete.
function startFakeGitHub({ authorAlreadySigned }) {
  const requestsSeen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requestsSeen.push({ method: req.method, url: req.url });
      const send = (status, obj) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(obj === null ? "" : JSON.stringify(obj));
      };
      if (req.url.includes("/pulls/1/commits")) {
        return send(200, [
          {
            sha: "e2e-commit-sha",
            author: { id: 42, login: "e2e-author" },
            committer: { id: 42 },
            parents: [{ sha: "parent" }],
            commit: {
              author: { email: "e2e-author@example.com" },
              verification: { verified: false },
            },
          },
        ]);
      }
      if (req.url.includes("/pulls/1") && !req.url.includes("/commits")) {
        return send(200, { head: { sha: "e2e-head-sha" } });
      }
      if (req.url.includes("/contents/signatures/cla.json")) {
        if (req.method === "GET") {
          const signatures = authorAlreadySigned
            ? [{ id: 42, login: "e2e-author" }]
            : [];
          const content = Buffer.from(
            JSON.stringify({ version: 1, signatures }),
          ).toString("base64");
          return send(200, { sha: "sig-sha", content, encoding: "base64" });
        }
        if (req.method === "PUT") {
          return send(200, { content: { sha: "sig-sha-2" } });
        }
      }
      if (req.url.includes("/statuses/")) {
        return send(201, {});
      }
      if (req.url.includes("/issues/1/comments")) {
        if (req.method === "GET") return send(200, []);
        if (req.method === "POST") return send(201, { id: 1, body: "" });
      }
      if (/\/user$/.test(req.url)) {
        return send(404, { message: "Not Found" }); // forces the default bot-login fallback
      }
      // Anything unexpected: fail loudly so a broken assumption in this
      // fake server is obvious rather than silently hanging the child.
      return send(500, {
        message: `e2e fake server: unhandled ${req.method} ${req.url}`,
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        requestsSeen,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function baseEnv(apiUrl) {
  return {
    GITHUB_API_URL: apiUrl,
    GITHUB_TOKEN: "e2e-fake-token",
    GITHUB_REPOSITORY: "fossasia/e2e-test-repo",
    SIG_OWNER: "fossasia",
    SIG_REPO: "cla-signatures",
    SIG_PATH: "signatures/cla.json",
    CLA_DOCUMENT_URL: "https://example.com/CLA.md",
    ALLOWLIST: "",
  };
}

(async () => {
  await test("main() runs a full pull_request_target 'opened' event end-to-end via the real CLI entrypoint and exits 0 (author already signed -> success)", async () => {
    const server = await startFakeGitHub({ authorAlreadySigned: true });
    const eventFile = writeTempEventFile({
      action: "opened",
      pull_request: { number: 1, head: { sha: "e2e-head-sha" } },
    });
    try {
      const { code, stderr } = await runScript({
        ...baseEnv(server.url),
        GITHUB_EVENT_NAME: "pull_request_target",
        GITHUB_EVENT_PATH: eventFile,
      });
      assert.strictEqual(
        code,
        0,
        `expected exit code 0, got ${code}. stderr:\n${stderr}`,
      );
      assert.ok(
        server.requestsSeen.some((r) => r.url.includes("/statuses/")),
        "expected the real CLI run to have posted a commit status",
      );
    } finally {
      await server.close();
      fs.unlinkSync(eventFile);
    }
  });

  await test("main() does nothing but still exits 0 for an event type it doesn't handle (e.g. 'push')", async () => {
    const server = await startFakeGitHub({ authorAlreadySigned: true });
    const eventFile = writeTempEventFile({ ref: "refs/heads/main" });
    try {
      const { code, stdout } = await runScript({
        ...baseEnv(server.url),
        GITHUB_EVENT_NAME: "push",
        GITHUB_EVENT_PATH: eventFile,
      });
      assert.strictEqual(code, 0);
      assert.ok(
        /Nothing to do for event "push"/.test(stdout),
        `expected the "nothing to do" log line, got stdout:\n${stdout}`,
      );
      assert.strictEqual(
        server.requestsSeen.length,
        0,
        "an unhandled event type must not make any GitHub API calls at all",
      );
    } finally {
      await server.close();
      fs.unlinkSync(eventFile);
    }
  });

  await test("the CLI entrypoint fails loudly and exits non-zero when GITHUB_EVENT_PATH doesn't point to a real file", async () => {
    const { code, stderr } = await runScript({
      ...baseEnv("http://127.0.0.1:1"), // unused - fails before any network call
      GITHUB_EVENT_NAME: "pull_request_target",
      GITHUB_EVENT_PATH: "/nonexistent/path/to/event.json",
    });
    assert.notStrictEqual(code, 0, "expected a non-zero exit code");
    assert.ok(
      /GITHUB_EVENT_PATH not found/.test(stderr),
      `expected a specific error about the missing event file, got stderr:\n${stderr}`,
    );
  });

  await test("main() runs a full issue_comment 'created' (sign phrase) event end-to-end via the real CLI entrypoint and exits 0", async () => {
    const server = await startFakeGitHub({ authorAlreadySigned: false });
    const eventFile = writeTempEventFile({
      action: "created",
      issue: {
        number: 1,
        pull_request: {},
        user: { login: "e2e-author" },
      },
      comment: {
        user: { id: 42, login: "e2e-author" },
        body: "I have read the CLA Document and I hereby sign the CLA",
        html_url: "https://example.com/comment",
        author_association: "NONE",
      },
    });
    try {
      const { code, stderr } = await runScript({
        ...baseEnv(server.url),
        GITHUB_EVENT_NAME: "issue_comment",
        GITHUB_EVENT_PATH: eventFile,
      });
      assert.strictEqual(
        code,
        0,
        `expected exit code 0, got ${code}. stderr:\n${stderr}`,
      );
      assert.ok(
        server.requestsSeen.some(
          (r) =>
            r.method === "PUT" &&
            r.url.includes("/contents/signatures/cla.json"),
        ),
        "expected the sign phrase to result in a real write to the signatures file",
      );
    } finally {
      await server.close();
      fs.unlinkSync(eventFile);
    }
  });

  await test("the Node-version guard fails loudly on an unsupported Node major version instead of hitting a confusing 'fetch is not defined' later", async () => {
    // src/cla-bot.js checks process.versions.node at require-time and exits
    // immediately on an unsupported major version. We can't literally run
    // this repo on Node 18 here, but process.versions.node is a plain,
    // overridable property - so a tiny wrapper script sets it to look like
    // an old Node before requiring the real file, exercising the exact
    // same code path a real old-Node run would hit.
    const wrapper = path.join(
      os.tmpdir(),
      `cla-bot-e2e-oldnode-wrapper-${Date.now()}.js`,
    );
    fs.writeFileSync(
      wrapper,
      [
        "Object.defineProperty(process, 'version', { value: 'v18.19.0', configurable: true });",
        "Object.defineProperty(process.versions, 'node', { value: '18.19.0', configurable: true });",
        `require(${JSON.stringify(SCRIPT)});`,
      ].join("\n"),
    );
    try {
      const { code, stderr } = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [wrapper], {
          cwd: REPO_ROOT,
          env: { ...process.env, ...baseEnv("http://127.0.0.1:1") },
        });
        let stderrOut = "";
        child.stderr.on("data", (d) => (stderrOut += d));
        child.on("error", reject);
        child.on("close", (c) => resolve({ code: c, stderr: stderrOut }));
      });
      assert.notStrictEqual(
        code,
        0,
        "expected a non-zero exit code on an unsupported Node version",
      );
      assert.ok(
        /requires Node\.js >= 22/.test(stderr),
        `expected a specific version-requirement error, got stderr:\n${stderr}`,
      );
    } finally {
      fs.unlinkSync(wrapper);
    }
  });

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error("\nSOME TESTS FAILED.");
    process.exit(1);
  } else {
    console.log("ALL TESTS PASSED.");
  }
})();
