// @underhood/backend scaffold entrypoint.
// Mastra workflow, pg-boss queue, and async API arrive in G2/G5.
const port = Number(process.env.PORT ?? 3000);

const server = Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") {
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }
    return Response.json({
      service: "@underhood/backend",
      version: "0.1.0",
      status: "scaffold",
    });
  },
});

console.log(`@underhood/backend listening on :${server.port}`);
