const CACHE_VERSION = "agentdeck-shell-v25-recovery-files"
const SHELL_CACHE = CACHE_VERSION
const APP_SHELL_URLS = [
  "/",
  "/manifest.webmanifest",
  "/static/index.html",
  "/static/styles.css",
  "/static/app/main.js",
  "/static/icons/logo.svg",
]

const DEFAULT_NOTIFICATION_ICON = "/static/icons/agent-deck-192.png"

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(APP_SHELL_URLS)),
  )
  self.skipWaiting()
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== SHELL_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener("fetch", (event) => {
  const req = event.request
  if (req.method !== "GET") {
    return
  }

  const url = new URL(req.url)
  if (url.origin !== self.location.origin) {
    return
  }

  if (url.pathname === "/sw.js") {
    event.respondWith(fetch(req))
    return
  }

  if (req.mode === "navigate") {
    event.respondWith(handleNavigate(req))
    return
  }

  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/desktop/") ||
    url.pathname.startsWith("/events/") ||
    url.pathname.startsWith("/ws/")
  ) {
    event.respondWith(handleRuntimeRequest(req, url.pathname))
    return
  }

  if (
    url.pathname.startsWith("/static/app/") ||
    ["/desktop-ui.js", "/desktop-contextmenus.js", "/desktop-ui.css"].includes(url.pathname)
  ) {
    event.respondWith(handleDesktopAsset(req))
    return
  }

  event.respondWith(handleShellAsset(req))
})

self.addEventListener("push", (event) => {
  let payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch (_err) {
    payload = {
      title: "Q-agent",
      body: event.data ? event.data.text() : "Session update received.",
    }
  }

  const title = payload.title || "Q-agent"
  const options = {
    body: payload.body || "Session update received.",
    icon: payload.icon || DEFAULT_NOTIFICATION_ICON,
    badge: payload.badge || DEFAULT_NOTIFICATION_ICON,
    tag: payload.tag || `agentdeck-${payload.sessionId || "session"}`,
    renotify: !!payload.renotify,
    requireInteraction: !!payload.requireInteraction,
    data: {
      path: payload.path || "/",
      sessionId: payload.sessionId || "",
      profile: payload.profile || "",
      status: payload.status || "",
    },
  }

  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const data = event.notification.data || {}
  const relativePath = typeof data.path === "string" && data.path ? data.path : "/"
  const targetURL = new URL(relativePath, self.location.origin).toString()

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((allClients) => {
      for (const client of allClients) {
        const clientURL = new URL(client.url)
        if (clientURL.origin !== self.location.origin) {
          continue
        }
        if ("focus" in client) {
          if ("navigate" in client) {
            client.navigate(targetURL)
          }
          return client.focus()
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetURL)
      }
      return undefined
    }),
  )
})

async function handleNavigate(req) {
  try {
    return await fetch(req)
  } catch (_err) {
    const cache = await caches.open(SHELL_CACHE)
    const cached = (await cache.match("/")) || (await cache.match("/static/index.html"))
    if (cached) {
      return cached
    }
    return new Response(
      "<!doctype html><title>Q-agent Offline</title><p>Q-agent server unavailable.</p>",
      {
        status: 503,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      },
    )
  }
}

async function handleRuntimeRequest(req, pathname) {
  try {
    return await fetch(req, pathname.startsWith("/desktop/") ? { cache: "no-store" } : undefined)
  } catch (_err) {
    if (pathname.startsWith("/events/")) {
      // EventSource retries network failures, but a synthetic HTTP error
      // permanently closes the stream and strands its application singleton.
      throw _err
    }

    if (pathname.startsWith("/api/") || pathname.startsWith("/desktop/")) {
      return new Response(
        JSON.stringify({
          error: {
            code: "SERVER_UNAVAILABLE",
            message: "Q-agent server unavailable",
          },
        }),
        {
          status: 503,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        },
      )
    }

    return new Response("Q-agent server unavailable", { status: 503 })
  }
}

// Local overrides and unbundled modules must update for existing desktop windows.
// Keep only their last successful response for offline fallback, never chat data.
async function handleDesktopAsset(req) {
  const cache = await caches.open(SHELL_CACHE)
  try {
    const fresh = await fetch(req, { cache: "no-cache" })
    if (fresh && fresh.ok) await cache.put(req, fresh.clone())
    return fresh
  } catch (_err) {
    const cached = await cache.match(req)
    if (cached) return cached
    return new Response("Asset unavailable while offline", { status: 503 })
  }
}

async function handleShellAsset(req) {
  const cache = await caches.open(SHELL_CACHE)
  const cached = await cache.match(req)
  if (cached) {
    return cached
  }

  try {
    const fresh = await fetch(req)
    if (fresh && fresh.ok) {
      cache.put(req, fresh.clone())
    }
    return fresh
  } catch (_err) {
    const fallback = await cache.match("/")
    if (fallback) {
      return fallback
    }
    return new Response("offline", { status: 503 })
  }
}
