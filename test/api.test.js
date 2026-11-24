import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import worker from "../src/index.js";

class FakeDB {
  constructor() {
    this.calls = [];
    this.content = new Map();
  }

  prepare(sql) {
    const call = { sql, values: [] };
    this.calls.push(call);
    const statement = {
      bind: (...values) => { call.values = values; return statement; },
      all: async () => {
        if (!sql.includes("FROM content")) return { results: [] };
        let records = [...this.content.values()];
        if (sql.includes("WHERE kind = ?")) records = records.filter((row) => row.kind === call.values[0]);
        records.sort((a, b) => b.created_at.localeCompare(a.created_at));
        return { results: records };
      },
      first: async () => {
        if (!sql.includes("FROM content")) return null;
        const row = this.content.get(call.values[0]);
        return row ? { image_public_id: row.image_public_id, video_public_id: row.video_public_id } : null;
      },
      run: async () => {
        if (sql.includes("INSERT INTO content")) {
          const [id, kind, title, description, category, image_url, image_public_id, content_url, technologies, topic, views, duration, date, thumbnail, video_url, video_public_id, created_at, updated_at] = call.values;
          this.content.set(id, { id, kind, title, description, category, image_url, image_public_id, content_url, technologies, topic, views, duration, date, thumbnail, video_url, video_public_id, created_at, updated_at });
          return { meta: { changes: 1 } };
        }
        if (sql.includes("DELETE FROM content")) return { meta: { changes: Number(this.content.delete(call.values[0])) } };
        return { meta: { changes: 1 } };
      },
    };
    return statement;
  }
}

function makeEnv() {
  return {
    DB: new FakeDB(),
    ADMIN_PASSWORD: "test-admin-password",
    SESSION_SECRET: "test-secret-with-at-least-32-characters",
    ALLOWED_ORIGINS: "https://zazobrain.pages.dev",
    CLOUDINARY_CLOUD_NAME: "demo-cloud",
    CLOUDINARY_API_KEY: "123456789012345",
    CLOUDINARY_API_SECRET: "test-cloudinary-secret",
  };
}

