// Cloudflare Worker for Ampler Launcher.
//
// - Files smaller than 25 MiB are served by Workers Static Assets (the Worker is not involved).
// - Files of 25 MiB or more are kept out of the asset upload (see .assetsignore) and are stored
//   in the R2 bucket bound as MC_BUCKET by scripts/prepare-mc.mjs. Requests for them do not match
//   a static asset, so they reach this Worker, which reads them from R2.
//   Object keys mirror the URL path, e.g. /mc/eaglerforge/classes.js is stored under the key
//   "mc/eaglerforge/classes.js".

import { contentTypeFor } from "./content-types.js";

const MC_PREFIX = "/mc/";
const DEFAULT_CACHE_CONTROL = "public, max-age=3600";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith(MC_PREFIX)) {
      return serveFromR2(request, env, url);
    }
    // Anything that is not a static asset and not under /mc/ ends up here.
    return env.ASSETS.fetch(request);
  },
};

async function serveFromR2(request, env, url) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  }

  let key;
  try {
    key = decodeURIComponent(url.pathname.slice(1));
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  // A URL that ends with "/" is a directory, so serve its index.html.
  const isDirectoryUrl = key.endsWith("/");
  const objectKey = isDirectoryUrl ? key + "index.html" : key;

  const object = await readObject(env.MC_BUCKET, objectKey, request);
  if (object === null) {
    // "/mc/1.12.2" -> "/mc/1.12.2/" so that relative URLs in index.html resolve correctly.
    if (!isDirectoryUrl && (await env.MC_BUCKET.head(objectKey + "/index.html"))) {
      url.pathname += "/";
      return Response.redirect(url.toString(), 308);
    }
    return new Response("Not Found", { status: 404 });
  }

  return buildResponse(request, object);
}

function readObject(bucket, key, request) {
  if (request.method === "HEAD") {
    return bucket.head(key);
  }
  // Passing the request headers lets R2 handle Range and conditional requests.
  return bucket.get(key, { range: request.headers, onlyIf: request.headers });
}

function buildResponse(request, object) {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", contentTypeFor(object.key));
  }
  if (!headers.has("cache-control")) {
    headers.set("cache-control", DEFAULT_CACHE_CONTROL);
  }
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");

  if (request.method === "HEAD") {
    headers.set("content-length", String(object.size));
    return new Response(null, { status: 200, headers });
  }

  // No body means a conditional request (for example If-None-Match) was not satisfied.
  if (!object.body) {
    return new Response(null, { status: 304, headers });
  }

  let status = 200;
  if (object.range && request.headers.has("range")) {
    status = 206;
    headers.set("content-range", formatContentRange(object.range, object.size));
  }
  return new Response(object.body, { status, headers });
}

function formatContentRange(range, size) {
  let start;
  let end;
  if (range.suffix !== undefined) {
    start = Math.max(0, size - range.suffix);
    end = size - 1;
  } else {
    start = range.offset ?? 0;
    if (range.end !== undefined) {
      end = range.end;
    } else if (range.length !== undefined) {
      end = Math.min(start + range.length - 1, size - 1);
    } else {
      end = size - 1;
    }
  }
  return `bytes ${start}-${end}/${size}`;
}
