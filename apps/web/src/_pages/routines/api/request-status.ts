/** The HTTP status of a failed read, including one hydrated from the server. */
export function requestStatus(error: unknown) {
  return error &&
    typeof error === "object" &&
    "status" in error &&
    typeof error.status === "number"
    ? error.status
    : undefined;
}
