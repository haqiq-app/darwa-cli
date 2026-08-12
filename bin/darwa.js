#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir, hostname, platform } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { deflateRawSync } from "node:zlib";

const VERSION = "0.1.0";
const DEFAULT_API = "https://api.darwa.com/api/v1";
const CONFIG_DIR = process.env.DARWA_CONFIG_DIR || join(homedir(), ".config", "darwa");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const PROJECT_FILE = "darwa.json";
const DEFAULT_IGNORES = new Set([".git", ".next", ".nuxt", ".output", ".turbo", "node_modules", "dist", "build", "coverage", ".env", ".env.local"]);

class CliError extends Error {
  constructor(message, exitCode = 1) { super(message); this.exitCode = exitCode; }
}

function out(message = "") { process.stdout.write(`${message}\n`); }
function err(message = "") { process.stderr.write(`${message}\n`); }
function sleep(ms) { return new Promise(resolvePromise => setTimeout(resolvePromise, ms)); }
function apiBase(config = {}) { return String(process.env.DARWA_API_URL || config.apiUrl || DEFAULT_API).replace(/\/$/, ""); }

async function loadConfig() {
  try { return JSON.parse(await readFile(CONFIG_FILE, "utf8")); }
  catch { return {}; }
}

async function saveConfig(config) {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(CONFIG_FILE, 0o600).catch(() => undefined);
}

function flags(args) {
  const values = { _: [] };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) { values._.push(value); continue; }
    const [rawKey, inline] = value.slice(2).split("=", 2);
    if (inline !== undefined) values[rawKey] = inline;
    else if (args[index + 1] && !args[index + 1].startsWith("--")) values[rawKey] = args[++index];
    else values[rawKey] = true;
  }
  return values;
}

async function request(path, { token, apiUrl, body, headers = {}, ...init } = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(body && !(body instanceof Uint8Array) ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body && !(body instanceof Uint8Array) ? JSON.stringify(body) : body,
  }).catch(cause => { throw new CliError(`Could not reach ${apiUrl}: ${cause.message}`); });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const detail = payload.detail;
    const message = typeof detail === "string" ? detail : detail?.message || `Request failed (${response.status})`;
    if (response.status === 401) throw new CliError("Your CLI session has expired. Run `darwa login` again.");
    throw new CliError(message);
  }
  return response.status === 204 ? null : response.json();
}

async function authenticated() {
  const config = await loadConfig();
  if (!config.token) throw new CliError("Sign in first with `darwa login`.");
  return { config, token: config.token, apiUrl: apiBase(config) };
}

function openBrowser(url) {
  const command = platform() === "darwin" ? ["open", [url]] : platform() === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  const child = spawn(command[0], command[1], { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}

async function login(args) {
  const options = flags(args);
  const current = await loadConfig();
  const apiUrl = String(options.api || apiBase(current)).replace(/\/$/, "");
  const started = await request("/auth/cli/start", {
    apiUrl, method: "POST", body: { client_name: `Darwa CLI on ${hostname()}` },
  });
  out("Opening your browser to authorize the Darwa CLI…");
  out(started.verification_uri);
  if (!options["no-browser"]) openBrowser(started.verification_uri);
  const deadline = Date.now() + started.expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep(Math.max(1, started.interval) * 1000);
    const result = await request("/auth/cli/token", {
      apiUrl, method: "POST", body: { device_code: started.device_code },
    });
    if (result.status !== "authorized") continue;
    await saveConfig({ ...current, apiUrl, token: result.access_token, user: result.user, expiresAt: Date.now() + result.expires_in * 1000 });
    out(`✓ Logged in as ${result.user.email}`);
    return;
  }
  throw new CliError("Authorization expired. Run `darwa login` again.");
}

async function logout() {
  const config = await loadConfig();
  if (config.token) await request("/auth/signout", { apiUrl: apiBase(config), token: config.token, method: "POST" }).catch(() => undefined);
  await saveConfig({ apiUrl: config.apiUrl });
  out("✓ Logged out");
}

async function whoami() {
  const auth = await authenticated();
  const user = await request("/auth/me", auth);
  out(`${user.full_name} <${user.email}>`);
}

function slugify(value) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 100) || "website";
}

