const ALLOWED_KINDS = new Set(["project", "system-video", "content-video"]);
const MAX_JSON_BYTES = 1024 * 1024;
const TOKEN_TTL_SECONDS = 8 * 60 * 60;
const CLOUDINARY_PUBLIC_ID_PREFIX = "zazobrain/";

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const configured = String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter(Boolean);
  const allowed = new Set([
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    ...configured,
  ]);
  const normalizedOrigin = origin?.replace(/\/$/, "");
  const headers = {
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
  };
  if (origin && allowed.has(normalizedOrigin)) headers["Access-Control-Allow-Origin"] = origin;
  return { headers, originAllowed: !origin || allowed.has(normalizedOrigin) };
}

function withHeaders(response, headers) {
  const merged = new Headers(response.headers);
  for (const [key, value] of Object.entries(headers)) merged.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: merged });
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlDecode(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmacKey(secret, usages) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usages);
}

async function signToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const expires = now + TOKEN_TTL_SECONDS;
  const header = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ sub: "admin", iat: now, exp: expires })));
  const unsigned = `${header}.${payload}`;
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(env.SESSION_SECRET, ["sign"]), new TextEncoder().encode(unsigned)));
  return { token: `${unsigned}.${base64UrlEncode(signature)}`, expiresAt: new Date(expires * 1000).toISOString() };
}

async function verifyToken(request, env) {
  const match = (request.headers.get("Authorization") || "").match(/^Bearer\s+([^\s]+)$/i);
  if (!match || !env.SESSION_SECRET) return false;
  try {
    const parts = match[1].split(".");
    if (parts.length !== 3) return false;
    const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0])));
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));
    if (header.alg !== "HS256" || header.typ !== "JWT" || payload.sub !== "admin" || !Number.isFinite(payload.exp)) return false;
    if (payload.exp <= Math.floor(Date.now() / 1000)) return false;
    return await crypto.subtle.verify("HMAC", await hmacKey(env.SESSION_SECRET, ["verify"]), base64UrlDecode(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch {
    return false;
  }
}

async function readJson(request) {
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > MAX_JSON_BYTES) throw Object.assign(new Error("Request body is too large."), { status: 413, code: "BODY_TOO_LARGE" });
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) throw Object.assign(new Error("Request body is too large."), { status: 413, code: "BODY_TOO_LARGE" });
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object.");
    return value;
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), { status: 400, code: "INVALID_JSON" });
  }
}

function cleanString(value, field, maxLength, { required = false } = {}) {
  if (value == null) value = "";
  if (typeof value !== "string") throw Object.assign(new Error(`${field} must be a string.`), { status: 400, code: "INVALID_FIELD", field });
  const normalized = value.trim();
  if (required && !normalized) throw Object.assign(new Error(`${field} is required.`), { status: 400, code: "REQUIRED_FIELD", field });
  if (normalized.length > maxLength) throw Object.assign(new Error(`${field} exceeds ${maxLength} characters.`), { status: 400, code: "FIELD_TOO_LONG", field });
  return normalized;
}

function validateUrl(value, field, { allowEmpty = true, allowAppetizeEmbed = false } = {}) {
  const input = cleanString(value, field, 2048);
  if (!input) {
    if (allowEmpty) return "";
    throw Object.assign(new Error(`${field} is required.`), { status: 400, code: "REQUIRED_FIELD", field });
  }
  if (/^data:/i.test(input)) {
    throw Object.assign(new Error(`${field} must be an external HTTP(S) URL.`), { status: 400, code: "DATA_URL_UNSUPPORTED", field });
  }
  let parsed;
  try { parsed = new URL(input); } catch {
    throw Object.assign(new Error(`${field} must be a valid HTTP(S) URL.`), { status: 400, code: "INVALID_URL", field });
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw Object.assign(new Error(`${field} must be a valid HTTP(S) URL.`), { status: 400, code: "INVALID_URL", field });
  }
  if (allowAppetizeEmbed && parsed.hostname.toLowerCase() === "appetize.io") {
    if (parsed.protocol !== "https:" || !/^\/embed\/[A-Za-z0-9_-]+\/?$/.test(parsed.pathname)) {
      throw Object.assign(new Error(`${field}: Appetize URLs must use https://appetize.io/embed/<app-id>.`), { status: 400, code: "INVALID_APPETIZE_URL", field });
    }
  }
  return input;
}

