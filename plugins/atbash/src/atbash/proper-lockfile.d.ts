declare module "proper-lockfile" {
  export function lock(
    path: string,
    options: {
      stale: number;
      update: number;
      retries: number;
      realpath: boolean;
      onCompromised: (error: Error) => void;
    },
  ): Promise<() => Promise<void>>;
}
