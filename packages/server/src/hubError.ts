/** A request the hub refuses, with the HTTP status that says why. */
export class HubError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}
