import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { GitSourceFetcher } from "./git-fetcher.js";
import { CodeSourceRegistry } from "../code-source/registry.js";
import { azureDevOpsHttpOptions } from "../code-source/providers/azure-devops.js";
import { isAzureDevOpsHttpsUrl } from "../../../MemoryPanel/web/src/pages/CodePage/constants/azure-url.js";

describe("Azure DevOps Git authentication", () => {
  let dir: string;
  let server: Server;
  let repoUrl: string;
  let serveRepo = false;
  const expectedAuth = `Basic ${Buffer.from("pat:test-pat").toString("base64")}`;
  const requests: Array<{ url: string; authorization?: string }> = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "azure-git-test-"));
    const key = join(dir, "key.pem");
    const cert = join(dir, "cert.pem");
    const config = join(dir, "openssl.cnf");
    writeFileSync(config, "[req]\ndistinguished_name=dn\n[dn]\n");
    execFileSync("openssl", ["req", "-config", config, "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-keyout", key, "-out", cert], { stdio: "ignore" });
    server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
      requests.push({ url: req.url ?? "", authorization: req.headers.authorization });
      if (serveRepo && req.headers.authorization === expectedAuth) {
        const url = new URL(req.url ?? "/", "https://localhost");
        const child = execFile("git", ["http-backend"], {
          encoding: "buffer",
          maxBuffer: 10 * 1024 * 1024,
          env: { ...process.env, GIT_PROJECT_ROOT: dir, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers["content-type"], CONTENT_LENGTH: req.headers["content-length"] },
        }, (err, stdout) => {
          if (err) { res.writeHead(500); res.end("git http-backend failed"); return; }
          const bytes = stdout as Buffer;
          const split = bytes.indexOf("\r\n\r\n");
          if (split < 0) { res.writeHead(500); res.end("invalid git response"); return; }
          const lines = bytes.subarray(0, split).toString("utf8").split("\r\n");
          let status = 200;
          for (const line of lines) {
            const colon = line.indexOf(":");
            if (colon < 0) continue;
            const name = line.slice(0, colon);
            const value = line.slice(colon + 1).trim();
            if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
            else res.setHeader(name, value);
          }
          res.writeHead(status);
          res.end(bytes.subarray(split + 4));
        });
        req.pipe(child.stdin!);
        return;
      }
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="test"' });
      res.end("Authentication required");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    repoUrl = `https://127.0.0.1:${(server.address() as AddressInfo).port}/project/_git/repo`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("registers Azure DevOps as a PAT source without configuration", () => {
    const source = new CodeSourceRegistry([]).get("azure-devops");
    expect(source?.authMethod.kind).toBe("bearer");
    expect(source?.authMethod.formFields).toEqual([{ name: "secret", secret: true, required: true }]);
  });

  it("uses the PAT for Basic auth and allows verification to be re-enabled", () => {
    vi.stubEnv("CODE_SOURCE_AZURE_DEVOPS_VERIFY_TLS", "false");
    expect(azureDevOpsHttpOptions("test-pat")).toEqual({ authorization: `Authorization: ${expectedAuth}`, verifyTls: false });
    vi.stubEnv("CODE_SOURCE_AZURE_DEVOPS_VERIFY_TLS", "true");
    expect(azureDevOpsHttpOptions("test-pat").verifyTls).toBe(true);
    vi.unstubAllEnvs();
  });

  it("accepts Azure Repos clone URLs in the registration form", () => {
    expect(isAzureDevOpsHttpsUrl("https://dev.azure.com/org/project/_git/repo")).toBe(true);
    expect(isAzureDevOpsHttpsUrl("https://tfs:8443/tfs/collection/project/_git/my%20repo")).toBe(true);
    expect(isAzureDevOpsHttpsUrl("http://tfs/project/_git/repo")).toBe(false);
    expect(isAzureDevOpsHttpsUrl("https://tfs/project/_git/repo name")).toBe(false);
  });

  it("rejects a self-signed certificate when verification is enabled", async () => {
    requests.length = 0;
    const fetcher = new GitSourceFetcher({ ssrfCheck: false });
    await expect(fetcher.fetch(repoUrl, "main", join(dir, "verify-on"), {
      http: { authorization: "Authorization: Basic dGVzdA==", verifyTls: true },
    })).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });

  it("sends the scoped authorization header when verification is disabled", async () => {
    requests.length = 0;
    const fetcher = new GitSourceFetcher({ ssrfCheck: false });
    const authorization = `Basic ${Buffer.from("pat:test-pat").toString("base64")}`;
    const error = await fetcher.fetch(repoUrl, "main", join(dir, "verify-off"), {
      http: { authorization: `Authorization: ${authorization}`, verifyTls: false },
    }).catch((err: Error) => err);
    expect(error).toBeInstanceOf(Error); // Server intentionally returns 401.
    expect(requests.length).toBeGreaterThan(0);
    expect(requests[0].authorization).toBe(authorization);
    expect(requests[0].url).not.toContain("test-pat");
    expect(repoUrl).not.toContain("test-pat");
  }, 30_000);

  it("clones and syncs a private Git repo over self-signed HTTPS without storing the PAT in origin", async () => {
    const bare = join(dir, "project", "_git", "repo");
    const work = join(dir, "work");
    const cloned = join(dir, "cloned");
    mkdirSync(join(dir, "project", "_git"), { recursive: true });
    mkdirSync(work);
    execFileSync("git", ["init", "--bare", bare]);
    execFileSync("git", ["init", "-b", "main"], { cwd: work });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: work });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: work });
    writeFileSync(join(work, "file.txt"), "first");
    execFileSync("git", ["add", "file.txt"], { cwd: work });
    execFileSync("git", ["commit", "-m", "first"], { cwd: work });
    execFileSync("git", ["push", bare, "main"], { cwd: work });
    serveRepo = true;
    const fetcher = new GitSourceFetcher({ ssrfCheck: false });
    const options = { http: { authorization: `Authorization: ${expectedAuth}`, verifyTls: false } };
    await fetcher.fetch(repoUrl, "main", cloned, options);
    expect(readFileSync(join(cloned, "file.txt"), "utf8")).toBe("first");
    expect(readFileSync(join(cloned, ".git", "config"), "utf8")).not.toContain("test-pat");
    writeFileSync(join(work, "file.txt"), "second");
    execFileSync("git", ["add", "file.txt"], { cwd: work });
    execFileSync("git", ["commit", "-m", "second"], { cwd: work });
    execFileSync("git", ["push", bare, "main"], { cwd: work });
    await fetcher.sync(repoUrl, "main", cloned, options);
    expect(readFileSync(join(cloned, "file.txt"), "utf8")).toBe("second");
    expect(readFileSync(join(cloned, ".git", "config"), "utf8")).not.toContain("test-pat");
  }, 30_000);
});
