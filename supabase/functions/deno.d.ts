// Minimal ambient declarations for the Deno globals the Edge Functions use.
//
// Edge Functions run on Deno, but the repository's toolchain is Node and Expo:
// there is no Deno binary here, so nothing supplies `Deno` to TypeScript and
// every use of it reads as an undefined name. Declaring the handful of APIs the
// functions actually call is enough to typecheck them properly, and keeps the
// alternative -- an npm package of Deno types that would have to be kept in step
// with the runtime -- out of an Expo project that has no other use for it.
//
// This is a floor, not a mirror of Deno's API. Add to it when a function starts
// using something new. If the Deno VS Code extension is ever installed, its
// language server supersedes all of this for editing; the declarations stay
// useful for `npm run typecheck:functions`, which does not depend on an editor.

declare namespace Deno {
  export const env: {
    get(key: string): string | undefined;
    set(key: string, value: string): void;
    has(key: string): boolean;
  };

  export function serve(
    handler: (request: Request) => Response | Promise<Response>
  ): { finished: Promise<void>; shutdown(): Promise<void> };
}