async function request(env, method, path, { body, token, origin } = {}) {
  const headers = new Headers();
  if (body !== undefined) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (origin) headers.set("Origin", origin);
  return worker.fetch(new Request(`https://api.example${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
}

async function login(env) {
  const response = await request(env, "POST", "/api/login", { body: { password: env.ADMIN_PASSWORD } });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.ok(data.token);
  assert.ok(Number.isFinite(Date.parse(data.expiresAt)));
  return data.token;
}

const imageUrl = "https://res.cloudinary.com/demo-cloud/image/upload/v1/zazobrain/photo.webp";
const videoUrl = "https://res.cloudinary.com/demo-cloud/video/upload/v1/zazobrain/demo.mp4";

test("login returns a signed session token; bad password is rejected", async () => {
  const env = makeEnv();
  const token = await login(env);
  assert.equal(token.split(".").length, 3);
  const bad = await request(env, "POST", "/api/login", { body: { password: "wrong" } });
  assert.equal(bad.status, 401);
});

test("content mutation and Cloudinary signing require a valid Bearer token", async () => {
  const env = makeEnv();
  const post = await request(env, "POST", "/api/content", { body: { kind: "project", title: "Test" } });
  const sign = await request(env, "POST", "/api/media/sign", { body: { resourceType: "image" } });
  const del = await request(env, "DELETE", "/api/content", { body: { id: "1" } });
  assert.equal(post.status, 401);
  assert.equal(sign.status, 401);
  assert.equal(del.status, 401);
  assert.equal(env.DB.calls.length, 0);
});

test("Cloudinary signing returns a scoped one-time asset path without revealing the API secret", async () => {
  const env = makeEnv();
  const token = await login(env);
  const response = await request(env, "POST", "/api/media/sign", { token, body: { resourceType: "image" } });
  assert.equal(response.status, 200);
  const credentials = await response.json();
  assert.equal(credentials.cloudName, env.CLOUDINARY_CLOUD_NAME);
  assert.equal(credentials.apiKey, env.CLOUDINARY_API_KEY);
  assert.equal(credentials.resourceType, "image");
  assert.equal(credentials.uploadUrl, "https://api.cloudinary.com/v1_1/demo-cloud/image/upload");
  assert.match(credentials.publicId, /^zazobrain\/[0-9a-f-]{36}$/i);
  assert.equal(credentials.params.public_id, credentials.publicId);
  assert.equal(credentials.params.overwrite, "false");
  assert.equal(credentials.params.allowed_formats, "png,jpg,jpeg,webp,gif");
  const canonical = Object.entries(credentials.params).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("&");
  assert.equal(credentials.signature, createHash("sha1").update(`${canonical}${env.CLOUDINARY_API_SECRET}`).digest("hex"));
  assert.equal(JSON.stringify(credentials).includes(env.CLOUDINARY_API_SECRET), false);
});

test("unsupported signing resource types are rejected", async () => {
  const env = makeEnv();
  const token = await login(env);
  const response = await request(env, "POST", "/api/media/sign", { token, body: { resourceType: "raw" } });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "INVALID_RESOURCE_TYPE");
});

test("authenticated create keeps external URLs and text views using bound SQL", async () => {
  const env = makeEnv();
  const token = await login(env);
  const response = await request(env, "POST", "/api/content", {
    token,
    body: {
      kind: "project", title: "A project", imageUrl: "https://cdn.example/image.webp", views: "1.2K",
      technologies: ["JS", "Cloudflare"], contentUrl: "https://appetize.io/embed/app-key",
    },
  });
  assert.equal(response.status, 201);
  const data = await response.json();
  assert.ok(data.item);
  assert.equal(data.item.imageUrl, "https://cdn.example/image.webp");
  assert.equal(data.item.views, "1.2K");
  assert.deepEqual(data.item.technologies, ["JS", "Cloudflare"]);
  const insert = env.DB.calls.find((call) => call.sql.includes("INSERT INTO content"));
  assert.ok(insert);
  assert.equal(insert.values[2], "A project");
  assert.equal(insert.values[10], "1.2K");
  assert.ok(insert.sql.includes("VALUES (?, ?"));
  assert.equal(insert.values[6], "");

  const list = await request(env, "GET", "/api/content");
  const listData = await list.json();
  assert.deepEqual(Object.keys(listData), ["items"]);
  assert.equal(listData.items[0].views, "1.2K");
});

test("Cloudinary image and video URLs plus public IDs are stored as D1 metadata", async () => {
  const env = makeEnv();
  const token = await login(env);
  const response = await request(env, "POST", "/api/content", {
    token,
    body: {
      kind: "content-video", title: "Uploaded video", imageUrl, imagePublicId: "zazobrain/photo", imageResourceType: "image",
      contentUrl: videoUrl, videoUrl, videoPublicId: "zazobrain/demo", videoResourceType: "video", views: "1.2K",
    },
  });
  assert.equal(response.status, 201);
  const { item } = await response.json();
  assert.equal(item.imageUrl, imageUrl);
  assert.equal(item.thumbnail, imageUrl);
  assert.equal(item.contentUrl, videoUrl);
  assert.equal(item.videoUrl, videoUrl);
  const row = env.DB.content.get(item.id);
  assert.equal(row.image_public_id, "zazobrain/photo");
  assert.equal(row.video_public_id, "zazobrain/demo");
  const list = await request(env, "GET", "/api/content?kind=content-video");
  assert.equal((await list.json()).items[0].contentUrl, videoUrl);
});

test("inline BLOB media and foreign Cloudinary references are rejected", async () => {
  const env = makeEnv();
  const token = await login(env);
  const inline = await request(env, "POST", "/api/content", { token, body: { kind: "project", title: "No BLOB", imageData: "data:image/png;base64,AA==" } });
  assert.equal(inline.status, 400);
  assert.equal((await inline.json()).code, "CLOUDINARY_UPLOAD_REQUIRED");
  const foreign = await request(env, "POST", "/api/content", {
    token,
    body: { kind: "project", title: "Foreign asset", imageUrl: "https://cdn.example/image.webp", imagePublicId: "other-account/photo", imageResourceType: "image" },
  });
  assert.equal(foreign.status, 400);
  assert.equal((await foreign.json()).code, "INVALID_MEDIA_REFERENCE");
  const mismatched = await request(env, "POST", "/api/content", {
    token,
    body: { kind: "project", title: "Mismatched asset", imageUrl: "https://res.cloudinary.com/demo-cloud/image/upload/v123/zazobrain/another-photo.webp", imagePublicId: "zazobrain/photo", imageResourceType: "image" },
  });
  assert.equal(mismatched.status, 400);
  assert.equal((await mismatched.json()).code, "INVALID_MEDIA_REFERENCE");
  const wrongType = await request(env, "POST", "/api/content", {
    token,
    body: { kind: "project", title: "Wrong resource type", imageUrl: "https://res.cloudinary.com/demo-cloud/video/upload/v123/zazobrain/photo.mp4", imagePublicId: "zazobrain/photo", imageResourceType: "image" },
  });
  assert.equal(wrongType.status, 400);
  assert.equal((await wrongType.json()).code, "INVALID_MEDIA_REFERENCE");
  assert.equal(env.DB.content.size, 0);
});

test("deleting content also attempts to delete its Cloudinary assets", async () => {
  const env = makeEnv();
  const token = await login(env);
  const created = await request(env, "POST", "/api/content", {
    token,
    body: { kind: "content-video", title: "Delete me", imageUrl, imagePublicId: "zazobrain/photo", imageResourceType: "image", contentUrl: videoUrl, videoUrl, videoPublicId: "zazobrain/demo", videoResourceType: "video" },
  });
  const { item } = await created.json();
  const originalFetch = globalThis.fetch;
  const destroyed = [];
  globalThis.fetch = async (url, options) => {
    destroyed.push({ url: String(url), body: new URLSearchParams(options.body) });
    return new Response(JSON.stringify({ result: "ok" }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const deleted = await request(env, "DELETE", "/api/content", { token, body: { id: item.id } });
    assert.equal(deleted.status, 200);
    assert.equal((await deleted.json()).mediaDeleted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(env.DB.content.has(item.id), false);
  assert.equal(destroyed.length, 2);
  assert.ok(destroyed.some((entry) => entry.url.endsWith("/image/destroy") && entry.body.get("public_id") === "zazobrain/photo"));
  assert.ok(destroyed.some((entry) => entry.url.endsWith("/video/destroy") && entry.body.get("public_id") === "zazobrain/demo"));
});

test("a Cloudinary cleanup failure keeps the D1 content record for retry", async () => {
  const env = makeEnv();
  const token = await login(env);
  const created = await request(env, "POST", "/api/content", {
    token,
    body: { kind: "project", title: "Keep for retry", imageUrl, imagePublicId: "zazobrain/photo", imageResourceType: "image" },
  });
  const { item } = await created.json();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "temporary failure" } }), {
    status: 503, headers: { "Content-Type": "application/json" },
  });
  try {
    const deleted = await request(env, "DELETE", "/api/content", { token, body: { id: item.id } });
    assert.equal(deleted.status, 502);
    assert.equal((await deleted.json()).code, "CLOUDINARY_DELETE_FAILED");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(env.DB.content.has(item.id), true);
});

test("GET is public and CORS allows only configured/local origins", async () => {
  const env = makeEnv();
  const publicResponse = await request(env, "GET", "/api/content?kind=project");
  assert.equal(publicResponse.status, 200);
  assert.deepEqual(Object.keys(await publicResponse.json()), ["items"]);
  const options = await worker.fetch(new Request("https://api.example/api/content", {
    method: "OPTIONS", headers: { Origin: "https://zazobrain.pages.dev" },
  }), env);
  assert.equal(options.status, 204);
  assert.equal(options.headers.get("Access-Control-Allow-Origin"), "https://zazobrain.pages.dev");
  const denied = await worker.fetch(new Request("https://api.example/api/content", {
    method: "OPTIONS", headers: { Origin: "https://attacker.example" },
  }), env);
  assert.equal(denied.status, 403);
});
