import { serve } from "https://deno.land/std@0.181.0/http/server.ts";

const OPENAI_API_HOST = "api.openai.com";

const clients = new Map();

const decoder = new TextDecoder();

serve(async (request: Request) => {
  const url = new URL(request.url);
  const upgrade = request.headers.get("upgrade") || "";
  if (upgrade.toLowerCase() != "websocket") {
    if (url.pathname === "/") {
      return fetch(new URL("./Readme.md", import.meta.url));
    }

    url.host = OPENAI_API_HOST;
    return await fetch(url, request);
  }

  const { socket, response } = Deno.upgradeWebSocket(request);
  const cid = url.pathname.split("/")[1];
  socket.onopen = () => console.log("socket opened");
  if (cid && !clients.get(cid)) {
    clients.set(cid, socket);
  }
  socket.onmessage = async (e) => {
    const { type, action, key, ...options } = e.data;
    console.log("socket message:", e.data);
    // 采用 socket 方式返回分流信息
    const client = clients.get(cid) || socket;
    if (!client) return;
    if (type === "chat") {
      const rawRes = await fetch(`${OPENAI_API_HOST}${action}`, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        method: "POST",
        body: JSON.stringify({
          // max_tokens: 4096 - tokens,
          stream: true,
          ...options,
        }),
      })
        .catch((err) => {
          return client.send({
            type: "fail",
            status: 500,
            message: err.message,
          });
        });

      if (!rawRes.ok) {
        return client.send({
          type: "fail",
          status: rawRes.status,
          message: rawRes.statusText,
        });
      }

      for await (const chunk of rawRes.body as any) {
        const data = decoder.decode(chunk);
        if (data.includes("[DONE]")) return;
        try {
          const json = JSON.parse(data);
          const text = json.choices[0].delta?.content;
          client.send({ type: "ok", status: 200, content: text });
        } catch (e) {
          client.send({
            type: "fail",
            status: 200,
            content: e.message.toString(),
          });
        }
      }
    } else {
      socket.send(new Date().toString());
    }
  };
  socket.onerror = (e) => console.log("socket errored:", e);
  socket.onclose = () => {
    console.log("socket closed");
    if (cid && clients.get(cid)) {
      clients.delete(cid);
    }
  };
  return response;
});