async function listProjects() {
  const auth = await authenticated();
  const result = await request("/projects?limit=100", auth);
  if (!result.items.length) { out("No projects yet. Run `darwa projects create <name>`."); return; }
  const rows = result.items.map(item => [item.slug, item.kind, item.runtime, item.status, item.url || "—"]);
  const widths = ["PROJECT", "TYPE", "RUNTIME", "STATUS", "URL"].map((heading, index) => Math.max(heading.length, ...rows.map(row => row[index].length)));
  const print = row => out(row.map((cell, index) => cell.padEnd(widths[index])).join("  "));
  print(["PROJECT", "TYPE", "RUNTIME", "STATUS", "URL"]); print(widths.map(width => "-".repeat(width))); rows.forEach(print);
}

function detectRuntime(directory) {
  if (existsSync(join(directory, "Dockerfile"))) return "docker";
  if (existsSync(join(directory, "package.json"))) return "node";
  if (existsSync(join(directory, "composer.json")) || existsSync(join(directory, "index.php"))) return "php";
  if (existsSync(join(directory, "requirements.txt")) || existsSync(join(directory, "pyproject.toml"))) return "python";
  if (existsSync(join(directory, "index.html"))) return "php";
  return "node";
}

async function createProject(args) {
  const options = flags(args); const name = options._.join(" ").trim();
  if (!name) throw new CliError("Usage: darwa projects create <name> [--runtime node|php|python|docker]");
  const auth = await authenticated();
  const project = await request("/projects", { ...auth, method: "POST", body: {
    name, slug: String(options.slug || slugify(name)), kind: String(options.kind || "web_hosting"),
    runtime: String(options.runtime || detectRuntime(process.cwd())), region: String(options.region || "us-east"),
    instance_type: String(options.plan || "starter"),
  }});
  out(`✓ Created ${project.slug}`); out(`  ${project.kind} · ${project.runtime} · ${project.region}`);
}

async function deleteProject(args) {
  const options = flags(args); const slug = options._[0];
  if (!slug) throw new CliError("Usage: darwa projects delete <project> --yes");
  if (!options.yes) throw new CliError("Deletion is permanent. Re-run with --yes.");
  const auth = await authenticated();
  await request(`/projects/${encodeURIComponent(slug)}`, { ...auth, method: "DELETE" });
  out(`✓ Deleted ${slug}`);
}

const crcTable = Array.from({ length: 256 }, (_, number) => {
  let value = number; for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1; return value >>> 0;
});
function crc32(buffer) { let crc = 0xffffffff; for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function dosTime(date) { return ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((date.getSeconds() / 2) & 31); }
function dosDate(date) { return (((Math.max(1980, date.getFullYear()) - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31); }
function u16(value) { const buffer = Buffer.alloc(2); buffer.writeUInt16LE(value); return buffer; }
function u32(value) { const buffer = Buffer.alloc(4); buffer.writeUInt32LE(value >>> 0); return buffer; }

async function sourceFiles(root) {
  const custom = existsSync(join(root, ".darwaignore")) ? (await readFile(join(root, ".darwaignore"), "utf8")).split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#")) : [];
  const ignored = path => path.split("/").some(part => DEFAULT_IGNORES.has(part)) || custom.some(pattern => path === pattern || path.startsWith(`${pattern.replace(/\/$/, "")}/`));
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name); const name = relative(root, absolute).split(sep).join("/");
      if (ignored(name) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(absolute); else if (entry.isFile()) files.push({ absolute, name, info: await stat(absolute) });
    }
  }
  await walk(root); return files;
}

async function zipDirectory(root) {
  const local = []; const central = []; let offset = 0; let expanded = 0;
  for (const file of await sourceFiles(root)) {
    const input = await readFile(file.absolute); expanded += input.length;
    if (expanded > 250 * 1024 * 1024) throw new CliError("Project exceeds the 250 MB expanded source limit.");
    const compressed = deflateRawSync(input); const name = Buffer.from(file.name); const crc = crc32(input); const time = dosTime(file.info.mtime); const date = dosDate(file.info.mtime);
    const header = Buffer.concat([u32(0x04034b50), u16(20), u16(0), u16(8), u16(time), u16(date), u32(crc), u32(compressed.length), u32(input.length), u16(name.length), u16(0), name]);
    local.push(header, compressed);
    central.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(8), u16(time), u16(date), u32(crc), u32(compressed.length), u32(input.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name]));
    offset += header.length + compressed.length;
  }
  if (!central.length) throw new CliError("No deployable files found in this directory.");
  const centralBuffer = Buffer.concat(central); const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(centralBuffer.length), u32(offset), u16(0)]);
  const archive = Buffer.concat([...local, centralBuffer, end]);
  if (archive.length > 50 * 1024 * 1024) throw new CliError("Compressed project exceeds the 50 MB upload limit. Add files to .darwaignore.");
  return archive;
}

