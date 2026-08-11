declare module 'node:http' {
  export type IncomingMessage = {
    url?: string;
  };

  export type ServerResponse = {
    writeHead(statusCode: number, headers?: Record<string, string>): ServerResponse;
    end(body?: string): ServerResponse;
  };

  export type Server = {
    listen(port: number, hostname: string, callback: () => void): Server;
    close(callback: (error?: Error) => void): Server;
    address(): unknown;
  };

  export function createServer(
    listener: (request: IncomingMessage, response: ServerResponse) => void
  ): Server;
}

declare module 'node:net' {
  export type AddressInfo = {
    port: number;
  };
}
