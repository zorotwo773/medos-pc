import { createServer, request as httpRequest } from "node:http";
import { isIP } from "node:net";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const HOST = "0.0.0.0";
const PORT = 3000;
const DENIED_BODY = '{"detail":"network access denied"}';
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const INTERNAL_ADMISSION_PATH = "/network/access/internal-admit";
const BACKEND_HOST = "127.0.0.1";
const BACKEND_PORT = 8002;
const ADMISSION_TIMEOUT_MS = 1000;
const FORWARDED_CLIENT_HEADER = "x-medos-forwarded-client";
const INTERNAL_TOKEN_HEADER = "x-medos-internal-token";
const UNTRUSTED_FORWARDING_HEADERS = new Set([
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-real-ip",
  FORWARDED_CLIENT_HEADER,
  INTERNAL_TOKEN_HEADER,
]);

export function requireStrongForwardToken(value) {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) {
    throw new Error("MedOS internal forwarding token is unavailable");
  }
  return value;
}

export function requireProductionEnvironment(environment) {
  if (environment?.NODE_ENV !== "production") {
    throw new Error("MedOS production mode is required");
  }
}

export function forceProductionCliEnvironment(environment) {
  environment.NODE_ENV = "production";
}

export function normalizeClientAddress(rawValue) {
  if (
    typeof rawValue !== "string" ||
    rawValue.length === 0 ||
    rawValue !== rawValue.trim() ||
    rawValue.includes(",") ||
    rawValue.includes("%") ||
    rawValue.startsWith("[") ||
    [...rawValue].some((character) => character.charCodeAt(0) < 33 || character.charCodeAt(0) === 127)
  ) {
    return null;
  }
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(rawValue);
  const candidate = mapped ? mapped[1] : rawValue.toLowerCase();
  return isIP(candidate) ? candidate : null;
}

function ipv4Bytes(address) {
  return address.split(".").map((part) => Number(part));
}

function isPrivateAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = ipv4Bytes(address);
    return (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  return (
    address === "::1" ||
    /^f[cd][0-9a-f]{2}:/i.test(address) ||
    /^fe[89ab][0-9a-f]:/i.test(address)
  );
}

function isValidPublicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = ipv4Bytes(address);
    if (a === 0 || a >= 224 || a === 127 || (a === 169 && b === 254)) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 192 && b === 0 && c === 0) return false;
    if (a === 192 && b === 0 && c === 2) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  return address !== "::" && !address.startsWith("ff") && !/^2001:db8:/i.test(address);
}

export function clientIsAllowed(rawValue, allowPublic) {
  const address = normalizeClientAddress(rawValue);
  if (!address) return false;
  if (isPrivateAddress(address)) return true;
  return allowPublic === true && isValidPublicAddress(address);
}

function isForwardingHeader(name) {
  return UNTRUSTED_FORWARDING_HEADERS.has(String(name).toLowerCase());
}

export function applyAuthoritativeForwardingHeaders(request, rawPeer, token) {
  const peer = normalizeClientAddress(rawPeer);
  if (!peer) throw new Error("request socket peer is invalid");
  const trustedToken = requireStrongForwardToken(token);

  for (const name of Object.keys(request.headers ?? {})) {
    if (isForwardingHeader(name)) delete request.headers[name];
  }
  request.headers ??= {};
  request.headers[FORWARDED_CLIENT_HEADER] = peer;
  request.headers[INTERNAL_TOKEN_HEADER] = trustedToken;

  const retainedRawHeaders = [];
  const rawHeaders = Array.isArray(request.rawHeaders) ? request.rawHeaders : [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if (!isForwardingHeader(rawHeaders[index])) {
      retainedRawHeaders.push(rawHeaders[index], rawHeaders[index + 1]);
    }
  }
  retainedRawHeaders.push(
    "X-MedOS-Forwarded-Client",
    peer,
    "X-MedOS-Internal-Token",
    trustedToken,
  );
  request.rawHeaders = retainedRawHeaders;
  return peer;
}

function denyHttp(response) {
  response.writeHead(403, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(DENIED_BODY),
    "cache-control": "no-store",
  });
  response.end(DENIED_BODY);
}

