const http = require("http");
const https = require("https");
const { createClient } = require("@supabase/supabase-js");

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const FRONTEND_URL = process.env.FRONTEND_URL || "*";
const EXPIRE_MS = 2 * 60 * 1000; // 2 minutes
const BUCKET = "dropbridge";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function safeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._\-]/g, "_").slice(0, 200);
}

function respond(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": FRONTEND_URL,
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...extraHeaders,
  });
  res.end(body);
}

function parseMultipart(body, boundary) {
  const files = [];
  const bnd = Buffer.from("--" + boundary);
  const parts = [];
  let start = 0;
  while (true) {
    const idx = body.indexOf(bnd, start);
    if (idx === -1) break;
    parts.push(body.slice(start, idx));
    start = idx + bnd.length;
  }
  for (const part of parts) {
    if (part.length < 4) continue;
    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd === -1) continue;
    const headerStr = part.slice(2, headerEnd).toString();
    const data = part.slice(headerEnd + 4, part.length - 2);
    const cdMatch = headerStr.match(/Content-Disposition:[^\r\n]*filename="([^"]+)"/i);
    const ctMatch = headerStr.match(/Content-Type:\s*([^\r\n]+)/i);
    if (!cdMatch) continue;
    files.push({
      name: cdMatch[1],
      mime: ctMatch ? ctMatch[1].trim() : "application/octet-stream",
      data,
    });
  }
  return files;
}

// ── Cleanup expired files (runs every 30s) ────────────────────────────────────

async function cleanupExpired() {
  const now = new Date().toISOString();
  const { data: expired } = await supabase
    .from("files")
    .select("id, storage_path")
    .lt("expires_at", now);

  if (!expired || !expired.length) return;

  for (const f of expired) {
    await supabase.storage.from(BUCKET).remove([f.storage_path]);
    await supabase.from("files").delete().eq("id", f.id);
  }
  if (expired.length) console.log(`[cleanup] Deleted ${expired.length} expired file(s)`);
}

setInterval(cleanupExpired, 30000);

// ── Route handlers ────────────────────────────────────────────────────────────

async function handleUpload(req, res, body) {
  const ct = req.headers["content-type"] || "";
  const bndMatch = ct.match(/boundary=(.+)/);
  if (!bndMatch) return respond(res, 400, { error: "No boundary" });

  const parsedFiles = parseMultipart(body, bndMatch[1].trim());
  if (!parsedFiles.length) return respond(res, 400, { error: "No files parsed" });

  const saved = [];

  for (const f of parsedFiles) {
    const id = uid();
    const safeName = safeFilename(f.name);
    const storagePath = `${id}_${safeName}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + EXPIRE_MS);

    // Upload to Supabase Storage
    const { error: uploadErr } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, f.data, { contentType: f.mime, upsert: false });

    if (uploadErr) {
      console.error("Storage upload error:", uploadErr);
      continue;
    }

    // Insert metadata into DB
    const { error: dbErr } = await supabase.from("files").insert({
      id,
      name: safeName,
      size: f.data.length,
      mime: f.mime,
      storage_path: storagePath,
      uploaded_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
    });

    if (dbErr) {
      console.error("DB insert error:", dbErr);
      await supabase.storage.from(BUCKET).remove([storagePath]);
      continue;
    }

    saved.push({ id, name: safeName });
    console.log(`[upload] ${safeName} (${f.data.length} bytes)`);
  }

  respond(res, 200, { ok: true, files: saved });
}

async function handleList(req, res) {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("files")
    .select("id, name, size, mime, uploaded_at, expires_at")
    .gt("expires_at", now)
    .order("uploaded_at", { ascending: false });

  if (error) return respond(res, 500, { error: "DB error" });

  const files = (data || []).map((f) => ({
    ...f,
    msLeft: Math.max(0, new Date(f.expires_at).getTime() - Date.now()),
  }));

  respond(res, 200, { files });
}

async function handleDownload(req, res, id) {
  const { data: row } = await supabase
    .from("files")
    .select("name, mime, storage_path, expires_at")
    .eq("id", id)
    .single();

  if (!row || new Date(row.expires_at) < new Date()) {
    return respond(res, 404, { error: "File not found or expired" });
  }

  // Get a signed URL (1 minute validity)
  const { data: signed, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(row.storage_path, 60, {
      download: row.name,
    });

  if (error || !signed) return respond(res, 500, { error: "Could not generate download URL" });

  res.writeHead(302, {
    Location: signed.signedUrl,
    "Access-Control-Allow-Origin": FRONTEND_URL,
  });
  res.end();
}

async function handleDelete(req, res, id) {
  const { data: row } = await supabase
    .from("files")
    .select("storage_path")
    .eq("id", id)
    .single();

  if (!row) return respond(res, 404, { error: "Not found" });

  await supabase.storage.from(BUCKET).remove([row.storage_path]);
  await supabase.from("files").delete().eq("id", id);

  respond(res, 200, { ok: true });
}

// ── Main server ───────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": FRONTEND_URL,
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  if (pathname === "/health" && req.method === "GET") {
    res.writeHead(200); return res.end("ok");
  }

  if (pathname === "/list" && req.method === "GET") return handleList(req, res);

  if (pathname === "/upload" && req.method === "POST") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => handleUpload(req, res, Buffer.concat(chunks)));
    return;
  }

  if (pathname.startsWith("/download/") && req.method === "GET") {
    const id = pathname.split("/")[2];
    return handleDownload(req, res, id);
  }

  if (pathname.startsWith("/delete/") && req.method === "DELETE") {
    const id = pathname.split("/")[2];
    return handleDelete(req, res, id);
  }

  respond(res, 404, { error: "Not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 DropBridge backend running on port ${PORT}`);
});
    