async function projectManifest(directory) {
  try { return JSON.parse(await readFile(join(directory, PROJECT_FILE), "utf8")); } catch { return {}; }
}

async function deploy(args) {
  const options = flags(args); const directory = resolve(options._[0] || "."); const auth = await authenticated();
  const manifest = await projectManifest(directory); let slug = String(options.project || manifest.project || "");
  if (!slug) {
    const name = basename(directory); slug = slugify(name);
    out(`No ${PROJECT_FILE} found. Creating ${slug}…`);
    const created = await request("/projects", { ...auth, method: "POST", body: {
      name, slug, kind: "web_hosting", runtime: detectRuntime(directory), region: String(options.region || "us-east"), instance_type: String(options.plan || "starter"),
    }});
    slug = created.slug;
    await writeFile(join(directory, PROJECT_FILE), `${JSON.stringify({ project: slug }, null, 2)}\n`);
  }
  out(`Packaging ${relative(process.cwd(), directory) || "."}…`); const archive = await zipDirectory(directory);
  out(`Uploading ${(archive.length / 1024 / 1024).toFixed(2)} MB to ${slug}…`);
  const deployment = await request(`/runtime/projects/${encodeURIComponent(slug)}/cli-deployments${options["clear-cache"] ? "?clear_cache=true" : ""}`, {
    ...auth, method: "POST", body: new Uint8Array(archive), headers: { "Content-Type": "application/zip" },
  });
  out(`✓ Deployment ${deployment.id} queued`);
  if (options.wait === false || options["no-wait"]) return;
  let status = deployment.status;
  while (!["live", "failed", "stopped"].includes(status)) {
    await sleep(4000); const latest = await request(`/runtime/projects/${encodeURIComponent(slug)}/deployments/latest`, auth);
    if (latest.status !== status) { status = latest.status; out(`  ${status}`); }
    if (status === "failed") throw new CliError(latest.failure_reason || "Deployment failed.");
  }
  const project = await request(`/projects/${encodeURIComponent(slug)}`, auth);
  out(project.url ? `✓ Live at ${project.url}` : "✓ Deployment is live");
}

function help() {
  out(`Darwa CLI ${VERSION}\n\nUsage:\n  darwa login [--api URL]\n  darwa logout\n  darwa whoami\n  darwa projects list\n  darwa projects create <name> [--runtime node|php|python|docker] [--plan starter]\n  darwa projects delete <project> --yes\n  darwa deploy [directory] [--project slug] [--clear-cache] [--no-wait]\n\nEnvironment:\n  DARWA_API_URL       Override the API endpoint\n  DARWA_CONFIG_DIR     Override credential storage`);
}

async function main() {
  const [command, subcommand, ...rest] = process.argv.slice(2);
  if (!command || ["help", "--help", "-h"].includes(command)) return help();
  if (["--version", "-v", "version"].includes(command)) return out(VERSION);
  if (command === "login") return login([subcommand, ...rest].filter(Boolean));
  if (command === "logout") return logout();
  if (command === "whoami") return whoami();
  if (command === "deploy") return deploy([subcommand, ...rest].filter(Boolean));
  if (command === "projects" && subcommand === "list") return listProjects();
  if (command === "projects" && subcommand === "create") return createProject(rest);
  if (command === "projects" && subcommand === "delete") return deleteProject(rest);
  throw new CliError(`Unknown command. Run \`darwa help\`.`);
}

main().catch(cause => { err(`Error: ${cause.message}`); process.exitCode = cause.exitCode || 1; });