function parseTechnologies(value) {
  if (value == null || value === "") return [];
  let items = value;
  if (typeof value === "string") {
    try { items = JSON.parse(value); } catch { items = value.split(","); }
  }
  if (!Array.isArray(items) || items.length > 50) {
    throw Object.assign(new Error("technologies must be an array or JSON array of at most 50 strings."), { status: 400, code: "INVALID_FIELD", field: "technologies" });
  }
  return items.map((item) => {
    if (typeof item !== "string" || item.trim().length > 80) throw Object.assign(new Error("Each technology must be a string of at most 80 characters."), { status: 400, code: "INVALID_FIELD", field: "technologies" });
    return item.trim();
  }).filter(Boolean);
}

function parseDate(value) {
  const date = cleanString(value, "date", 64);
  if (date && !Number.isFinite(Date.parse(date))) throw Object.assign(new Error("date must be a valid date string."), { status: 400, code: "INVALID_DATE", field: "date" });
  return date;
}

function validateCloudinaryReference(publicIdValue, resourceTypeValue, urlValue, field, expectedResourceType, env) {
  const publicId = cleanString(publicIdValue, `${field}PublicId`, 512);
  const resourceType = cleanString(resourceTypeValue, `${field}ResourceType`, 16);
  const url = urlValue;
  if (!publicId) {
    if (resourceType) throw Object.assign(new Error(`${field}ResourceType requires a Cloudinary public ID.`), { status: 400, code: "INVALID_MEDIA_REFERENCE", field });
    return "";
  }
  if (!publicId.startsWith(CLOUDINARY_PUBLIC_ID_PREFIX) || !/^[A-Za-z0-9_\-/]+$/.test(publicId) || resourceType !== expectedResourceType) {
    throw Object.assign(new Error(`${field} must be a valid ${expectedResourceType} asset from this application.`), { status: 400, code: "INVALID_MEDIA_REFERENCE", field });
  }
  let parsed;
  try { parsed = new URL(url); } catch {
    throw Object.assign(new Error(`${field} must use the configured Cloudinary delivery URL.`), { status: 400, code: "INVALID_MEDIA_REFERENCE", field });
  }
  const uploadPath = `/${env.CLOUDINARY_CLOUD_NAME}/${expectedResourceType}/upload/`;
  const deliveredPath = parsed.pathname.startsWith(uploadPath)
    ? parsed.pathname.slice(uploadPath.length).replace(/^v\d+\//, "")
    : "";
  const matchesPublicId = deliveredPath === publicId || deliveredPath.startsWith(`${publicId}.`);
  if (parsed.protocol !== "https:" || parsed.hostname !== "res.cloudinary.com" || !matchesPublicId) {
    throw Object.assign(new Error(`${field} must use the configured Cloudinary delivery URL.`), { status: 400, code: "INVALID_MEDIA_REFERENCE", field });
  }
  return publicId;
}

function toRecord(row) {
  let technologies = [];
  try { technologies = JSON.parse(row.technologies || "[]"); } catch { /* return an empty list for malformed legacy data */ }
  const imageUrl = row.image_url || "";
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    description: row.description,
    category: row.category,
    imageUrl,
    contentUrl: row.content_url,
    technologies,
    topic: row.topic,
    views: row.views == null ? "0" : String(row.views),
    duration: row.duration,
    date: row.date,
    image: imageUrl,
    thumbnail: row.thumbnail || imageUrl,
    videoUrl: row.video_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function handleLogin(request, env) {
  if (request.method !== "POST") return json({ error: "Method not allowed.", code: "METHOD_NOT_ALLOWED" }, 405, { Allow: "POST, OPTIONS" });
  if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) return json({ error: "Authentication is not configured on this Worker.", code: "AUTH_NOT_CONFIGURED" }, 500);
  if (String(env.SESSION_SECRET).length < 32) return json({ error: "SESSION_SECRET must contain at least 32 characters.", code: "AUTH_NOT_CONFIGURED" }, 500);
  const body = await readJson(request);
  if (typeof body.password !== "string") return json({ error: "password is required.", code: "REQUIRED_FIELD", field: "password" }, 400);
  const expected = new TextEncoder().encode(String(env.ADMIN_PASSWORD));
  const supplied = new TextEncoder().encode(body.password);
  let difference = expected.length ^ supplied.length;
  for (let i = 0; i < Math.max(expected.length, supplied.length); i++) difference |= (expected[i] || 0) ^ (supplied[i] || 0);
  if (difference !== 0) return json({ error: "Invalid password.", code: "INVALID_CREDENTIALS" }, 401);
  return json(await signToken(env));
}

function cloudinaryConfigured(env) {
  return Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);
}

