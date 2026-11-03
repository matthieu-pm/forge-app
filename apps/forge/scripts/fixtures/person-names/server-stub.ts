export function createServerFn() {
  const builder = {
    validator: () => builder,
    handler: () => async () => {
      throw new Error("Server access is disabled in this local fixture")
    },
  }
  return builder
}
export const createServerOnlyFn = (callback: unknown) => callback
