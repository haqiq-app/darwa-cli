import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

function run(command, args, env) {
  return new Promise(resolvePromise => {
    const child = spawn(command, args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", code => resolvePromise({ code, stdout, stderr }));
  });
}

test("deploy packages a local website and uploads it to the selected project", async t => {
  const root = await mkdtemp(join(tmpdir(), "darwa-cli-test-"));
  const configDirectory = join(root, "config");
  const site = join(root, "my-site");
  await mkdir(configDirectory);
  await mkdir(site);
  await writeFile(join(site, "index.html"), "<h1>Hello Darwa</h1>");
  await writeFile(join(site, ".env"), "SECRET=must-not-upload\n");

  let uploaded = Buffer.alloc(0);
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/api/v1/projects" && request.method === "POST") {
        response.statusCode = 201;
        response.end(JSON.stringify({ slug: "my-site", kind: "web_hosting", runtime: "php", region: "us-east" }));
        return;
      }
      if (request.url === "/api/v1/runtime/projects/my-site/cli-deployments") {
        uploaded = body;
        response.statusCode = 202;
        response.end(JSON.stringify({ id: "deployment-test", status: "queued" }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ detail: "not found" }));
    });
  });
  await new Promise(resolvePromise => server.listen(0, "127.0.0.1", resolvePromise));
  t.after(() => server.close());
  const address = server.address();
  const apiUrl = `http://127.0.0.1:${address.port}/api/v1`;
  await writeFile(
    join(configDirectory, "config.json"),
    JSON.stringify({ apiUrl, token: "test-token" }),
  );

  const cli = resolve("bin/darwa.js");
  const result = await run(process.execPath, [cli, "deploy", site, "--no-wait"], {
    ...process.env,
    DARWA_CONFIG_DIR: configDirectory,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Deployment deployment-test queued/);
  assert.equal(uploaded.subarray(0, 2).toString(), "PK");
  assert.equal(uploaded.includes(Buffer.from("index.html")), true);
  assert.equal(uploaded.includes(Buffer.from("darwa.json")), true);
  assert.equal(uploaded.includes(Buffer.from(".env")), false);
  assert.deepEqual(JSON.parse(await readFile(join(site, "darwa.json"), "utf8")), { project: "my-site" });
});