async function cloudinarySignature(params, secret) {
  const canonical = Object.entries(params)
    .filter(([, value]) => value !== "" && value != null)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join("&");
  const bytes = new TextEncoder().encode(`${canonical}${secret}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function handleMediaSign(request, env) {
  if (request.method !== "POST") return json({ error: "Method not allowed.", code: "METHOD_NOT_ALLOWED" }, 405, { Allow: "POST, OPTIONS" });
  if (!(await verifyToken(request, env))) return json({ error: "A valid admin Bearer token is required.", code: "UNAUTHORIZED" }, 401);
  if (!cloudinaryConfigured(env)) return json({ error: "Cloudinary upload is not configured on this Worker.", code: "CLOUDINARY_NOT_CONFIGURED" }, 500);
  const body = await readJson(request);
  const resourceType = cleanString(body.resourceType, "resourceType", 16, { required: true });
  if (!["image", "video"].includes(resourceType)) return json({ error: "resourceType must be image or video.", code: "INVALID_RESOURCE_TYPE" }, 400);
  const allowedFormats = resourceType === "image" ? "png,jpg,jpeg,webp,gif" : "mp4,mov,m4v,webm";
  const params = {
    allowed_formats: allowedFormats,
    overwrite: "false",
    public_id: `${CLOUDINARY_PUBLIC_ID_PREFIX}${crypto.randomUUID()}`,
    timestamp: String(Math.floor(Date.now() / 1000)),
  };
  const signature = await cloudinarySignature(params, env.CLOUDINARY_API_SECRET);
  const cloudName = String(env.CLOUDINARY_CLOUD_NAME);
  return json({
    cloudName,
    apiKey: String(env.CLOUDINARY_API_KEY),
    resourceType,
    publicId: params.public_id,
    uploadUrl: `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/${resourceType}/upload`,
    params,
    signature,
  });
}

async function destroyCloudinaryAsset(env, publicId, resourceType) {
  if (!publicId || !cloudinaryConfigured(env)) return false;
  if (!publicId.startsWith(CLOUDINARY_PUBLIC_ID_PREFIX) || !["image", "video"].includes(resourceType)) return false;
  const params = { public_id: publicId, timestamp: String(Math.floor(Date.now() / 1000)) };
  const signature = await cloudinarySignature(params, env.CLOUDINARY_API_SECRET);
  const body = new URLSearchParams({ ...params, api_key: String(env.CLOUDINARY_API_KEY), signature });
  const response = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(env.CLOUDINARY_CLOUD_NAME)}/${resourceType}/destroy`, { method: "POST", body });
  const result = await response.json().catch(() => ({}));
  return response.ok && ["ok", "not found"].includes(result.result);
}

