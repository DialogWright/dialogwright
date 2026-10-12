import { createServer, request, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';

/**
 * A load balancer in the process, for the tests of many servers: each webhook and each socket goes to
 * the port `pick` names when it arrives (the servers that are up and not draining, as a balancer reading
 * `/ready` would choose), a socket piped through whole, so a server that dies closes its sockets on the
 * carrier's side too. No stickiness: carrier webhooks are stateless. `pick` answering undefined is a
 * 502, as a balancer with no server up answers.
 */
export interface InProcessBalancer {
  readonly base: string;
  readonly ws: string;
  close(): Promise<void>;
}

export async function startBalancer(pick: () => number | undefined): Promise<InProcessBalancer> {
  const pipes = new Set<Socket>();
  const lb: Server = createServer((req, res) => {
    const port = pick();
    if (port === undefined) {
      res.writeHead(502).end();
      return;
    }
    const up = request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  });
  lb.on('upgrade', (req, client: Socket, head: Buffer) => {
    const port = pick();
    if (port === undefined) {
      client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      return;
    }
    const backend = connect(port, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      backend.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) backend.write(head);
      backend.pipe(client);
      client.pipe(backend);
    });
    pipes.add(backend).add(client);
    const close = (): void => {
      backend.destroy();
      client.destroy();
      pipes.delete(backend);
      pipes.delete(client);
    };
    backend.on('error', close).on('close', close);
    client.on('error', close).on('close', close);
  });
  await new Promise<void>((resolve) => lb.listen(0, '127.0.0.1', resolve));
  const port = (lb.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${port}`,
    ws: `ws://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => {
      for (const p of pipes) p.destroy();
      lb.closeAllConnections();
      lb.close(() => resolve());
    }),
  };
}