export function backendAdmitsPublicClient(
  rawPeer,
  token,
  { requestFactory = httpRequest, timeoutMs = ADMISSION_TIMEOUT_MS } = {},
) {
  const peer = normalizeClientAddress(rawPeer);
  const safeToken = requireStrongForwardToken(token);
  if (!peer || !clientIsAllowed(peer, true) || clientIsAllowed(peer, false)) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value === true);
      }
    };
    let request;
    try {
      request = requestFactory(
        {
          hostname: BACKEND_HOST,
          port: BACKEND_PORT,
          path: INTERNAL_ADMISSION_PATH,
          method: "GET",
          agent: false,
          headers: {
            [FORWARDED_CLIENT_HEADER]: peer,
            [INTERNAL_TOKEN_HEADER]: safeToken,
            connection: "close",
          },
        },
        (response) => {
          let bodySeen = false;
          response.on("data", () => { bodySeen = true; });
          response.on("end", () => finish(response.statusCode === 204 && !bodySeen));
          response.on("error", () => finish(false));
          response.resume();
        },
      );
      request.on("error", () => finish(false));
      request.setTimeout(timeoutMs, () => {
        request.destroy();
        finish(false);
      });
      request.end();
    } catch {
      if (request?.destroy) request.destroy();
      finish(false);
    }
  });
}

async function peerIsAdmitted(peer, token, admitPublicClient) {
  if (!peer || !clientIsAllowed(peer, true)) return false;
  if (clientIsAllowed(peer, false)) return true;
  try {
    return (await admitPublicClient(peer, token)) === true;
  } catch {
    return false;
  }
}

export function createMedosRequestListener({
  token,
  requestHandler,
  admitPublicClient = backendAdmitsPublicClient,
}) {
  const safeToken = requireStrongForwardToken(token);
  if (typeof requestHandler !== "function") throw new TypeError("request handler is required");
  if (typeof admitPublicClient !== "function") throw new TypeError("public admission handler is required");

  return async function medosRequestListener(request, response) {
    const peer = normalizeClientAddress(request?.socket?.remoteAddress);
    if (!(await peerIsAdmitted(peer, safeToken, admitPublicClient))) {
      denyHttp(response);
      return;
    }
    applyAuthoritativeForwardingHeaders(request, peer, safeToken);
    try {
      await requestHandler(request, response);
    } catch {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "text/plain", "cache-control": "no-store" });
      }
      response.end("MedOS frontend request failed");
    }
  };
}

export function createMedosUpgradeListener({
  token,
  upgradeHandler,
  admitPublicClient = backendAdmitsPublicClient,
}) {
  const safeToken = requireStrongForwardToken(token);
  if (typeof upgradeHandler !== "function") throw new TypeError("upgrade handler is required");
  if (typeof admitPublicClient !== "function") throw new TypeError("public admission handler is required");

  return async function medosUpgradeListener(request, socket, head) {
    const peer = normalizeClientAddress(request?.socket?.remoteAddress);
    if (!(await peerIsAdmitted(peer, safeToken, admitPublicClient))) {
      socket.destroy();
      return;
    }
    applyAuthoritativeForwardingHeaders(request, peer, safeToken);
    try {
      await upgradeHandler(request, socket, head);
    } catch {
      socket.destroy();
    }
  };
}

export function createMedosBoundaryServer(options) {
  const server = createServer(createMedosRequestListener(options));
  server.on("upgrade", createMedosUpgradeListener(options));
  return server;
}

export async function startMedosServer({ environment = process.env, nextFactory } = {}) {
  requireProductionEnvironment(environment);
  const token = requireStrongForwardToken(environment.MEDOS_INTERNAL_FORWARD_TOKEN);
  const makeNext = nextFactory ?? (await import("next")).default;

  // Next 16's documented custom-server API accepts an existing httpServer. Give
  // Next an unbound server for its internal upgrade registration, while the
  // externally listening server below remains the raw-address security boundary.
  const nextUpgradeRegistrationServer = createServer();
  const nextApp = makeNext({
    dev: false,
    dir: APP_DIR,
    hostname: HOST,
    port: PORT,
    httpServer: nextUpgradeRegistrationServer,
  });
  await nextApp.prepare();
  const server = createMedosBoundaryServer({
    token,
    requestHandler: nextApp.getRequestHandler(),
    upgradeHandler: nextApp.getUpgradeHandler(),
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, HOST, resolve);
  });
  console.log(`MedOS frontend listening on http://${HOST}:${PORT}`);
  return { server, nextApp };
}

function isDirectInvocation() {
  return Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url;
}

if (isDirectInvocation()) {
  const productionInvocation = process.argv.length === 3 && process.argv[2] === "--production";
  if (productionInvocation) forceProductionCliEnvironment(process.env);
  (productionInvocation ? startMedosServer() : Promise.reject(new Error("invalid launch mode"))).catch((error) => {
    // Keep the real reason in frontend.err. npm only reports "exit 1" otherwise,
    // which made a missing internal token look like an unexplained npm failure.
    console.error("MedOS frontend could not start safely:", error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