async function handleContent(request, env, url) {
  if (request.method === "GET") {
    const kind = url.searchParams.get("kind");
    if (kind && !ALLOWED_KINDS.has(kind)) return json({ error: "kind must be project, system-video, or content-video.", code: "INVALID_KIND" }, 400);
    const result = kind
      ? await env.DB.prepare("SELECT * FROM content WHERE kind = ? ORDER BY created_at DESC").bind(kind).all()
      : await env.DB.prepare("SELECT * FROM content ORDER BY created_at DESC").all();
    return json({ items: (result.results || []).map(toRecord) });
  }

  if (request.method === "POST") {
    if (!(await verifyToken(request, env))) return json({ error: "A valid admin Bearer token is required.", code: "UNAUTHORIZED" }, 401);
    const body = await readJson(request);
    if (body.imageData) return json({ error: "Upload media to Cloudinary first; D1 stores only the resulting URL and metadata.", code: "CLOUDINARY_UPLOAD_REQUIRED" }, 400);
    const kind = cleanString(body.kind, "kind", 32, { required: true });
    if (!ALLOWED_KINDS.has(kind)) return json({ error: "kind must be project, system-video, or content-video.", code: "INVALID_KIND", field: "kind" }, 400);
    const title = cleanString(body.title, "title", 200, { required: true });
    const description = cleanString(body.description, "description", 10000);
    const category = cleanString(body.category, "category", 120);
    const topic = cleanString(body.topic, "topic", 160);
    const duration = cleanString(body.duration == null ? "" : String(body.duration), "duration", 80);
    const views = cleanString(body.views == null || body.views === "" ? "0" : String(body.views), "views", 80);
    const technologies = parseTechnologies(body.technologies);
    const date = parseDate(body.date);
    const imageUrl = validateUrl(body.imageUrl == null ? body.image : body.imageUrl, "imageUrl");
    const imagePublicId = validateCloudinaryReference(body.imagePublicId, body.imageResourceType, imageUrl, "image", "image", env);
    const rawContentUrl = body.contentUrl == null ? body.videoUrl : body.contentUrl;
    const contentUrl = validateUrl(rawContentUrl, "contentUrl", { allowAppetizeEmbed: true });
    const videoUrl = validateUrl(body.videoUrl == null ? contentUrl : body.videoUrl, "videoUrl", { allowAppetizeEmbed: true });
    const videoPublicId = validateCloudinaryReference(body.videoPublicId, body.videoResourceType, videoUrl, "video", "video", env);
    const thumbnail = validateUrl(body.thumbnail == null || body.thumbnail === "" ? imageUrl : body.thumbnail, "thumbnail");
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO content
      (id, kind, title, description, category, image_url, image_public_id, content_url, technologies, topic, views, duration, date, thumbnail, video_url, video_public_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, kind, title, description, category, imageUrl, imagePublicId, contentUrl, JSON.stringify(technologies), topic, views, duration, date, thumbnail, videoUrl, videoPublicId, now, now)
      .run();
    const record = toRecord({ id, kind, title, description, category, image_url: imageUrl, content_url: contentUrl, technologies: JSON.stringify(technologies), topic, views, duration, date, thumbnail, video_url: videoUrl, created_at: now, updated_at: now });
    return json({ item: record }, 201);
  }

  if (request.method === "DELETE") {
    if (!(await verifyToken(request, env))) return json({ error: "A valid admin Bearer token is required.", code: "UNAUTHORIZED" }, 401);
    const body = await readJson(request);
    if ((typeof body.id !== "string" && typeof body.id !== "number") || !String(body.id).trim()) return json({ error: "id is required.", code: "REQUIRED_FIELD", field: "id" }, 400);
    const id = String(body.id).trim();
    const existing = await env.DB.prepare("SELECT image_public_id, video_public_id FROM content WHERE id = ?").bind(id).first();
    if (!existing) return json({ error: "Content not found.", code: "NOT_FOUND" }, 404);
    const cleanup = await Promise.allSettled([
      existing.image_public_id ? destroyCloudinaryAsset(env, existing.image_public_id, "image") : Promise.resolve(true),
      existing.video_public_id ? destroyCloudinaryAsset(env, existing.video_public_id, "video") : Promise.resolve(true),
    ]);
    const mediaDeleted = cleanup.map((entry) => entry.status === "fulfilled" && entry.value);
    if (mediaDeleted.some((deleted) => !deleted)) {
      if (cleanup.some((entry) => entry.status === "rejected")) console.error("Cloudinary cleanup failed for content", id);
      return json({ error: "Cloudinary media could not be deleted. The content record was kept so you can retry.", code: "CLOUDINARY_DELETE_FAILED", mediaDeleted: false }, 502);
    }
    const result = await env.DB.prepare("DELETE FROM content WHERE id = ?").bind(id).run();
    if (!result.meta?.changes) return json({ error: "Content not found.", code: "NOT_FOUND" }, 404);
    return json({ deleted: true, id, mediaDeleted: true });
  }

  return json({ error: "Method not allowed.", code: "METHOD_NOT_ALLOWED" }, 405, { Allow: "GET, POST, DELETE, OPTIONS" });
}

export default {
  async fetch(request, env) {
    const { headers: cors, originAllowed } = corsHeaders(request, env);
    if (request.method === "OPTIONS") {
      if (!originAllowed) return json({ error: "Origin is not allowed.", code: "CORS_ORIGIN_DENIED" }, 403, cors);
      return new Response(null, { status: 204, headers: cors });
    }
    let response;
    try {
      if (!originAllowed) response = json({ error: "Origin is not allowed.", code: "CORS_ORIGIN_DENIED" }, 403);
      else {
        const url = new URL(request.url);
        if (url.pathname === "/api/login") response = await handleLogin(request, env);
        else if (url.pathname === "/api/media/sign") response = await handleMediaSign(request, env);
        else if (url.pathname === "/api/content") response = await handleContent(request, env, url);
        else response = json({ error: "Not found.", code: "NOT_FOUND" }, 404);
      }
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      if (status >= 500) console.error("API request failed:", error);
      response = json({ error: status >= 500 ? "Internal server error." : error.message, code: error.code || "INTERNAL_ERROR", ...(error.field ? { field: error.field } : {}) }, status);
    }
    return withHeaders(response, cors);
  },
};
